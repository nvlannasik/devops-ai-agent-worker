import { test } from "node:test";
import assert from "node:assert/strict";
import { fromAnthropicResponse, messagesEndpoint, toAnthropicContent } from "./anthropic.js";

// The whole reason this path exists: the agent's blocks ARE Anthropic blocks, so a tool
// round-trip survives without a translation layer. Same guarantee toOpenAIMessages gives.
test("content blocks pass through as native Anthropic blocks", () => {
  assert.deepEqual(
    toAnthropicContent([
      { type: "text", text: "checking pods" },
      { type: "tool_use", id: "toolu_1", name: "k8s_list_pods", input: { namespace: "sarang-tani" } },
    ]),
    [
      { type: "text", text: "checking pods" },
      { type: "tool_use", id: "toolu_1", name: "k8s_list_pods", input: { namespace: "sarang-tani" } },
    ]
  );

  assert.deepEqual(
    toAnthropicContent([{ type: "tool_result", tool_use_id: "toolu_1", content: "no pods" }]),
    [{ type: "tool_result", tool_use_id: "toolu_1", content: "no pods" }]
  );
});

test("a plain string content stays a string", () => {
  assert.equal(toAnthropicContent("investigate"), "investigate");
});

test("keys foreign to the block type are not emitted", () => {
  // ContentBlock is one loose union, so a text block can carry absent id/name/input. The API
  // 400s on unknown keys per block, so each block must be rebuilt, never spread.
  const [block] = toAnthropicContent([{ type: "text", text: "hi", id: "x", name: "y", input: {} }]) as Record<string, unknown>[];
  assert.deepEqual(Object.keys(block).sort(), ["text", "type"]);
});

test("empty text blocks are dropped but tool blocks never are", () => {
  assert.deepEqual(
    toAnthropicContent([
      { type: "text", text: "" },
      { type: "tool_use", id: "toolu_1", name: "t", input: {} },
    ]),
    [{ type: "tool_use", id: "toolu_1", name: "t", input: {} }]
  );
});

test("the response maps onto the agent's LLMResponse", () => {
  const out = fromAnthropicResponse({
    content: [
      { type: "text", text: "found it" },
      { type: "tool_use", id: "toolu_2", name: "loki_query", input: { q: "err" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
  });

  assert.equal(out.stopReason, "tool_use");
  assert.deepEqual(out.content, [
    { type: "text", text: "found it" },
    { type: "tool_use", id: "toolu_2", name: "loki_query", input: { q: "err" } },
  ]);
  // the OpenAI path hardcodes these two to 0 — here they are real
  assert.equal(out.usage?.cacheReadTokens, 5);
  assert.equal(out.usage?.cacheCreationTokens, 3);
});

test("thinking blocks are dropped — the agent has no representation for them", () => {
  const out = fromAnthropicResponse({
    content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "answer" }],
    stop_reason: "end_turn",
  });
  assert.deepEqual(out.content, [{ type: "text", text: "answer" }]);
});

test("stop_reason collapses to the three the agent knows", () => {
  assert.equal(fromAnthropicResponse({ stop_reason: "max_tokens" }).stopReason, "max_tokens");
  assert.equal(fromAnthropicResponse({ stop_reason: "stop_sequence" }).stopReason, "end_turn");
  assert.equal(fromAnthropicResponse({ stop_reason: "refusal" }).stopReason, "end_turn");
  assert.equal(fromAnthropicResponse({}).stopReason, "end_turn");
});

// max_tokens + empty content is what triggers callLLM's one automatic retry, so this mapping
// is what makes the shared retry work on this path too
test("an empty max_tokens response is representable for the retry check", () => {
  const out = fromAnthropicResponse({ content: [], stop_reason: "max_tokens" });
  assert.equal(out.stopReason, "max_tokens");
  assert.equal(out.content.length, 0);
});

test("LLM_BASE_URL works with or without a trailing /v1", () => {
  assert.equal(messagesEndpoint("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesEndpoint("https://api.anthropic.com/"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesEndpoint("http://gw.internal:8000/v1"), "http://gw.internal:8000/v1/messages");
  assert.equal(messagesEndpoint("http://gw.internal:8000/v1/"), "http://gw.internal:8000/v1/messages");
});
