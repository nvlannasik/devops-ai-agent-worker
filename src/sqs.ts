import { SQSClient, GetQueueUrlCommand, CreateQueueCommand, QueueDoesNotExist } from "@aws-sdk/client-sqs";

const FIFO_ATTRS = {
  FifoQueue: "true",
  ContentBasedDeduplication: "false",
};

export async function resolveQueueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  try {
    const res = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    return res.QueueUrl!;
  } catch (err) {
    if (!(err instanceof QueueDoesNotExist)) throw err;

    const isFifo = queueName.endsWith(".fifo");
    const res = await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: isFifo ? FIFO_ATTRS : undefined,
    }));
    return res.QueueUrl!;
  }
}
