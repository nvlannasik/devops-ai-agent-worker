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
import { parseGitOpsRequest, type GitOpsResponse } from "./gitops/message.js";
import { runGitOps, githubBackend } from "./gitops/handler.js";
import { GitHubClient } from "./gitops/github-client.js";

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

// GitOps PR-flow message: parse → run the op → publish the result on the SHARED response
// queue routed by requestId. Fast (no long LLM call), so no visibility extender. Business
// refusals travel in `response` (payload.ok=false); only exceptions use the envelope `error`.
async function processGitOpsMessage(body: string, receiptHandle: string, queueUrl: string, responseUrl: string, backend: ReturnType<typeof githubBackend>): Promise<void> {
  const req = parseGitOpsRequest(body);
  if (!req) {
    logger.error("Malformed gitops message (unparseable / missing fields) — dropping");
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    return;
  }
  logger.info(`GitOps ${req.op} requestId=${req.requestId} (${req.action} ${req.helmRelease.namespace}/${req.helmRelease.name})`);

  let response: GitOpsResponse;
  try {
    response = { requestId: req.requestId, response: await runGitOps(req, backend) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`GitOps error requestId=${req.requestId}: ${error}`);
    response = { requestId: req.requestId, error };
  }

  await Promise.all([
    sqs.send(new SendMessageCommand({ QueueUrl: responseUrl, MessageBody: JSON.stringify(response), MessageGroupId: req.requestId, MessageDeduplicationId: req.requestId })),
    sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle })),
  ]);
  logger.info(`GitOps replied requestId=${req.requestId} (${response.error ? "error" : "ok"})`);
}

// Generic receive/dispatch/drain loop, shared by the LLM and GitOps queues. `handle` owns
// everything per message (parse, process, publish, delete) — this only manages polling,
// the concurrency cap, in-flight bookkeeping, and the graceful drain.
async function pollLoop(
  signal: AbortSignal,
  queueUrl: string,
  label: string,
  maxConcurrency: number,
  handle: (body: string, receiptHandle: string) => Promise<void>
): Promise<void> {
  logger.info(`Polling ${label} (max concurrency ${maxConcurrency})`);
  const inFlight = new Set<Promise<void>>();

  while (!signal.aborted) {
    if (inFlight.size >= maxConcurrency) {
      await Promise.race(inFlight);
      continue;
    }
    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(config.sqs.maxMessages, maxConcurrency - inFlight.size, 10), // SQS hard cap is 10
          WaitTimeSeconds: config.sqs.pollWaitSeconds,
        }),
        { abortSignal: signal }
      );
      const messages = result.Messages ?? [];
      if (messages.length === 0) continue;

      logger.debug(`[${label}] received ${messages.length} message(s) (in-flight ${inFlight.size})`);
      for (const msg of messages) {
        const task = handle(msg.Body!, msg.ReceiptHandle!)
          .catch((err) => { logger.error(`[${label}] handler failed: ${err instanceof Error ? err.message : err}`); })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    } catch (err) {
      if (signal.aborted) break;
      logger.error(`[${label}] poll error: ${err} — retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (inFlight.size > 0) {
    logger.info(`Draining ${inFlight.size} in-flight ${label} message(s) before shutdown...`);
    await Promise.allSettled(inFlight);
  }
}

export async function startWorker(signal: AbortSignal): Promise<void> {
  const queues = await resolveQueues();
  const maxConcurrency = config.sqs.maxConcurrency;

  const loops: Promise<void>[] = [
    pollLoop(signal, queues.request, config.sqs.requestQueueName, maxConcurrency, (body, rh) => processMessage(body, rh, queues)),
  ];

  // Second consumer for the GitOps PR-flow (DESIGN_gitops_pr_remediation.md), only when a
  // GitHub App + repo are configured. Replies on the SAME response queue, routed by requestId.
  if (config.gitops.enabled) {
    const gitopsQueue = await resolveQueueUrl(sqs, config.gitops.requestQueueName, config.sqs.visibilityTimeoutSeconds);
    logger.info(`GitOps PR-flow enabled — repo ${config.gitops.repo} via ${config.gitops.apiUrl}`);
    const backend = githubBackend(new GitHubClient(config.gitops), { branch: config.gitops.branch, pathPrefix: config.gitops.pathPrefix });
    loops.push(pollLoop(signal, gitopsQueue, config.gitops.requestQueueName, maxConcurrency, (body, rh) => processGitOpsMessage(body, rh, gitopsQueue, queues.response, backend)));
  }

  await Promise.all(loops);
  logger.info("Worker stopped");
}
