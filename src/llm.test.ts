import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmptyTokenExhaustion } from "./llm.js";
import type { LLMResponse } from "./types.js";

const res = (stopReason: LLMResponse["stopReason"], content: LLMResponse["content"]): LLMResponse =>
  ({ content, stopReason }) as LLMResponse;

test("empty content + max_tokens triggers the retry", () => {
  assert.equal(isEmptyTokenExhaustion(res("max_tokens", [])), true);
});

test("a partial answer cut off by the limit is NOT retried", () => {
  assert.equal(isEmptyTokenExhaustion(res("max_tokens", [{ type: "text", text: "partial..." }])), false);
});

test("normal completions are never retried", () => {
  assert.equal(isEmptyTokenExhaustion(res("end_turn", [{ type: "text", text: "ok" }])), false);
  assert.equal(isEmptyTokenExhaustion(res("tool_use", [{ type: "tool_use", id: "1", name: "t", input: {} }])), false);
});
