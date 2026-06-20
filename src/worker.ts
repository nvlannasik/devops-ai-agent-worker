import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import { resolveQueueUrl, ensureRedrivePolicy } from "./sqs.js";
import { parseSqsRequest } from "./message.js";
import { callLLM } from "./llm.js";
import logger from "./logger.js";
import type { SQSResponse } from "./types.js";

const sqs = new SQSClient({
  region: config.sqs.region,
  // bound every SQS call so a hung request can't freeze the poll loop; requestTimeout
  // must exceed the long-poll wait so normal empty receives aren't cut short
  requestHandler: {
    connectionTimeout: 5000,
    requestTimeout: (config.sqs.pollWaitSeconds + 15) * 1000,
  },
  maxAttempts: 3,
});

// extend visibility every N seconds to prevent receipt handle expiry during long LLM calls
const VISIBILITY_EXTENSION_SEC = 120;
const VISIBILITY_EXTEND_INTERVAL_MS = 90_000; // extend every 90s, well before 120s window expires

async function extendVisibility(queueUrl: string, receiptHandle: string, requestId: string): Promise<void> {
  try {
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: VISIBILITY_EXTENSION_SEC,
    }));
    logger.debug(`Extended visibility for requestId=${requestId}`);
  } catch (err) {
    logger.warn(`Failed to extend visibility for requestId=${requestId}: ${err}`);
  }
}

function startVisibilityExtender(queueUrl: string, receiptHandle: string, requestId: string): NodeJS.Timeout {
  return setInterval(() => extendVisibility(queueUrl, receiptHandle, requestId), VISIBILITY_EXTEND_INTERVAL_MS);
}

interface QueueUrls {
  request: string;
  response: string;
  dlq: string;
}

async function resolveQueues(): Promise<QueueUrls> {
  logger.info("Resolving queue URLs...");
  const [request, response, dlq] = await Promise.all([
    resolveQueueUrl(sqs, config.sqs.requestQueueName, config.sqs.visibilityTimeoutSeconds),
    resolveQueueUrl(sqs, config.sqs.responseQueueName),
    resolveQueueUrl(sqs, config.sqs.requestDlqName),
  ]);
  logger.info(`Request:  ${request}`);
  logger.info(`Response: ${response}`);
  logger.info(`DLQ:      ${dlq}`);

  // Best-effort: the RedrivePolicy is an optional DLQ backstop. A missing
  // GetQueueAttributes/SetQueueAttributes permission (or any error here) must NOT
  // crash-loop the worker — message processing does not depend on it.
  try {
    await ensureRedrivePolicy(sqs, request, dlq, config.sqs.maxReceiveCount);
    logger.info(`RedrivePolicy: request → DLQ after ${config.sqs.maxReceiveCount} receives`);
  } catch (err) {
    logger.warn(`Could not set RedrivePolicy (continuing without it): ${err instanceof Error ? err.message : err}`);
  }

  return { request, response, dlq };
}

// Forward a malformed/poison message to the DLQ under a synthetic id (we have no
// requestId to use for the FIFO group/dedup), so it can be inspected but never
// retried against the LLM.
async function deadLetterRaw(dlqUrl: string, body: string): Promise<void> {
  const id = `malformed-${randomUUID()}`;
  await sqs.send(new SendMessageCommand({
    QueueUrl: dlqUrl,
    MessageBody: body,
    MessageGroupId: id,
    MessageDeduplicationId: id,
  }));
}

async function processMessage(body: string, receiptHandle: string, queues: QueueUrls): Promise<void> {
  // Validate before doing anything else. A message we can't parse (or that has no
  // requestId) can never be processed — route it to the DLQ and delete it so it
  // isn't redelivered forever (a "poison pill"). JSON.parse used to run outside any
  // try/catch, so a corrupt body threw and the message was never deleted.
  const req = parseSqsRequest(body);
  if (!req) {
    logger.error("Malformed message (unparseable or missing requestId) — routing to DLQ and dropping");
    await deadLetterRaw(queues.dlq, body);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queues.request, ReceiptHandle: receiptHandle }));
    return;
  }

  logger.info(`Processing requestId=${req.requestId}`);

  // extend immediately so we don't hit the default 30s queue visibility timeout
  await extendVisibility(queues.request, receiptHandle, req.requestId);

  // then keep extending periodically for long LLM calls
  const extender = startVisibilityExtender(queues.request, receiptHandle, req.requestId);

  let response: SQSResponse;
  try {
    const llmResponse = await callLLM(req.messages, req.tools, req.systemPrompt);
    response = { requestId: req.requestId, response: llmResponse };
    logger.info(`Done requestId=${req.requestId} stop=${llmResponse.stopReason} out=${llmResponse.usage?.outputTokens ?? "?"}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`LLM error requestId=${req.requestId}: ${error}`);

    await sqs.send(new SendMessageCommand({
      QueueUrl: queues.dlq,
      MessageBody: body,
      MessageGroupId: req.requestId,
      MessageDeduplicationId: `dlq-${req.requestId}`,
    }));
    logger.warn(`Sent requestId=${req.requestId} to DLQ`);

    response = { requestId: req.requestId, error };
  } finally {
    clearInterval(extender);
  }

  await Promise.all([
    // publish response (success or error) so agent is not left waiting
    sqs.send(new SendMessageCommand({
      QueueUrl: queues.response,
      MessageBody: JSON.stringify(response),
      MessageGroupId: req.requestId,
      MessageDeduplicationId: req.requestId,
    })),
    // delete processed request
    sqs.send(new DeleteMessageCommand({
      QueueUrl: queues.request,
      ReceiptHandle: receiptHandle,
    })),
  ]);
  // logged AFTER the publish so "reply sent" is observable — "Done" above is only
  // "LLM finished", before the response actually reaches the response queue
  logger.info(`Replied requestId=${req.requestId} (${response.error ? "error" : "ok"})`);
}

export async function startWorker(signal: AbortSignal): Promise<void> {
  const queues = await resolveQueues();
  const maxConcurrency = config.sqs.maxConcurrency;
  logger.info(`Worker started — polling ${config.sqs.requestQueueName} (max concurrency ${maxConcurrency})`);

  // Process messages as independent in-flight tasks instead of awaiting a whole
  // batch. A slow LLM call holds one slot but never blocks the loop from pulling
  // and starting other requests — the previous `await Promise.all(batch)` stalled
  // pickup for as long as the slowest message in the batch took.
  const inFlight = new Set<Promise<void>>();

  while (!signal.aborted) {
    // no free slot — wait for one to open before polling for more work
    if (inFlight.size >= maxConcurrency) {
      await Promise.race(inFlight);
      continue;
    }

    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.request,
          MaxNumberOfMessages: Math.min(config.sqs.maxMessages, maxConcurrency - inFlight.size, 10), // SQS hard cap is 10
          WaitTimeSeconds: config.sqs.pollWaitSeconds,
        }),
        { abortSignal: signal },
      );

      const messages = result.Messages ?? [];
      if (messages.length === 0) continue;

      logger.debug(`Received ${messages.length} message(s) (in-flight ${inFlight.size})`);
      for (const msg of messages) {
        const task = processMessage(msg.Body!, msg.ReceiptHandle!, queues)
          .catch((err) => { logger.error(`processMessage failed: ${err instanceof Error ? err.message : err}`); })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    } catch (err) {
      if (signal.aborted) break;
      logger.error(`Poll error: ${err} — retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // graceful drain — let in-flight LLM calls finish and publish their responses
  if (inFlight.size > 0) {
    logger.info(`Draining ${inFlight.size} in-flight message(s) before shutdown...`);
    await Promise.allSettled(inFlight);
  }
  logger.info("Worker stopped");
}
