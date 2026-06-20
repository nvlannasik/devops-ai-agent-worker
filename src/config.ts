import "dotenv/config";

export const config = {
  sqs: {
    region: process.env.AWS_REGION ?? "ap-southeast-1",
    requestQueueName: process.env.SQS_REQUEST_QUEUE_NAME ?? "llm-request.fifo",
    responseQueueName: process.env.SQS_RESPONSE_QUEUE_NAME ?? "llm-response.fifo",
    requestDlqName: process.env.SQS_REQUEST_DLQ_NAME ?? "llm-request-dlq.fifo",
    pollWaitSeconds: parseInt(process.env.SQS_POLL_WAIT_SECONDS ?? "10"),
    maxMessages: parseInt(process.env.SQS_MAX_MESSAGES ?? "5"),
    // max messages processed concurrently — the poll loop keeps pulling new work up
    // to this cap so one slow LLM call can't block pickup of other requests
    maxConcurrency: parseInt(process.env.SQS_MAX_CONCURRENCY ?? "10"),
    visibilityTimeoutSeconds: parseInt(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? "300"),
    // after this many receives without a successful delete, SQS moves the message to the DLQ itself
    maxReceiveCount: parseInt(process.env.SQS_MAX_RECEIVE_COUNT ?? "3"),
  },
  llm: {
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY ?? "none",
    model: process.env.LLM_MODEL!,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "8096"),
    useMaxCompletionTokens: process.env.LLM_USE_MAX_COMPLETION_TOKENS === "true",
    temperature: process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined,
    topP: process.env.LLM_TOP_P ? parseFloat(process.env.LLM_TOP_P) : undefined,
    seed: process.env.LLM_SEED ? parseInt(process.env.LLM_SEED) : undefined,
  },
};
