import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText, parseReply, toAgentBuilderPrompt } from "./agent-builder.js";
import type { ToolDefinition } from "./types.js";

const TOOLS: ToolDefinition[] = [
  {
    name: "k8s_describe_pod",
    description: "pod state, containers, limits, events",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string" }, name: { type: "string" } },
      required: ["namespace", "name"],
    },
  },
  {
    name: "k8s_get_pod_logs",
    description: "container logs",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        name: { type: "string" },
        container: { type: "string" },
        previous: { type: "boolean" },
      },
      required: ["namespace", "name"],
    },
  },
];

// The exact bytes the agent builder returned for probe L1 (docs/examples/loop/l1-round1.txt):
// seven tool calls, and the seventh lost its opening brace.
const L1_REAL_TEXT = "{\"tool_calls\":[{\"id\":\"c1\",\"name\":\"k8s_describe_pod\",\"args\":{\"namespace\":\"payment\",\"name\":\"payment-api-7d9f6c4b8-xk2p9\"}},{\"id\":\"c2\",\"name\":\"k8s_get_pod_logs\",\"args\":{\"namespace\":\"payment\",\"name\":\"payment-api-7d9f6c4b8-xk2p9\",\"container\":\"api\",\"previous\":true,\"tail_lines\":100}},{\"id\":\"c3\",\"name\":\"k8s_list_pods\",\"args\":{\"namespace\":\"payment\"}},{\"id\":\"c4\",\"name\":\"prometheus_query\",\"args\":{\"query\":\"kube_pod_container_resource_requests_memory_bytes{namespace='payment',pod='payment-api-7d9f6c4b8-xk2p9',container='api'}\"}},{\"id\":\"c5\",\"name\":\"prometheus_query\",\"args\":{\"query\":\"process_resident_memory_bytes{namespace='payment',pod='payment-api-7d9f6c4b8-xk2p9',container='api'}\"}},{\"id\":\"c6\",\"name\":\"prometheus_query_range\",\"args\":{\"query\":\"rate(container_cpu_usage_seconds_total{namespace='payment',pod='payment-api-7d9f6c4b8-xk2p9',container='api'}[5m])\",\"start\":1755842400,\"end\":1755846000,\"step\":\"60\"}},\"id\":\"c7\",\"name\":\"loki_query_range\",\"args\":{\"query\":\"{namespace='payment',container='api',pod='payment-api-7d9f6c4b8-xk2p9'}\",\"start\":1755842400,\"end\":1755846000}}]}\n";

test("optional schema properties are marked with ? in the catalog signature", () => {
  const prompt = toAgentBuilderPrompt([{ role: "user", content: "hi" }], TOOLS, "sys");
  assert.match(prompt, /k8s_describe_pod\(namespace, name\) — pod state, containers, limits, events/);
  assert.match(prompt, /k8s_get_pod_logs\(namespace, name, container\?, previous\?\) — container logs/);
});

test("the system prompt leads the payload and the transcript trails it", () => {
  const prompt = toAgentBuilderPrompt([{ role: "user", content: "ALERT: OOMKilled" }], TOOLS, "You are an agent.");
  assert.ok(prompt.startsWith("You are an agent."), `payload did not start with the system prompt: ${prompt.slice(0, 40)}`);
  assert.ok(
    prompt.indexOf("=== Available tools ===") < prompt.indexOf("--- Conversation ---"),
    "the catalog must come before the transcript"
  );
  assert.match(prompt, /--- Conversation ---\nUser: ALERT: OOMKilled/);
});

// Without tools the flow has nothing to ask for, so the protocol contract is dead weight —
// and conversation mode sends no tools at all.
test("no tools means no protocol block and no catalog", () => {
  const prompt = toAgentBuilderPrompt([{ role: "user", content: "hi" }], [], "sys");
  assert.doesNotMatch(prompt, /Tool protocol/);
  assert.doesNotMatch(prompt, /Available tools/);
  assert.match(prompt, /--- Conversation ---\nUser: hi/);
});

// The flow only ever sees text, so an assistant tool_use has to go back out in the same
// shape we ask the model to produce — otherwise round 2 shows it a format it never wrote.
test("an assistant tool_use round-trips as the tool_calls JSON we ask for", () => {
  const prompt = toAgentBuilderPrompt(
    [
      { role: "user", content: "ALERT" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "k8s_describe_pod", input: { namespace: "payment" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Status: Running" }] },
    ],
    TOOLS,
    "sys"
  );
  assert.match(prompt, /Assistant: \{"tool_calls":\[\{"id":"c1","name":"k8s_describe_pod","args":\{"namespace":"payment"\}\}\]\}/);
  assert.match(prompt, /User: === Tool results ===\n\[c1 k8s_describe_pod\]\nStatus: Running/);
});

test("several tool_use blocks in one turn become one tool_calls array", () => {
  const prompt = toAgentBuilderPrompt(
    [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "k8s_describe_pod", input: {} },
          { type: "tool_use", id: "c2", name: "k8s_get_pod_logs", input: {} },
        ],
      },
    ],
    TOOLS,
    "sys"
  );
  const calls = prompt.match(/Assistant: \{"tool_calls":\[(.*)\]\}/)?.[1] ?? "";
  assert.equal(calls.split('"name"').length - 1, 2, `expected 2 calls on one line, got: ${calls}`);
});

test("extractText reads the answer out of the Langflow envelope", () => {
  const envelope = {
    session_id: "probe-1",
    outputs: [{ outputs: [{ results: { message: { text: "READY", error: false } } }] }],
  };
  assert.equal(extractText(envelope), "READY");
});

// P4 was never probed, so we do not know that failures arrive as non-2xx. If one arrives as
// HTTP 200 with error:true, the text is an error string — posting it would put it in Slack
// dressed as an RCA.
test("extractText throws when the envelope carries error:true", () => {
  const envelope = {
    outputs: [{ outputs: [{ results: { message: { text: "flow not found", error: true } } }] }],
  };
  assert.throws(() => extractText(envelope), /flow not found/);
});

test("extractText throws when the envelope has no output at all", () => {
  assert.throws(() => extractText({ outputs: [] }), /no output/i);
});

test("prose comes back as a finished answer", () => {
  const res = parseReply("*📍 Root Cause*\nThe pod was OOMKilled.");
  assert.equal(res?.stopReason, "end_turn");
  assert.deepEqual(res?.content, [{ type: "text", text: "*📍 Root Cause*\nThe pod was OOMKilled." }]);
});

test("a tool_calls reply becomes tool_use blocks", () => {
  const res = parseReply('{"tool_calls":[{"id":"x9","name":"k8s_describe_pod","args":{"namespace":"payment"}}]}');
  assert.equal(res?.stopReason, "tool_use");
  assert.deepEqual(res?.content, [
    { type: "tool_use", id: "c1", name: "k8s_describe_pod", input: { namespace: "payment" } },
  ]);
});

// L2 reused c3..c6 across rounds. Ours are positional so a repeat can never collide with a
// live tool_use/tool_result pair.
test("ids are ours, not the model's", () => {
  const res = parseReply('{"tool_calls":[{"id":"c3","name":"a","args":{}},{"id":"c3","name":"b","args":{}}]}');
  assert.deepEqual(
    res?.content.map((b) => b.id),
    ["c1", "c2"]
  );
});

test("a fenced tool_calls reply is still parsed", () => {
  const res = parseReply('```json\n{"tool_calls":[{"id":"c1","name":"a","args":{}}]}\n```');
  assert.equal(res?.stopReason, "tool_use");
});

// The recorded L1 answer: the 7th call lost its opening brace. In this schema "id" is only
// ever legal straight after {, so },"id": is unambiguous to repair.
test("the real L1 reply is repaired into all seven tool calls", () => {
  const res = parseReply(L1_REAL_TEXT);
  assert.equal(res?.stopReason, "tool_use");
  assert.equal(res?.content.length, 7);
  assert.equal(res?.content[6].name, "loki_query_range");
});

// PromQL braces are the thing both probe READMEs warn about; a repair that ate them would
// pass the count check above and still corrupt every query.
test("repair leaves PromQL label matchers intact", () => {
  const res = parseReply(L1_REAL_TEXT);
  const q = String(res?.content[5].input?.query ?? "");
  assert.match(q, /\{namespace='payment'/);
});

// null is the signal for "meant to be a tool request and is not recoverable" — the caller
// spends its one correction round on it rather than posting the wreckage.
test("an unrepairable tool request returns null", () => {
  assert.equal(parseReply('{"tool_calls":[{"id":"c1","name":'), null);
});

test("prose that merely mentions tool_calls is not mistaken for a request", () => {
  const res = parseReply("I could not use tool_calls because no tools were offered.");
  assert.equal(res?.stopReason, "end_turn");
});

// Probe L4: the reply the flow actually sent after being told its previous one was
// unparseable. The correction round is only worth a 100 s trip if this shape parses.
test("the real L4 recovery reply parses without needing a repair", () => {
  const res = parseReply("{\"tool_calls\":[{\"id\":\"c1\",\"name\":\"k8s_describe_pod\",\"args\":{\"namespace\":\"payment\",\"name\":\"payment-api-7d9f6c4b8-xk2p9\"}}]}");
  assert.equal(res?.stopReason, "tool_use");
  assert.deepEqual(res?.content, [
    { type: "tool_use", id: "c1", name: "k8s_describe_pod", input: { namespace: "payment", name: "payment-api-7d9f6c4b8-xk2p9" } },
  ]);
});
