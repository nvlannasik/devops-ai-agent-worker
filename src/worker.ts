import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { config } from "./config.js";
import { resolveQueueUrl } from "./sqs.js";
import { callLLM } from "./llm.js";
import logger from "./logger.js";
import type { SQSRequest, SQSResponse } from "./types.js";

const sqs = new SQSClient({ region: config.sqs.region });

interface QueueUrls {
  request: string;
  response: string;
  dlq: string;
}

async function resolveQueues(): Promise<QueueUrls> {
  logger.info("Resolving queue URLs...");
  const [request, response, dlq] = await Promise.all([
    resolveQueueUrl(sqs, config.sqs.requestQueueName),
    resolveQueueUrl(sqs, config.sqs.responseQueueName),
    resolveQueueUrl(sqs, config.sqs.requestDlqName),
  ]);
  logger.info(`Request:  ${request}`);
  logger.info(`Response: ${response}`);
  logger.info(`DLQ:      ${dlq}`);
  return { request, response, dlq };
}

async function processMessage(body: string, receiptHandle: string, queues: QueueUrls): Promise<void> {
  const req = JSON.parse(body) as SQSRequest;
  logger.info(`Processing requestId=${req.requestId}`);

  let response: SQSResponse;
  try {
    const llmResponse = await callLLM(req.messages, req.tools, req.systemPrompt);
    response = { requestId: req.requestId, response: llmResponse };
    logger.info(`Done requestId=${req.requestId} stop=${llmResponse.stopReason} out=${llmResponse.usage?.outputTokens ?? "?"}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`LLM error requestId=${req.requestId}: ${error}`);

    // send original message to DLQ before publishing error response
    await sqs.send(new SendMessageCommand({
      QueueUrl: queues.dlq,
      MessageBody: body,
      MessageGroupId: req.requestId,
      MessageDeduplicationId: `dlq-${req.requestId}`,
    }));
    logger.warn(`Sent requestId=${req.requestId} to DLQ`);

    response = { requestId: req.requestId, error };
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
}

export async function startWorker(signal: AbortSignal): Promise<void> {
  const queues = await resolveQueues();
  logger.info(`Worker started — polling ${config.sqs.requestQueueName}`);

  while (!signal.aborted) {
    try {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queues.request,
        MaxNumberOfMessages: config.sqs.maxMessages,
        WaitTimeSeconds: config.sqs.pollWaitSeconds,
      }));

      const messages = result.Messages ?? [];
      if (messages.length === 0) continue;

      logger.debug(`Received ${messages.length} message(s)`);
      await Promise.all(messages.map((msg) => processMessage(msg.Body!, msg.ReceiptHandle!, queues)));
    } catch (err) {
      if (signal.aborted) break;
      logger.error(`Poll error: ${err} — retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  logger.info("Worker stopped");
}
