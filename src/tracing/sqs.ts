import { ROOT_CONTEXT, SpanKind, SpanStatusCode, propagation, trace } from "@opentelemetry/api";
import type { MessageAttributeValue } from "@aws-sdk/client-sqs";

// W3C context rides on SQS as message attributes, never in the body: the bodies are cross-repo
// contracts (workspace CLAUDE.md) and must stay byte-identical. Explicit rather than
// @opentelemetry/instrumentation-aws-sdk — see the plan's deviation note.
const KEYS = ["traceparent", "tracestate"] as const;

/**
 * Runs one received message's handling inside a CONSUMER span whose parent is the sender's span.
 * No traceparent (a sender not yet upgraded, a hand-sent probe) → a new root trace; the message is
 * processed exactly as before either way. The error's text is not recorded: a tool's error can
 * quote what it read.
 */
export async function withSqsConsumerSpan<T>(
  name: string,
  attrs: Record<string, MessageAttributeValue> | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const carrier: Record<string, string> = {};
  for (const k of KEYS) {
    const v = attrs?.[k]?.StringValue;
    if (v) carrier[k] = v;
  }
  const parent = propagation.extract(ROOT_CONTEXT, carrier);
  return trace.getTracer("sqs-consumer").startActiveSpan(
    name,
    { kind: SpanKind.CONSUMER, attributes: { "messaging.system": "aws_sqs", "messaging.operation.type": "process" } },
    parent,
    async (span) => {
      try {
        return await fn();
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}
