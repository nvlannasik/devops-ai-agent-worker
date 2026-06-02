# Memory Bank — llm-worker

## Project Overview
SQS consumer service that bridges AI agent requests (from EKS) to a private LLM. Deployed inside the private network — only needs **outbound** access to AWS SQS. No inbound exceptions required.

## Why This Exists
`devops-ai-agent` runs on EKS and cannot reach the private LLM directly. The private network is too strict for inbound connections. Solution: event-driven bridge via SQS FIFO queues.

## Tech Stack
- **Runtime:** Node.js >= 24, TypeScript (ESM)
- **AWS SDK:** `@aws-sdk/client-sqs` v3
- **LLM:** `openai` SDK (OpenAI-compatible API)
- **Build:** `tsc` → `dist/`, dev via `tsx watch`

## Architecture

```
SQS Request Queue (FIFO)
        ↓ poll (long-polling, WaitTimeSeconds=10)
   llm-worker
        ↓ call
   Private LLM (OpenAI-compatible /v1/chat/completions)
        ↓ response
SQS Response Queue (FIFO)
   (agent polls this queue with matching requestId)
```

## Key Design Decisions

### Queue Auto-Creation
`resolveQueueUrl()` in `src/sqs.ts`:
1. Tries `GetQueueUrl` first
2. On `QueueDoesNotExist` → calls `CreateQueue` automatically
3. FIFO detection: queue name ending in `.fifo` → sets `FifoQueue=true`, `ContentBasedDeduplication=false`

This means first startup creates queues if they don't exist — no manual SQS setup needed.

### DLQ Flow
On LLM error:
1. Original request message is forwarded to DLQ (`requestDlqName`)
2. Error response is still published to response queue so agent is not left waiting/timing out
3. Original request is deleted from request queue

### Parallel Processing
Multiple messages per poll batch are processed with `Promise.all` — concurrent LLM calls are fine since each is independent.

### Graceful Shutdown
Uses `AbortController` signal — current poll completes, then loop exits cleanly on `SIGTERM`/`SIGINT`.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS region | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | FIFO queue name for incoming requests | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | FIFO queue name for outgoing responses | `llm-response.fifo` |
| `SQS_REQUEST_DLQ_NAME` | FIFO DLQ name for failed requests | `llm-request-dlq.fifo` |
| `SQS_POLL_WAIT_SECONDS` | Long-poll wait time (max 20) | `10` |
| `SQS_MAX_MESSAGES` | Max messages per poll batch | `5` |
| `LLM_BASE_URL` | Private LLM base URL | required |
| `LLM_API_KEY` | API key (use `none` if not needed) | `none` |
| `LLM_MODEL` | Model name | required |
| `LLM_MAX_TOKENS` | Max output tokens | `8096` |

## IAM Permissions Required
```json
{
  "Action": [
    "sqs:SendMessage",
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueUrl",
    "sqs:CreateQueue"
  ],
  "Resource": [
    "arn:aws:sqs:*:*:llm-request.fifo",
    "arn:aws:sqs:*:*:llm-response.fifo",
    "arn:aws:sqs:*:*:llm-request-dlq.fifo"
  ]
}
```

## File Structure
```
src/
├── config.ts    # Configuration from env vars
├── llm.ts       # OpenAI-compatible LLM caller → LLMResponse
├── logger.ts    # Winston logger
├── sqs.ts       # resolveQueueUrl() with auto-create
├── types.ts     # SQSRequest, SQSResponse, LLMResponse, Message, etc.
└── worker.ts    # Main poll loop, message processing, DLQ forwarding
index.ts         # Entry point + graceful shutdown
```

## Correlation Flow
- Agent generates `requestId = randomUUID()`
- Published to request queue with `MessageGroupId=requestId`, `MessageDeduplicationId=requestId`
- Worker publishes response with same `requestId` in body
- Agent polls response queue, matches by `body.requestId === requestId`, ignores others
- Non-matching messages are **not deleted** — they stay in queue for other pollers (or the same poller on next iteration)

## Potential Improvements
- [ ] SQS message visibility timeout should be set > LLM inference time to prevent duplicate processing
- [ ] Support multiple worker instances (horizontal scaling) — currently safe since FIFO + dedup prevents double processing
- [ ] Dead letter queue alarm — CloudWatch alarm on DLQ message count
- [ ] Support Anthropic/Claude API directly (not just OpenAI-compatible)
- [ ] Request queue depth metric → CloudWatch → auto-scaling worker replicas
