import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmptyTokenExhaustion, toOpenAIMessages } from "./llm.js";
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

// a tool round-trip must never reach the model as stringified JSON — that is what made a
// small model echo `[{"type":"tool_use",...}]` back as its answer
test("content blocks become native tool_calls / tool messages", () => {
  const out = toOpenAIMessages([
    { role: "user", content: "investigate" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking pods" },
        { type: "tool_use", id: "call_1", name: "k8s_list_pods", input: { namespace: "sarang-tani" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "no pods" }] },
  ]);

  assert.deepEqual(out, [
    { role: "user", content: "investigate" },
    {
      role: "assistant",
      content: "checking pods",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "k8s_list_pods", arguments: '{"namespace":"sarang-tani"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "no pods" },
  ]);
  assert.equal(JSON.stringify(out).includes('\\"type\\"'), false); // no nested JSON anywhere
});

test("tool results are emitted before new user text in the same turn", () => {
  const out = toOpenAIMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "the label is app.kubernetes.io/name" },
        { type: "tool_result", tool_use_id: "call_1", content: "no pods" },
      ],
    },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["tool", "user"]);
});
