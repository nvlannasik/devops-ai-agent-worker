import { test } from "node:test";
import assert from "node:assert/strict";
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { withSqsConsumerSpan } from "./sqs.js";

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
trace.setGlobalTracerProvider(provider);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

test("a message carrying traceparent is processed as a CONSUMER child of the sender", async () => {
  exporter.reset();
  const value = await withSqsConsumerSpan("llm request", { traceparent: { DataType: "String", StringValue: `00-${TRACE}-${SPAN}-01` } }, async () => {
    assert.ok(trace.getActiveSpan(), "fn runs inside the consumer span");
    return 42;
  });
  assert.equal(value, 42);
  const [s] = exporter.getFinishedSpans();
  assert.equal(s!.name, "llm request");
  assert.equal(s!.kind, SpanKind.CONSUMER);
  assert.equal(s!.spanContext().traceId, TRACE);
  assert.equal(s!.parentSpanContext?.spanId, SPAN);
  assert.equal(s!.attributes["messaging.system"], "aws_sqs");
});

test("a message without traceparent starts a new root trace and is still processed", async () => {
  exporter.reset();
  assert.equal(await withSqsConsumerSpan("llm request", undefined, async () => "done"), "done");
  const [s] = exporter.getFinishedSpans();
  assert.equal(s!.parentSpanContext, undefined);
  assert.notEqual(s!.spanContext().traceId, TRACE);
});

test("a handler that throws marks the span ERROR and rejects with the same error", async () => {
  exporter.reset();
  const boom = new Error("tool failed");
  await assert.rejects(withSqsConsumerSpan("llm request", undefined, async () => { throw boom; }), (e) => e === boom);
  assert.equal(exporter.getFinishedSpans()[0]!.status.code, SpanStatusCode.ERROR);
});
