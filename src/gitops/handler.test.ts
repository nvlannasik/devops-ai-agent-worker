import { test } from "node:test";
import assert from "node:assert/strict";
import { runGitOps, prTitle, prBody, type GitOpsBackend } from "./handler.js";
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
  assert.match(r.ok ? "" : r.reason, /not set inline/);
  assert.equal(calls.createBranch, undefined);
  assert.equal(calls.putFile, undefined);
});
