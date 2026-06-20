import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSqsRequest } from "./message.js";

test("parses a well-formed request", () => {
  const body = JSON.stringify({ requestId: "abc", messages: [], tools: [], systemPrompt: "hi" });
  const req = parseSqsRequest(body);
  assert.ok(req);
  assert.equal(req!.requestId, "abc");
});

test("returns null for unparseable JSON (poison message)", () => {
  assert.equal(parseSqsRequest("{not json"), null);
  assert.equal(parseSqsRequest(""), null);
});

test("returns null when requestId is missing or empty", () => {
  assert.equal(parseSqsRequest(JSON.stringify({ messages: [] })), null);
  assert.equal(parseSqsRequest(JSON.stringify({ requestId: "" })), null);
  assert.equal(parseSqsRequest(JSON.stringify({ requestId: 123 })), null);
});

test("returns null for non-object JSON", () => {
  assert.equal(parseSqsRequest("42"), null);
  assert.equal(parseSqsRequest("null"), null);
  assert.equal(parseSqsRequest('"a string"'), null);
});

test("accepts a request with a bad payload as long as requestId is present", () => {
  // callLLM will fail and send an error response keyed by requestId — the agent
  // is notified, so we must NOT treat this as a poison message
  const req = parseSqsRequest(JSON.stringify({ requestId: "xyz" }));
  assert.ok(req);
  assert.equal(req!.requestId, "xyz");
});
