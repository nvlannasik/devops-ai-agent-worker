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
