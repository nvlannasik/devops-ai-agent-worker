import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitOpsRequest } from "./message.js";

const valid = {
  requestId: "req-1",
  op: "dry_run",
  helmRelease: { name: "ingress", namespace: "nginx-ingress" },
  action: "set_image",
  changes: [{ field: "image", from: "a:1", to: "a:2" }],
};

test("parseGitOpsRequest accepts a well-formed request", () => {
  const r = parseGitOpsRequest(JSON.stringify(valid));
  assert.ok(r && r.requestId === "req-1" && r.op === "dry_run" && r.action === "set_image");
});

test("parseGitOpsRequest rejects malformed / invalid messages (poison → null)", () => {
  assert.equal(parseGitOpsRequest("not json"), null);
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...valid, requestId: "" })), null);
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...valid, op: "delete_repo" })), null); // unknown op
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...valid, action: "rm_rf" })), null); // unknown action
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...valid, helmRelease: { name: "x" } })), null); // missing namespace
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...valid, changes: "nope" })), null); // changes not an array
});

test("history needs no action or changes, but does need a parseable `since`", () => {
  const h = parseGitOpsRequest(JSON.stringify({ requestId: "r", op: "history", helmRelease: { name: "a", namespace: "b" }, since: "2026-10-08T00:00:00Z" }));
  assert.ok(h && h.op === "history" && h.since === "2026-10-08T00:00:00Z");
  assert.equal(parseGitOpsRequest(JSON.stringify({ requestId: "r", op: "history", helmRelease: { name: "a", namespace: "b" }, since: "yesterday" })), null);
  assert.equal(parseGitOpsRequest(JSON.stringify({ requestId: "r", op: "history", helmRelease: { name: "a", namespace: "b" } })), null);
  // the change ops are still strict
  assert.equal(parseGitOpsRequest(JSON.stringify({ requestId: "r", op: "dry_run", helmRelease: { name: "a", namespace: "b" }, since: "2026-10-08T00:00:00Z" })), null);
});

test("revert_pr needs a hex sha; dryRun is an optional boolean", () => {
  const base = { requestId: "r", op: "revert_pr", helmRelease: { name: "a", namespace: "b" } };
  const ok = parseGitOpsRequest(JSON.stringify({ ...base, sha: "abc1234", dryRun: true }));
  assert.ok(ok && ok.op === "revert_pr" && ok.sha === "abc1234");
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...base, sha: "HEAD~1" })), null);
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...base })), null);
  assert.equal(parseGitOpsRequest(JSON.stringify({ ...base, sha: "abc1234", dryRun: "yes" })), null);
});
