import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Separate file because the request shape can only be asserted against a real socket, and
// config/anthropic.ts read their env at import time — so the stub has to exist FIRST.
// node:test gives each file its own process, so setting env here affects nothing else.
let seen: { headers: http.IncomingHttpHeaders; url?: string; body: Record<string, unknown> } | undefined;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen = { headers: req.headers, url: req.url, body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };

process.env.LLM_API_FORMAT = "anthropic";
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
process.env.LLM_API_KEY = "sk-test";
process.env.LLM_MODEL = "claude-opus-5";
process.env.LLM_SOCKS_PROXY = "";

const { anthropicRequest } = await import("./anthropic.js");

test("the request matches the Messages API wire shape", async () => {
  const out = await anthropicRequest(
    [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "no pods" }] }],
    [{ name: "k8s_list_pods", description: "list pods", inputSchema: { type: "object", properties: {} } }],
    "you are a devops agent",
    4096
  );

  assert.ok(seen, "stub never received a request");
  assert.equal(seen.url, "/v1/messages");
  assert.equal(seen.headers["x-api-key"], "sk-test");
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  // NOT Authorization: Bearer — that is the OpenAI path's scheme
  assert.equal(seen.headers.authorization, undefined);

  // system is a top-level parameter here, never a role:"system" message
  assert.equal(seen.body.system, "you are a devops agent");
  assert.equal(seen.body.max_tokens, 4096);
  assert.deepEqual(seen.body.messages, [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "no pods" }] },
  ]);

  // input_schema, and no {type:"function", function:{…}} envelope
  assert.deepEqual(seen.body.tools, [
    { name: "k8s_list_pods", description: "list pods", input_schema: { type: "object", properties: {} } },
  ]);

  assert.deepEqual(out.content, [{ type: "text", text: "ok" }]);
  assert.equal(out.stopReason, "end_turn");
});

test("tools are omitted entirely when the agent disables them", async () => {
  await anthropicRequest([{ role: "user", content: "hi" }], [], "sys", 1024);
  assert.ok(seen);
  assert.equal("tools" in seen.body, false);
});

test("a non-2xx carries the backend's reason, not just a status", async () => {
  server.close();
  await assert.rejects(
    () => anthropicRequest([{ role: "user", content: "hi" }], [], "sys", 1024),
    (err: Error) => err.message.length > 0
  );
});

test.after(() => server.close());
