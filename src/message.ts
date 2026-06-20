import type { SQSRequest } from "./types.js";

/**
 * Parse + validate an incoming SQS request body.
 *
 * Returns null when the body is unparseable JSON or lacks a usable `requestId`.
 * Such a "poison" message can never be processed, so the caller must dead-letter
 * and delete it instead of letting it be redelivered forever. We only require
 * `requestId` here (it's needed to route a reply/DLQ entry); a parseable message
 * with a bad `messages`/`tools` payload is left to fail in callLLM, which still
 * sends an error response the waiting agent can see.
 */
export function parseSqsRequest(body: string): SQSRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const requestId = (parsed as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.length === 0) return null;
  return parsed as SQSRequest;
}
