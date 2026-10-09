import { resolveGitOpsEdit, deriveBasePrefix, tagOf, isHelmReleaseFile, type RepoFile, type ChangeSpec, type ResolveResult } from "./resolve.js";
import { GitHubClient, type RawCommit } from "./github-client.js";
import type { GitOpsRequest, GitOpsHistoryRequest, GitOpsRevertRequest, GitOpsPayload, GitOpsCommit } from "./message.js";
import logger from "../logger.js";

// GitOps op orchestration (dry_run → diff, open_pr → PR). The GitHub side is behind a
// GitOpsBackend interface so this logic is unit-testable without network.

export interface GitOpsBackend {
  listCandidateFiles(pathPrefix?: string): Promise<RepoFile[]>; // narrowed repo YAML files with content
  // Same files, read for `history` only and shared across a burst — see githubBackend. Never for
  // dry_run/open_pr: those write a file from the content they read.
  listHistoryFiles?(pathPrefix?: string): Promise<RepoFile[]>;
  listCommits(path: string, since: string): Promise<GitOpsCommit[]>;
  commitInfo(sha: string): Promise<{ parent: string; files: string[]; message: string; date: string }>;
  fileAt(path: string, ref?: string): Promise<string | null>; // ref omitted = the configured branch; null = absent there
  fileSha(path: string): Promise<string>;
  createBranch(branch: string): Promise<void>;
  putFile(path: string, content: string, sha: string, branch: string, message: string): Promise<void>;
  openPr(title: string, branch: string, body: string): Promise<string>; // → PR html_url
}

type ResolvedEdit = Extract<ResolveResult, { ok: true }>;

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

// A short, scannable PR title derived from the structured change (not the agent's verbose
// card summary).
export function prTitle(req: GitOpsRequest): string {
  const wl = req.helmRelease.name;
  const c = req.changes[0];
  if (req.action === "set_image" && c) return `Remediation: bump \`${wl}\` image to ${tagOf(String(c.to)) ?? c.to}`;
  if (req.action === "scale" && c) return `Remediation: scale \`${wl}\` to ${c.to} replicas`;
  if (req.action === "set_resources") return `Remediation: update \`${wl}\` resources`;
  return `Remediation: \`${wl}\``;
}

// A clean, structured PR body: what/where, a change table, a collapsible diff, and provenance.
export function prBody(req: GitOpsRequest, resolved: ResolvedEdit): string {
  const rows = req.changes.map((c) => `| \`${c.field}\` | \`${c.from}\` | \`${c.to}\` |`).join("\n");
  const container = req.container ? ` · **Container:** \`${req.container}\`` : "";
  const thread = req.incident?.threadUrl ? `\n\n**Incident thread:** ${req.incident.threadUrl}` : "";
  const addedNote = resolved.addedFromBase
    ? "\n> ℹ️ This value wasn't overridden in the overlay yet — it was only in **base**. Added it to the overlay to override base **for this environment only**."
    : "";
  return [
    `### 🔧 Automated remediation — \`${req.helmRelease.name}\``,
    "",
    `**Workload:** Flux HelmRelease \`${req.helmRelease.namespace}/${req.helmRelease.name}\`${container}`,
    `**File:** \`${resolved.path}\` · **values key:** \`${resolved.valuesKey}\`${addedNote}`,
    "",
    "| Field | From | To |",
    "|-------|------|----|",
    rows,
    "",
    "<details><summary>Diff</summary>",
    "",
    "```diff",
    resolved.diff,
    "```",
    "",
    "</details>",
    thread,
    "",
    "---",
    "_Proposed by the **DevOps AI agent** after an incident investigation. Review & merge to apply — Flux reconciles the cluster after merge._",
  ].join("\n");
}

export async function runGitOps(req: GitOpsRequest, backend: GitOpsBackend): Promise<GitOpsPayload> {
  const files = await backend.listCandidateFiles(req.pathPrefix);
  const spec: ChangeSpec = { action: req.action, container: req.container, changes: req.changes, component: req.component };
  let resolved = resolveGitOpsEdit(files, req.helmRelease, spec);
  // value not in the overlay but might be in base → learn the path from base and add it to
  // the overlay (only when we know the overlay prefix, so we can derive the base prefix).
  if (!resolved.ok && resolved.tryBase && req.pathPrefix) {
    const basePrefix = deriveBasePrefix(req.pathPrefix);
    if (basePrefix) resolved = resolveGitOpsEdit(files, req.helmRelease, spec, await backend.listCandidateFiles(basePrefix));
  }
  if (!resolved.ok) {
    // a refusal is a normal outcome, but "which of the N files did it look at" is the
    // first question every time — record it once here instead of guessing later
    logger.info(`[gitops] ${req.op} ${req.requestId} refused over ${files.length} candidate file(s): ${resolved.reason}`);
    // drift is not a plain refusal — it is a finding the agent acts on (reconcile)
    if (resolved.drift) {
      logger.warn(
        `[gitops] DRIFT ${req.helmRelease.namespace}/${req.helmRelease.name}: ${resolved.drift.valuesKey} ` +
        `git=${resolved.drift.gitValue} cluster=${resolved.drift.clusterValue} (${resolved.drift.path})`
      );
      return { ok: false, reason: resolved.reason, drift: resolved.drift };
    }
    return { ok: false, reason: resolved.reason };
  }

  if (req.op === "dry_run") {
    return { ok: true, op: "dry_run", path: resolved.path, valuesKey: resolved.valuesKey, before: resolved.before, after: resolved.after, diff: resolved.diff };
  }

  // open_pr: re-read the current sha (catches drift since the dry run), branch, commit the
  // one-file change, open the PR. Each step is logged: this is a multi-step repo mutation,
  // and a failure halfway (branch created, commit not) is otherwise invisible — the log is
  // the only record of what was left behind.
  const sha = await backend.fileSha(resolved.path);
  const branch = `remediation/${slug(req.helmRelease.name)}-${req.requestId.slice(0, 8)}`;
  const title = prTitle(req);
  logger.info(`[gitops] open_pr ${req.requestId}: ${resolved.path} (key ${resolved.valuesKey}, sha ${sha.slice(0, 7)}) → branch ${branch}`);
  await backend.createBranch(branch);
  await backend.putFile(resolved.path, resolved.newContent, sha, branch, title);
  logger.info(`[gitops] committed ${resolved.path} on ${branch} — opening PR`);
  const prUrl = await backend.openPr(title, branch, prBody(req, resolved));
  logger.info(`[gitops] PR opened: ${prUrl}`);
  return { ok: true, op: "open_pr", path: resolved.path, prUrl };
}

// The login when GitHub matched the commit to an account, else the name the commit carries.
// The email is never read: this reaches Slack and the incident row.
export function toCommit(raw: RawCommit, path: string): GitOpsCommit {
  // commit.author.name can itself be an email (no GitHub account to resolve a login from) —
  // the rule is NEVER an email, so that falls back to "unknown" same as a missing name.
  const name = raw.author?.login ?? raw.commit.author?.name;
  const author = !name || name.includes("@") ? "unknown" : name;
  return {
    sha: raw.sha,
    // Committer date first: a rebase-merged or long-lived PR keeps its original AUTHOR date,
    // which can fall outside the window GitHub's `since` (committer-date-based) already matched.
    at: raw.commit.committer?.date ?? raw.commit.author?.date ?? "",
    author,
    // Sliced by code point, not UTF-16 code unit — a code-unit slice can cut an astral
    // character in half and leave a lone surrogate.
    message: Array.from(raw.commit.message.split("\n")[0]).slice(0, 120).join(""),
    url: raw.html_url,
    paths: [path],
  };
}

const MAX_COMMITS = 10;

// Same wording as resolveGitOpsEdit's ambiguity refusal (resolve.ts) — one matching file is the
// contract, and isHelmReleaseFile doesn't check namespace (by design: it may be defaulted/
// omitted in the file), so two files naming the same HelmRelease are indistinguishable here.
// Checked PER SET (overlay, base) — an overlay/base pair is the intended, expected shape and
// must still merge; what must never happen is two *unrelated* workloads sharing a name folding
// into one history.
function ambiguityRefusal(name: string, matches: RepoFile[]): GitOpsPayload | undefined {
  if (matches.length <= 1) return undefined;
  return { ok: false, reason: `ambiguous: ${matches.length} files define a HelmRelease named \`${name}\` (${matches.map((f) => f.path).join(", ")})` };
}

export async function runHistory(req: GitOpsHistoryRequest, backend: GitOpsBackend): Promise<GitOpsPayload> {
  const basePrefix = req.pathPrefix ? deriveBasePrefix(req.pathPrefix) : undefined;
  const list = (prefix?: string) => (backend.listHistoryFiles ?? backend.listCandidateFiles)(prefix);
  // overlay and base in parallel: a cold read of each is ~3-4 s of GitHub calls, and the agent waits 8 s
  const ofName = (files: RepoFile[]) => files.filter((f) => isHelmReleaseFile(f.content, req.helmRelease.name));
  const [overlayFiles, baseFiles] = await Promise.all([list(req.pathPrefix).then(ofName), basePrefix ? list(basePrefix).then(ofName) : []]);
  const refusal = ambiguityRefusal(req.helmRelease.name, overlayFiles) ?? ambiguityRefusal(req.helmRelease.name, baseFiles);
  if (refusal) return refusal;
  const paths = [...new Set([...overlayFiles, ...baseFiles].map((f) => f.path))];
  if (paths.length === 0) return { ok: false, reason: `no HelmRelease file for \`${req.helmRelease.namespace}/${req.helmRelease.name}\` found in the repo` };
  const bySha = new Map<string, GitOpsCommit>();
  for (const c of (await Promise.all(paths.map((p) => backend.listCommits(p, req.since)))).flat()) {
    const seen = bySha.get(c.sha);
    if (seen) seen.paths.push(...c.paths.filter((p) => !seen.paths.includes(p)));
    else bySha.set(c.sha, { ...c, paths: [...c.paths] });
  }
  const commits = [...bySha.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_COMMITS);
  logger.info(`[gitops] history ${req.requestId} ${req.helmRelease.namespace}/${req.helmRelease.name}: ${commits.length} commit(s) over ${paths.length} file(s)`);
  return { ok: true, op: "history", commits };
}

// Revert one commit's change to a HelmRelease's files. Clean reverts only: every touched file must
// read the same at HEAD as at `sha`, or a later commit changed it and restoring `sha^` would undo
// that one too. Reads fresh — never listHistoryFiles: this writes a file from what it read.
export async function runRevert(req: GitOpsRevertRequest, backend: GitOpsBackend): Promise<GitOpsPayload> {
  const short = req.sha.slice(0, 7);
  const basePrefix = req.pathPrefix ? deriveBasePrefix(req.pathPrefix) : undefined;
  const ofName = (files: RepoFile[]) => files.filter((f) => isHelmReleaseFile(f.content, req.helmRelease.name)).map((f) => f.path);
  const [overlay, base, info] = await Promise.all([
    backend.listCandidateFiles(req.pathPrefix).then(ofName),
    basePrefix ? backend.listCandidateFiles(basePrefix).then(ofName) : Promise.resolve([] as string[]),
    backend.commitInfo(req.sha),
  ]);
  const touched = [...new Set([...overlay, ...base])].filter((p) => info.files.includes(p));
  if (touched.length === 0) return { ok: false, reason: `commit ${short} does not touch HelmRelease \`${req.helmRelease.name}\`'s files` };
  const edits: Array<{ path: string; head: string; parent: string }> = [];
  for (const path of touched) {
    const [head, atSha, parent] = await Promise.all([backend.fileAt(path), backend.fileAt(path, req.sha), backend.fileAt(path, info.parent)]);
    if (head === null) return { ok: false, reason: `not a clean revert: ${path} no longer exists` };
    if (head !== atSha) {
      const later = (await backend.listCommits(path, info.date)).find((c) => c.sha !== req.sha);
      return { ok: false, reason: `not a clean revert: ${path} changed after ${short}${later ? ` (by ${later.sha.slice(0, 7)})` : ""}` };
    }
    if (parent === null) return { ok: false, reason: `not a clean revert: ${path} was created by ${short} (no file deletes)` };
    if (parent === head) return { ok: false, reason: `nothing to revert: ${path} already reads as before ${short}` };
    edits.push({ path, head, parent });
  }
  const diff = edits.map((e) => unifiedFileDiff(e.path, e.head, e.parent)).join("\n");
  if (req.dryRun) return { ok: true, op: "revert_pr", dryRun: true, paths: edits.map((e) => e.path), diff };
  const branch = `revert/${slug(req.helmRelease.name)}-${short}-${req.requestId.slice(0, 8)}`;
  const title = `Revert ${short}: ${info.message.split("\n")[0].slice(0, 80)}`;
  logger.info(`[gitops] revert_pr ${req.requestId}: ${edits.map((e) => e.path).join(", ")} → branch ${branch}`);
  await backend.createBranch(branch);
  for (const e of edits) await backend.putFile(e.path, e.parent, await backend.fileSha(e.path), branch, title);
  const body = [
    `Reverts ${req.sha} for HelmRelease \`${req.helmRelease.namespace}/${req.helmRelease.name}\`.`,
    req.incident?.summary ? `\nIncident: ${req.incident.summary}` : "",
    req.incident?.threadUrl ? `\nThread: ${req.incident.threadUrl}` : "",
    "\n\n_Proposed by the **DevOps AI agent** from the incident's change timeline. Review & merge to apply — Flux reconciles the cluster after merge._",
  ].join("");
  const prUrl = await backend.openPr(title, branch, body);
  logger.info(`[gitops] revert PR opened: ${prUrl}`);
  return { ok: true, op: "revert_pr", dryRun: false, paths: edits.map((e) => e.path), prUrl };
}

// A whole-file line diff for the card — release files are small, so trimming the common prefix
// and suffix is enough.
function unifiedFileDiff(path: string, from: string, to: string): string {
  const a = from.split("\n");
  const b = to.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ line ${s + 1} @@`, ...a.slice(s, a.length - e).map((l) => `-${l}`), ...b.slice(s, b.length - e).map((l) => `+${l}`)].join("\n");
}

// bounded-concurrency map so fetching candidate files can't burst into GitHub's secondary
// rate limit
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Real backend over the GitHub REST client. Narrows to release-like YAML files (Flux
// layouts name them release.yaml / *-helmrelease.yaml); falls back to all YAML if none
// match. ponytail: heuristic narrowing — broaden or switch to code-search if it misses a layout.
export function githubBackend(client: GitHubClient, cfg: { branch: string; pathPrefix: string }, now: () => number = Date.now): GitOpsBackend {
  const listCandidateFiles = async (pathPrefix?: string): Promise<RepoFile[]> => {
    const all = await client.listYamlFiles(cfg.branch, pathPrefix ?? cfg.pathPrefix);
    const releaseLike = all.filter((p) => /(^|\/)[^/]*(release|helmrelease)[^/]*\.ya?ml$/i.test(p));
    const chosen = releaseLike.length > 0 ? releaseLike : all;
    return mapLimit(chosen, 8, async (path) => ({ path, content: (await client.getFile(path, cfg.branch)).content }));
  };
  // One alert asks history for up to 3 HelmReleases at once, and each request re-listed the tree
  // and every release file in both prefixes: 58 GitHub calls in ~10 s, past the agent's 8 s wait,
  // so incident 251 (2026-10-09) read "git history: timeout" while the worker was answering `ok`.
  // The PROMISE is shared, so a burst waits on one fetch; a failure is dropped, not remembered.
  // Kept 10 min, not 60 s: on 2026-10-09 GitHub answered contents calls in 2-7 s, so even a
  // shared cold read (14 s) missed the 8 s wait, and alerts minutes apart each paid for one.
  // History uses these files only to find WHICH files define the HelmRelease — a values edit
  // does not change that, and commits (listCommits) are never cached, so a commit is always seen.
  // ponytail: per-prefix 10 min memo, history only — a newly added or moved release file waits
  // for the expiry (or a worker restart); make it a config knob if layouts start churning.
  const HISTORY_FILES_TTL_MS = 10 * 60_000;
  const shared = new Map<string, { at: number; files: Promise<RepoFile[]> }>();
  const listHistoryFiles = (pathPrefix?: string): Promise<RepoFile[]> => {
    const key = pathPrefix ?? cfg.pathPrefix;
    const hit = shared.get(key);
    if (hit && now() - hit.at < HISTORY_FILES_TTL_MS) return hit.files;
    const files = listCandidateFiles(pathPrefix);
    shared.set(key, { at: now(), files });
    files.catch(() => shared.delete(key));
    return files;
  };
  return {
    listCandidateFiles,
    listHistoryFiles,
    listCommits: async (path, since) => (await client.listCommits(path, cfg.branch, since)).map((raw) => toCommit(raw, path)),
    commitInfo: (sha) => client.commitInfo(sha),
    fileAt: async (path, ref) => {
      try { return (await client.getFile(path, ref ?? cfg.branch)).content; }
      catch (err) { if (/ failed: 404/.test(String(err))) return null; throw err; }
    },
    fileSha: async (path) => (await client.getFile(path, cfg.branch)).sha,
    createBranch: (branch) => client.createBranch(branch, cfg.branch),
    putFile: (path, content, sha, branch, message) => client.putFile(path, content, sha, branch, message),
    openPr: (title, branch, body) => client.openPr(title, branch, cfg.branch, body),
  };
}
