import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  CreateQueueCommand,
  SetQueueAttributesCommand,
  QueueDoesNotExist,
} from "@aws-sdk/client-sqs";

const FIFO_ATTRS = {
  FifoQueue: "true",
  ContentBasedDeduplication: "false",
};

export async function resolveQueueUrl(
  sqs: SQSClient,
  queueName: string,
  visibilityTimeoutSeconds?: number
): Promise<string> {
  const isFifo = queueName.endsWith(".fifo");
  const visibilityAttr = visibilityTimeoutSeconds
    ? { VisibilityTimeout: String(visibilityTimeoutSeconds) }
    : {};

  let queueUrl: string;

  try {
    const res = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    queueUrl = res.QueueUrl!;

    // ensure visibility timeout is set correctly on existing queue
    if (visibilityTimeoutSeconds) {
      await sqs.send(new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: visibilityAttr,
      }));
    }
  } catch (err) {
    if (!(err instanceof QueueDoesNotExist)) throw err;

    const res = await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        ...(isFifo ? FIFO_ATTRS : {}),
        ...visibilityAttr,
      },
    }));
    queueUrl = res.QueueUrl!;
  }

  return queueUrl;
}

/**
 * Point the request queue's RedrivePolicy at the DLQ so SQS itself moves a
 * message aside after `maxReceiveCount` deliveries. This is the backstop for any
 * message that is received but never deleted (worker crash mid-process, a delete
 * that fails, a bug) — without it such a message is redelivered until retention.
 * Idempotent: safe to run on every startup.
 */
export async function ensureRedrivePolicy(
  sqs: SQSClient,
  requestQueueUrl: string,
  dlqUrl: string,
  maxReceiveCount: number
): Promise<void> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: dlqUrl,
    AttributeNames: ["QueueArn"],
  }));
  const dlqArn = Attributes?.QueueArn;
  if (!dlqArn) return; // cannot set the policy without the DLQ ARN

  await sqs.send(new SetQueueAttributesCommand({
    QueueUrl: requestQueueUrl,
    Attributes: {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount }),
    },
  }));
}
