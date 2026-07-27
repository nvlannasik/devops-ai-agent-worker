import { parseDocument } from "yaml";

// GitOps PR-flow resolver (DESIGN_gitops_pr_remediation.md §3). Given the owning HelmRelease
// + the change context from the MCP GitOps preview, locate the file in the Git repo and edit
// the value. IN-OVERLAY edits are line-based (targeted, minimal diff, comments preserved). If
// the value is ONLY in base (not overridden per-env), the value's PATH is learned from base
// and ADDED to the overlay's spec.values via the `yaml` Document API (setIn — creates the
// nested key cleanly), so a remediation isn't refused just because the value wasn't overridden
// in the overlay yet. Everything degrades to an honest refuse on ambiguity.
//
// ponytail: line-based for edits; `yaml` Document only for the base→overlay ADD path.
// set_resources nested leaves resolved via an indentation parent stack (limits.memory vs
// requests.memory); not container-scoped (refuses on ambiguity — fine for one resources block).

export interface RepoFile {
  path: string;
  content: string;
}
export interface GitOpsChange {
  field: string;
  from: string | number;
  to: string | number;
}
export interface ChangeSpec {
  action: "set_image" | "scale" | "set_resources";
  container?: string;
  changes: GitOpsChange[];
  // chart component (from the workload's app.kubernetes.io/component label) — used to pick the
  // right values sub-tree when a multi-component chart has several replicaCount/resources.
  component?: string;
}

// When several candidate paths match, keep only the one under the target component's sub-tree
// (its key appears in the path). No component, or the filter doesn't narrow to exactly one →
// return the originals unchanged (caller then refuses on ambiguity — never guesses).
function narrowByComponent<T extends { path: string[] }>(matches: T[], component?: string): T[] {
  if (matches.length <= 1 || !component) return matches;
  const filtered = matches.filter((m) => m.path.includes(component));
  return filtered.length === 1 ? filtered : matches;
}
export interface HelmReleaseRef {
  name: string;
  namespace: string;
}

// Cluster/Git drift: the overlay DOES declare this key, but to a different value than the
// one running in the cluster. Somebody changed the cluster outside GitOps. Editing the file
// would be wrong (the incident's `from` is not what Git says), and so is "not set in the
// overlay" — the honest answer is "reconcile, Git is the source of truth".
export interface DriftInfo {
  path: string; // repo file that declares the value
  valuesKey: string; // the key inside spec.values
  gitValue: string; // what the GitOps repo declares
  clusterValue: string; // what is actually running (the incident context's `from`)
}

export type ResolveResult =
  | { ok: true; path: string; valuesKey: string; before: string; after: string; newContent: string; diff: string; addedFromBase?: boolean }
  | { ok: false; reason: string; tryBase?: boolean; drift?: DriftInfo }; // tryBase = value absent from overlay → the caller may retry with base files

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A HelmRelease's Git file: `kind: HelmRelease` + a metadata `name:` matching the release.
// Namespace is intentionally not matched line-based (it may be defaulted/omitted in the
// file); duplicate names collapse to a refuse below.
function isHelmReleaseFile(content: string, name: string): boolean {
  if (!/^\s*kind:\s*HelmRelease\s*$/m.test(content)) return false;
  return new RegExp(`^\\s*name:\\s*(["']?)${escapeRe(name)}\\1\\s*$`, "m").test(content);
}

// image tag = the part after the last ':' with any @digest stripped. null when the ref
// carries no tag (we then can't safely locate/rewrite it).
export function tagOf(ref: string): string | null {
  const noDigest = ref.split("@")[0];
  const idx = noDigest.lastIndexOf(":");
  if (idx === -1) return null;
  const tag = noDigest.slice(idx + 1);
  return tag.length > 0 ? tag : null;
}

interface SearchSpec {
  keys: string[]; // candidate value-key names for this action
  from: string;
  to: string;
}

// Build the (key, from→to) search specs for an action. null = this action can't be
// resolved line-based (with a human reason).
function searchSpecs(spec: ChangeSpec): { specs: SearchSpec[] } | { error: string } {
  if (spec.action === "set_image") {
    const c = spec.changes[0];
    if (!c) return { error: "no image change provided" };
    const fromRef = String(c.from);
    const toRef = String(c.to);
    const fromTag = tagOf(fromRef);
    const toTag = tagOf(toRef);
    const specs: SearchSpec[] = [{ keys: ["image"], from: fromRef, to: toRef }];
    if (fromTag && toTag) specs.push({ keys: ["tag"], from: fromTag, to: toTag });
    return { specs };
  }
  if (spec.action === "scale") {
    const c = spec.changes[0];
    if (!c) return { error: "no replica change provided" };
    return { specs: [{ keys: ["replicaCount", "replicas"], from: String(c.from), to: String(c.to) }] };
  }
  // set_resources is handled by resolveResourceEdit (nested, multi-line) — not here.
  return { error: "internal: set_resources must not reach searchSpecs" };
}

interface ResourceMatch {
  lineIdx: number;
  indent: string;
  quote: string;
  value: string;
  comment: string;
  path: string[];
}

// Find a leaf `<leafKey>: <from>` line whose enclosing block is `<parentKey>:` and that sits
// somewhere under a `resources:` block — via an indentation-tracked parent stack. This is how
// `limits.memory` is disambiguated from `requests.memory` (same leaf/value, different parent).
// `path` (ancestor keys) lets the caller further narrow by chart component.
// `from` undefined = match the key whatever its value is (drift detection); the captured
// value then says what Git declares.
function findResourceMatches(lines: string[], parentKey: string, leafKey: string, from?: string): ResourceMatch[] {
  const out: ResourceMatch[] = [];
  const stack: Array<{ indent: number; key: string }> = []; // enclosing block headers
  const leafRe = new RegExp(`^(\\s*)${escapeRe(leafKey)}:\\s*(["']?)(.*?)\\2\\s*(#.*)?$`);
  const headerRe = /^(\s*)([\w.\-/]+):\s*(#.*)?$/; // "key:" with nothing (or a comment) after

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const leaf = line.match(leafRe);
    if (leaf && leaf[3] && (from === undefined || leaf[3] === from)) {
      const parent = stack[stack.length - 1];
      if (parent && parent.key === parentKey && stack.some((s) => s.key === "resources")) {
        out.push({ lineIdx: i, indent: leaf[1], quote: leaf[2], value: leaf[3], comment: leaf[4] ? ` ${leaf[4]}` : "", path: [...stack.map((s) => s.key), leafKey] });
      }
      continue;
    }
    const header = line.match(headerRe);
    if (header) stack.push({ indent, key: header[2] });
  }
  return out;
}

// set_resources: each change (`limits.memory`, `requests.cpu`, ...) → one nested leaf edit.
// All must resolve uniquely; multiple changes are applied to distinct lines.
function resolveResourceEdit(path: string, lines: string[], changes: GitOpsChange[], component?: string): ResolveResult {
  const newLines = [...lines];
  const applied: Array<{ lineIdx: number; before: string; after: string }> = [];
  for (const c of changes) {
    const [parentKey, leafKey, ...rest] = String(c.field).split(".");
    if (!parentKey || !leafKey || rest.length) return { ok: false, reason: `unexpected resource field \`${c.field}\` (expected <requests|limits>.<cpu|memory>)` };
    const matches = narrowByComponent(findResourceMatches(lines, parentKey, leafKey, String(c.from)), component);
    if (matches.length === 0) {
      // same drift-vs-absent distinction as editInFile: re-scan by key alone
      const byKey = narrowByComponent(findResourceMatches(lines, parentKey, leafKey), component);
      if (byKey.length === 1 && byKey[0].value !== String(c.from)) {
        const drift: DriftInfo = { path, valuesKey: `resources.${c.field}`, gitValue: byKey[0].value, clusterValue: String(c.from) };
        return { ok: false, reason: driftReason(drift), drift };
      }
      return { ok: false, reason: `\`resources.${c.field}\` is not set in the overlay \`${path}\``, tryBase: true };
    }
    if (matches.length > 1) return { ok: false, reason: `ambiguous: ${matches.length} lines match \`resources.${c.field}\` in \`${path}\`${component ? ` even within component \`${component}\`` : ""} — refusing to guess` };
    const m = matches[0];
    if (applied.some((a) => a.lineIdx === m.lineIdx)) return { ok: false, reason: `two changes resolved to the same line in \`${path}\`` };
    const before = lines[m.lineIdx];
    const after = `${m.indent}${leafKey}: ${m.quote}${c.to}${m.quote}${m.comment}`;
    newLines[m.lineIdx] = after;
    applied.push({ lineIdx: m.lineIdx, before, after });
  }
  if (applied.length === 0) return { ok: false, reason: "no resource changes provided" };
  const sorted = [...applied].sort((a, b) => a.lineIdx - b.lineIdx);
  const diff = [`--- a/${path}`, `+++ b/${path}`, ...sorted.map((e) => `@@ line ${e.lineIdx + 1} @@\n-${e.before}\n+${e.after}`)].join("\n");
  return {
    ok: true,
    path,
    valuesKey: changes.map((c) => c.field).join(", "),
    before: applied[0].before.trim(),
    after: applied[0].after.trim(),
    newContent: newLines.join("\n"),
    diff,
  };
}

interface LineMatch {
  lineIdx: number;
  key: string;
  indent: string;
  quote: string;
  to: string;
  comment: string;
  path: string[];
}

// Every line `<indent><key>: <value>[ # comment]` whose key ∈ a spec's keys and whose value
// == that spec's `from`, with its ancestor `path` (for component narrowing). Collected across
// the file; the caller refuses unless exactly one remains.
function findMatches(lines: string[], specs: SearchSpec[]): LineMatch[] {
  const out: LineMatch[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  const headerRe = /^(\s*)([\w.\-/]+):\s*(#.*)?$/;
  lines.forEach((line, lineIdx) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (headerRe.test(line)) {
      stack.push({ indent, key: line.match(headerRe)![2] });
      return;
    }
    for (const spec of specs) {
      for (const key of spec.keys) {
        const m = line.match(new RegExp(`^(\\s*)${escapeRe(key)}:\\s*(["']?)${escapeRe(spec.from)}\\2\\s*(#.*)?$`));
        if (m) out.push({ lineIdx, key, indent: m[1], quote: m[2], to: spec.to, comment: m[3] ? ` ${m[3]}` : "", path: [...stack.map((s) => s.key), key] });
      }
    }
  });
  return out;
}

// Same scan as findMatches, but keyed on the KEY only — whatever value is there is captured.
// This is what tells "the overlay doesn't set this at all" apart from "the overlay sets it
// to something else", which are indistinguishable to a value-matching search and were both
// reported as "not set in the overlay".
function findKeyLines(lines: string[], keys: string[]): Array<{ key: string; value: string; path: string[] }> {
  const out: Array<{ key: string; value: string; path: string[] }> = [];
  const stack: Array<{ indent: number; key: string }> = [];
  const headerRe = /^(\s*)([\w.\-/]+):\s*(#.*)?$/;
  lines.forEach((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (headerRe.test(line)) {
      stack.push({ indent, key: line.match(headerRe)![2] });
      return;
    }
    for (const key of keys) {
      const m = line.match(new RegExp(`^\\s*${escapeRe(key)}:\\s*(["']?)(.*?)\\1\\s*(#.*)?$`));
      if (m && m[2]) out.push({ key, value: m[2], path: [...stack.map((s) => s.key), key] });
    }
  });
  return out;
}

// The value-matching search found nothing — is that because the overlay is silent about the
// key, or because Git and the cluster disagree? Exactly one key match with a different value
// is drift. Anything ambiguous stays undefined (caller falls back to the base-add path).
function detectDrift(path: string, lines: string[], specs: SearchSpec[], component?: string): DriftInfo | undefined {
  for (const spec of specs) {
    const found = narrowByComponent(findKeyLines(lines, spec.keys), component);
    if (found.length !== 1) continue;
    const git = found[0];
    if (git.value === spec.from) continue; // findMatches would have matched — not drift
    return { path, valuesKey: git.path.join("."), gitValue: git.value, clusterValue: spec.from };
  }
  return undefined;
}

// One sentence the agent and the human both read. States the direction explicitly: Git is
// the source of truth, so the fix is to reconcile the cluster back, not to write a PR that
// would encode a value nobody declared.
function driftReason(d: DriftInfo): string {
  return (
    `cluster/GitOps drift: \`${d.valuesKey}\` is \`${d.gitValue}\` in \`${d.path}\` but the cluster is running \`${d.clusterValue}\` — ` +
    `something changed the cluster outside the GitOps repo. The repo is the source of truth, so the fix is a Flux reconcile ` +
    `(restoring \`${d.gitValue}\`), not a PR. Open a PR only if \`${d.clusterValue}\` is the value that should be declared.`
  );
}

function unifiedDiff(path: string, lineIdx: number, before: string, after: string): string {
  return [`--- a/${path}`, `+++ b/${path}`, `@@ line ${lineIdx + 1} @@`, `-${before}`, `+${after}`].join("\n");
}

// The in-overlay edit for image/scale/set_resources. `tryBase: true` on its refusal means
// the value simply isn't in this file → the caller may retry against base.
function editInFile(path: string, lines: string[], spec: ChangeSpec): ResolveResult {
  if (spec.action === "set_resources") return resolveResourceEdit(path, lines, spec.changes, spec.component);

  const built = searchSpecs(spec);
  if ("error" in built) return { ok: false, reason: built.error };
  const matches = narrowByComponent(findMatches(lines, built.specs), spec.component);
  if (matches.length === 0) {
    // drift beats "not set": the key IS declared here, just not with the running value
    const drift = detectDrift(path, lines, built.specs, spec.component);
    if (drift) return { ok: false, reason: driftReason(drift), drift };
    return { ok: false, reason: `the value is not set in the overlay \`${path}\``, tryBase: true };
  }
  if (matches.length > 1) return { ok: false, reason: `ambiguous: ${matches.length} lines in \`${path}\` match the current value${spec.component ? ` even within component \`${spec.component}\`` : ""} — refusing to guess` };

  const m = matches[0];
  const before = lines[m.lineIdx];
  const after = `${m.indent}${m.key}: ${m.quote}${m.to}${m.quote}${m.comment}`;
  const newLines = [...lines];
  newLines[m.lineIdx] = after;
  return { ok: true, path, valuesKey: m.key, before, after, newContent: newLines.join("\n"), diff: unifiedDiff(path, m.lineIdx, before, after) };
}

// Locate the overlay HelmRelease file and edit the value. When the value isn't in the overlay
// and `baseFiles` are supplied, learn its path from base and ADD it to the overlay (§3.4).
export function resolveGitOpsEdit(files: RepoFile[], hr: HelmReleaseRef, spec: ChangeSpec, baseFiles?: RepoFile[]): ResolveResult {
  const hrFiles = files.filter((f) => isHelmReleaseFile(f.content, hr.name));
  if (hrFiles.length === 0) return { ok: false, reason: `no HelmRelease file for \`${hr.namespace}/${hr.name}\` found in the repo` };
  if (hrFiles.length > 1) {
    return { ok: false, reason: `ambiguous: ${hrFiles.length} files define a HelmRelease named \`${hr.name}\` (${hrFiles.map((f) => f.path).join(", ")})` };
  }
  const file = hrFiles[0];
  const inOverlay = editInFile(file.path, file.content.split("\n"), spec);
  if (inOverlay.ok || !inOverlay.tryBase || !baseFiles) return inOverlay;
  return addFromBase(file, baseFiles, hr, spec);
}

// ---- base → overlay ADD (value only in base) ----

interface KeyMatcher {
  leafKeys: string[];
  parentKey?: string;
  ancestorKey?: string;
}

// Full paths (from doc root) of leaf keys matching the matcher, via an indentation parent
// stack. Matches by KEY only (not value) — we want the schema path to replicate in the overlay.
function findKeyPaths(lines: string[], m: KeyMatcher): string[][] {
  const out: string[][] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  const headerRe = /^(\s*)([\w.\-/]+):\s*(#.*)?$/;
  const leafRe = /^(\s*)([\w.\-/]+):\s+\S.*$/;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (headerRe.test(line)) {
      stack.push({ indent, key: line.match(headerRe)![2] });
      continue;
    }
    const leaf = line.match(leafRe);
    if (!leaf || !m.leafKeys.includes(leaf[2])) continue;
    const parent = stack[stack.length - 1];
    if (m.parentKey && (!parent || parent.key !== m.parentKey)) continue;
    if (m.ancestorKey && !stack.some((s) => s.key === m.ancestorKey)) continue;
    out.push([...stack.map((s) => s.key), leaf[2]]);
  }
  return out;
}

// Per-change {matcher, value to write, label}. Only scale + set_resources support base-add
// (image tags essentially always live in overlays).
function baseMatchers(spec: ChangeSpec): Array<{ matcher: KeyMatcher; from: string; to: string | number; label: string }> | { error: string } {
  if (spec.action === "scale") {
    const c = spec.changes[0];
    if (!c) return { error: "no replica change provided" };
    return [{ matcher: { leafKeys: ["replicaCount", "replicas"], ancestorKey: "values" }, from: String(c.from), to: Number(c.to), label: "replicaCount" }];
  }
  if (spec.action === "set_resources") {
    return spec.changes.map((c) => {
      const [parentKey, leafKey] = String(c.field).split(".");
      return { matcher: { leafKeys: [leafKey], parentKey, ancestorKey: "resources" }, from: String(c.from), to: String(c.to), label: `resources.${c.field}` };
    });
  }
  return { error: "not supported by base-add" };
}

// Diff for the base→overlay ADD path. setIn only inserts here (an existing key is refused
// upstream), but `yaml`'s toString() can still re-emit unrelated lines differently. Anything
// from `prev` that didn't survive is reported as a removal rather than dropped — a human
// approves this diff, so it must never claim a change is purely additive when it isn't.
function additiveDiff(path: string, prev: string, next: string): string {
  const a = prev.split("\n");
  const b = next.split("\n");
  const added: string[] = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && a[i] === line) i++;
    else added.push(`+${line}`);
  }
  const removed = a.slice(i).map((line) => `-${line}`);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ added to spec.values @@`, ...added, ...removed].join("\n");
}

function addFromBase(overlay: RepoFile, baseFiles: RepoFile[], hr: HelmReleaseRef, spec: ChangeSpec): ResolveResult {
  const matchers = baseMatchers(spec);
  if ("error" in matchers) return { ok: false, reason: `the value is not set in the overlay and can't be auto-added for this action — set it in the overlay values first` };

  const baseHr = baseFiles.filter((f) => isHelmReleaseFile(f.content, hr.name));
  if (baseHr.length === 0) return { ok: false, reason: `the value is set in neither the overlay nor base — it relies on a chart default; set it explicitly in the overlay values first` };
  if (baseHr.length > 1) return { ok: false, reason: `ambiguous: ${baseHr.length} base files define a HelmRelease named \`${hr.name}\`` };
  const baseLines = baseHr[0].content.split("\n");

  const doc = parseDocument(overlay.content);
  const added: string[] = [];
  for (const { matcher, from, to, label } of matchers) {
    // narrowByComponent operates on {path}; wrap the raw paths to reuse it
    const paths = narrowByComponent(findKeyPaths(baseLines, matcher).map((path) => ({ path })), spec.component).map((w) => w.path);
    if (paths.length === 0) return { ok: false, reason: `\`${label}\` isn't set in base either — it's a chart default; set it explicitly in the overlay` };
    if (paths.length > 1) return { ok: false, reason: `ambiguous: \`${label}\` appears ${paths.length}× in base${spec.component ? ` even within component \`${spec.component}\`` : ""} — refusing to guess where to override` };
    // We got here because the line-based search found no `<key>: <from>` in the overlay —
    // which is also what happens when the overlay DOES set the key but to a different value
    // (a stale `from` in the incident context). setIn would then silently REPLACE the
    // operator's value while additiveDiff rendered it as a clean insertion. Refuse instead:
    // "only change an already-set key, never guess" cuts both ways.
    if (doc.hasIn(paths[0])) {
      const existing = doc.getIn(paths[0]);
      return {
        ok: false,
        reason: `\`${label}\` IS already set to \`${String(existing)}\` in the overlay \`${overlay.path}\`, but the incident context expected \`${from}\` — the context is stale, so overriding it now could undo a deliberate change. Re-check the current value and re-run.`,
      };
    }
    doc.setIn(paths[0], to);
    added.push(`${paths[0].slice(2).join(".")} = ${to}`); // strip spec.values for display
  }
  const newContent = doc.toString();
  return {
    ok: true,
    path: overlay.path,
    valuesKey: added.map((a) => a.split(" = ")[0]).join(", "),
    before: "(not in overlay — added from base)",
    after: added.join(", "),
    newContent,
    diff: additiveDiff(overlay.path, overlay.content, newContent),
    addedFromBase: true,
  };
}

// overlay prefix (apps/dev/systems) → base prefix (apps/base/systems): the env segment (2nd)
// becomes "base". Returns undefined when the shape doesn't fit (no auto-base then).
export function deriveBasePrefix(overlayPrefix: string, baseSegment = "base"): string | undefined {
  const parts = overlayPrefix.replace(/\/+$/, "").split("/");
  if (parts.length < 2 || parts[1] === baseSegment) return undefined;
  parts[1] = baseSegment;
  return parts.join("/");
}
