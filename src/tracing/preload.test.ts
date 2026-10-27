import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The ESM trap (devops-sample-apps, 2026-10-27): started from index.ts the SDK patches nothing, because
// an ESM entry's imports run before its body. Only a real child process started with
// `node --import <preload>` proves the preload works, so this runs one against a fake OTLP receiver.
// Needs the build: `npm run build && npm test`.
const PRELOAD = fileURLToPath(new URL("../../dist/src/tracing/preload.js", import.meta.url));
const INDEX = pathToFileURL(fileURLToPath(new URL("../../dist/src/tracing/index.js", import.meta.url))).href;

// The worker calls the private LLM and GitHub with the undici PACKAGE, not only global fetch, so the
// app makes one call each way and both must come back as CLIENT spans.
const APP = `import * as http from "node:http";
  import { request } from ${JSON.stringify(import.meta.resolve("undici"))};
  import { activeTracing } from ${JSON.stringify(INDEX)};
  const srv = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  const body = await (await fetch(base + "/api/v1/query?query=up")).text();
  await (await request(base + "/v1/chat/completions")).body.text();
  srv.close();
  await activeTracing()?.shutdown();
  console.log("APP:" + body);`;

async function runChild(endpoint: string): Promise<{ code: number | null; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "otel-worker-"));
  const app = join(dir, "app.mjs");
  writeFileSync(app, APP);
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(process.execPath, ["--import", PRELOAD, app], {
      env: { ...process.env, OTEL_SERVICE_NAME: "llm-worker", OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, NODE_ENV: "production" },
    });
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("with the preload, an ESM server and its fetch are one trace, and the query string never leaves", async () => {
  const bodies: string[] = [];
  const receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/v1/traces") bodies.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const { code, out } = await runChild(`http://127.0.0.1:${(receiver.address() as { port: number }).port}`);
  receiver.close();
  assert.equal(code, 0);
  assert.match(out, /APP:ok/);

  const spans = bodies.flatMap((raw) =>
    (JSON.parse(raw).resourceSpans as any[]).flatMap((rs) => {
      const svc = rs.resource.attributes.find((a: any) => a.key === "service.name")?.value.stringValue;
      return rs.scopeSpans.flatMap((ss: any) => ss.spans.map((s: any) => ({ ...s, svc })));
    })
  );
  const server = spans.find((s) => s.kind === 2);
  const client = spans.find((s) => s.kind === 3);
  assert.equal(spans.filter((s) => s.kind === 3).length, 2, "a CLIENT span for fetch and one for undici.request");
  assert.ok(server, "a SERVER span from node:http imported as an ESM namespace");
  assert.ok(client, "a CLIENT span from fetch");
  assert.equal(server.svc, "llm-worker");
  assert.equal(server.traceId, client.traceId, "fetch carried traceparent");
  assert.ok(!bodies.join("").includes("query=up"), "the PromQL-shaped query string was redacted before export");
});

test("an unreachable endpoint costs nothing: the app runs and exits cleanly", async () => {
  const { code, out } = await runChild("http://127.0.0.1:9");
  assert.equal(code, 0);
  assert.match(out, /APP:ok/);
});

// The bug class behind the agent's 2026-10-27 crashloop is "some dependency breaks when the loader
// hook wraps it". This loads the worker's real module graph under the preload.
test("the worker's own module graph loads under the preload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "otel-graph-"));
  const app = join(dir, "graph.mjs");
  const dist = new URL("../../dist/", import.meta.url);
  writeFileSync(
    app,
    ["src/worker.js"].map((m) => `await import(${JSON.stringify(new URL(m, dist).href)});`).join("\n") + `\nconsole.log("GRAPH:ok");`
  );
  const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
    let text = "";
    const child = spawn(process.execPath, ["--import", PRELOAD, app], {
      env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" },
    });
    child.stdout.on("data", (c) => (text += c));
    child.stderr.on("data", (c) => (text += c));
    child.on("exit", (code) => resolve({ code, text }));
  });
  assert.equal(out.code, 0, out.text.slice(-800));
  assert.match(out.text, /GRAPH:ok/);
});
