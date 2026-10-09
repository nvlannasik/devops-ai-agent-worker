import { test } from "node:test";
import assert from "node:assert/strict";
import { runGitOps, prTitle, prBody, runHistory, toCommit, githubBackend, type GitOpsBackend } from "./handler.js";
import type { RepoFile } from "./resolve.js";
import type { GitOpsRequest } from "./message.js";

const HR_FILE: RepoFile = {
  path: "apps/base/systems/ingress-nginx/release.yaml",
  content: `kind: HelmRelease
metadata:
  name: ingress-nginx
  namespace: nginx-ingress
spec:
  values:
    controller:
      replicaCount: 1`,
};

function fakeBackend(files: RepoFile[]) {
  const calls: { createBranch?: string; putFile?: { path: string; content: string; sha: string; branch: string }; openPr?: { title: string; branch: string; body: string } } = {};
  const backend: GitOpsBackend = {
    listCandidateFiles: async () => files,
    listCommits: async () => [],
    fileSha: async () => "sha-abc",
    createBranch: async (branch) => { calls.createBranch = branch; },
    putFile: async (path, content, sha, branch) => { calls.putFile = { path, content, sha, branch }; },
    openPr: async (title, branch, body) => { calls.openPr = { title, branch, body }; return "https://ghe.example/pr/42"; },
  };
  return { backend, calls };
}

const scaleReq = (op: "dry_run" | "open_pr"): GitOpsRequest => ({
  requestId: "req-12345678-abcd",
  op,
  helmRelease: { name: "ingress-nginx", namespace: "nginx-ingress" },
  action: "scale",
  changes: [{ field: "replicas", from: 1, to: 3 }],
  incident: { summary: "scale ingress to 3", threadUrl: "https://slack/thread" },
});

test("prTitle is short and action-specific", () => {
  assert.equal(prTitle({ ...scaleReq("open_pr") }), "Remediation: scale `ingress-nginx` to 3 replicas");
  const img = { ...scaleReq("open_pr"), action: "set_image" as const, changes: [{ field: "image", from: "repo/app:v1", to: "repo/app:v2" }] };
  assert.equal(prTitle(img), "Remediation: bump `ingress-nginx` image to v2");
});

test("prBody renders a change table, collapsible diff, and incident link", () => {
  const body = prBody(scaleReq("open_pr"), { ok: true, path: "apps/dev/x.yaml", valuesKey: "replicaCount", before: "  replicaCount: 1", after: "  replicaCount: 3", newContent: "", diff: "-  replicaCount: 1\n+  replicaCount: 3" });
  assert.match(body, /\| `replicas` \| `1` \| `3` \|/); // change table row
  assert.match(body, /<details><summary>Diff<\/summary>/); // collapsible diff
  assert.match(body, /apps\/dev\/x.yaml/);
  assert.match(body, /https:\/\/slack\/thread/); // incident link
});

test("dry_run returns the diff and opens NO PR", async () => {
  const { backend, calls } = fakeBackend([HR_FILE]);
  const r = await runGitOps(scaleReq("dry_run"), backend);
  assert.ok(r.ok && r.op === "dry_run");
  assert.equal(r.ok && r.valuesKey, "replicaCount");
  assert.ok(r.ok && r.diff.includes("+      replicaCount: 3"));
  assert.equal(calls.createBranch, undefined);
  assert.equal(calls.openPr, undefined);
});

test("open_pr branches, commits the edited file, and opens a PR", async () => {
  const { backend, calls } = fakeBackend([HR_FILE]);
  const r = await runGitOps(scaleReq("open_pr"), backend);
  assert.ok(r.ok && r.op === "open_pr");
  assert.equal(r.ok && r.prUrl, "https://ghe.example/pr/42");
  assert.match(calls.createBranch!, /^remediation\/ingress-nginx-req-1234/);
  assert.equal(calls.putFile!.sha, "sha-abc");
  assert.ok(calls.putFile!.content.includes("replicaCount: 3")); // the edit was committed
  assert.equal(calls.putFile!.branch, calls.createBranch);
  assert.ok(calls.openPr!.body.includes("https://slack/thread")); // incident link in PR body
});

test("an unresolvable change refuses without touching GitHub", async () => {
  const noValue: RepoFile = { ...HR_FILE, content: "kind: HelmRelease\nmetadata:\n  name: ingress-nginx\nspec:\n  values: {}" };
  const { backend, calls } = fakeBackend([noValue]);
  const r = await runGitOps(scaleReq("open_pr"), backend);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /not set in the overlay/);
  assert.equal(calls.createBranch, undefined);
  assert.equal(calls.putFile, undefined);
});

const hrFile = (name: string) => `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: ${name}\nspec:\n  values: {}\n`;

test("toCommit: login first, then the author name — never an email; first line only, 120 chars", () => {
  const raw = { sha: "abc1234def", html_url: "https://gh/c/abc", author: null, commit: { message: `${"x".repeat(130)}\nbody`, author: { name: "Jane", email: "jane@example.com", date: "2026-10-08T01:00:00Z" } } };
  const c = toCommit(raw, "apps/dev/a/release.yaml");
  assert.equal(c.author, "Jane");
  assert.equal(c.message.length, 120);
  assert.doesNotMatch(JSON.stringify(c), /@example\.com/);
  assert.equal(toCommit({ ...raw, author: { login: "jdoe" } }, "p").author, "jdoe");
});

test("toCommit: the 120-char cut is by code point, not UTF-16 code unit — an emoji straddling the cut leaves no lone surrogate", () => {
  // "a" * 119 + an astral emoji (2 UTF-16 code units: positions 119-120). A code-unit slice(0,120)
  // keeps only the emoji's leading surrogate; a code-point slice keeps the whole emoji or drops it.
  const firstLine = "a".repeat(119) + "😀" + "bbbb";
  const raw = { sha: "abc1234def", html_url: "https://gh/c/abc", author: null, commit: { message: firstLine, author: { name: "Jane", date: "2026-10-08T01:00:00Z" } } };
  const c = toCommit(raw, "p");
  const lonePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(c.message, lonePattern);
});

test("toCommit: the committer date wins over the author date when both are present", () => {
  const raw = {
    sha: "abc1234def", html_url: "https://gh/c/abc", author: null,
    commit: {
      message: "m",
      author: { name: "Jane", date: "2026-09-01T00:00:00Z" },
      committer: { date: "2026-10-08T01:00:00Z" },
    },
  };
  const c = toCommit(raw, "p");
  assert.equal(c.at, "2026-10-08T01:00:00Z");
});

test("toCommit: an author.name that is itself an email maps to \"unknown\", never the email — the rule is NEVER an email", () => {
  const raw = { sha: "abc1234def", html_url: "https://gh/c/abc", author: null, commit: { message: "m", author: { name: "jane@example.com", date: "2026-10-08T01:00:00Z" } } };
  const c = toCommit(raw, "p");
  assert.equal(c.author, "unknown");
});

test("runHistory: overlay + base files of the HelmRelease, deduped by sha, newest first, capped at 10, no writes", async () => {
  const calls: string[] = [];
  const commit = (sha: string, at: string, path: string) => ({ sha, at, author: "a", message: "m", url: `u/${sha}`, paths: [path] });
  const noWrite = async (): Promise<never> => { throw new Error("no writes"); };
  const backend = {
    listCandidateFiles: async (prefix?: string) => (prefix === "apps/base/applications"
      ? [{ path: "apps/base/applications/api/release.yaml", content: hrFile("api") }]
      : [{ path: "apps/dev/applications/api/release.yaml", content: hrFile("api") }, { path: "apps/dev/applications/other/release.yaml", content: hrFile("other") }]),
    listCommits: async (path: string) => {
      calls.push(path);
      return path.includes("/dev/")
        ? [commit("s1", "2026-10-08T03:00:00Z", path), commit("s2", "2026-10-08T01:00:00Z", path)]
        : [commit("s2", "2026-10-08T01:00:00Z", path), ...Array.from({ length: 12 }, (_, i) => commit(`b${i}`, `2026-10-07T${String(i).padStart(2, "0")}:00:00Z`, path))];
    },
    fileSha: noWrite, createBranch: noWrite, putFile: noWrite, openPr: noWrite,
  };
  const r = await runHistory({ requestId: "r", op: "history", helmRelease: { name: "api", namespace: "flux-app" }, pathPrefix: "apps/dev/applications", since: "2026-10-07T00:00:00Z" }, backend);
  assert.ok(r.ok && r.op === "history");
  assert.deepEqual(calls.sort(), ["apps/base/applications/api/release.yaml", "apps/dev/applications/api/release.yaml"]);
  assert.equal(r.commits.length, 10);
  assert.deepEqual(r.commits.slice(0, 2).map((c) => c.sha), ["s1", "s2"]);
  assert.equal(r.commits[1].paths.length, 2, "a commit touching overlay and base keeps both paths");
});

test("runHistory: no HelmRelease file is a refusal, not an empty history", async () => {
  const backend = { listCandidateFiles: async () => [], listCommits: async () => [], fileSha: async () => "", createBranch: async () => {}, putFile: async () => {}, openPr: async () => "" };
  const r = await runHistory({ requestId: "r", op: "history", helmRelease: { name: "api", namespace: "x" }, since: "2026-10-07T00:00:00Z" }, backend);
  assert.equal(r.ok, false);
});

test("runHistory: two overlay files naming the same HelmRelease refuse as ambiguous — never merges unrelated workloads", async () => {
  const calls: string[] = [];
  const backend = {
    listCandidateFiles: async () => [
      { path: "apps/dev/applications/api/release.yaml", content: hrFile("api") },
      { path: "apps/dev/applications/other-api/release.yaml", content: hrFile("api") },
    ],
    listCommits: async (path: string) => { calls.push(path); return []; },
    fileSha: async () => "", createBranch: async () => {}, putFile: async () => {}, openPr: async () => "",
  };
  const r = await runHistory({ requestId: "r", op: "history", helmRelease: { name: "api", namespace: "flux-app" }, since: "2026-10-07T00:00:00Z" }, backend);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /ambiguous/);
  assert.equal(calls.length, 0, "listCommits must never be called once the candidate set is ambiguous");
});

// Incident 251 (2026-10-09): three parallel history requests each re-listed the tree and every
// release file — 58 GitHub calls, 9-10 s, past the agent's 8 s wait, so git read "timeout".
test("githubBackend: history shares one candidate-file read per prefix for 60 s; the PR path never does", async () => {
  const calls = { tree: 0, file: 0 };
  const client = {
    listYamlFiles: async () => { calls.tree++; return ["apps/dev/a/release.yaml"]; },
    getFile: async () => { calls.file++; return { content: "kind: HelmRelease", sha: "s" }; },
  };
  let now = 1_000_000;
  const backend = githubBackend(client as never, { branch: "main", pathPrefix: "" }, () => now);
  await Promise.all([backend.listHistoryFiles!("apps/dev"), backend.listHistoryFiles!("apps/dev"), backend.listHistoryFiles!("apps/dev")]);
  assert.deepEqual(calls, { tree: 1, file: 1 }, "concurrent history reads share one fetch");
  await backend.listCandidateFiles("apps/dev");
  assert.deepEqual(calls, { tree: 2, file: 2 }, "the PR path writes from what it read, so it always reads fresh");
  now += 61_000;
  await backend.listHistoryFiles!("apps/dev");
  assert.equal(calls.tree, 3, "expired after 60 s");
});

test("githubBackend: a failed history read is not remembered", async () => {
  let fail = true;
  const client = {
    listYamlFiles: async () => { if (fail) throw new Error("GitHub 502"); return []; },
    getFile: async () => ({ content: "", sha: "" }),
  };
  const backend = githubBackend(client as never, { branch: "main", pathPrefix: "" }, () => 0);
  await assert.rejects(backend.listHistoryFiles!("p"));
  fail = false;
  assert.deepEqual(await backend.listHistoryFiles!("p"), []);
});

test("runHistory reads through listHistoryFiles when the backend has it", async () => {
  const seen: string[] = [];
  const noWrite = async (): Promise<never> => { throw new Error("no writes"); };
  const backend: GitOpsBackend = {
    listCandidateFiles: async () => { seen.push("fresh"); return []; },
    listHistoryFiles: async () => { seen.push("shared"); return []; },
    listCommits: async () => [], fileSha: noWrite, createBranch: noWrite, putFile: noWrite, openPr: noWrite,
  };
  await runHistory({ requestId: "r", op: "history", helmRelease: { name: "api", namespace: "x" }, since: "2026-10-07T00:00:00Z" }, backend);
  assert.deepEqual(seen, ["shared"]);
});
