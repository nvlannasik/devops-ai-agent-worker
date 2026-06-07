# Memory Bank — llm-worker

## Project Overview
SQS consumer service that bridges AI agent requests (from EKS) to a private LLM. Deployed inside the private network — only needs **outbound** access to AWS SQS. No inbound exceptions required.

## Tech Stack
- **Runtime:** Node.js >= 24, TypeScript (ESM)
- **AWS SDK:** `@aws-sdk/client-sqs` v3
- **LLM:** `openai` SDK (OpenAI-compatible API)
- **Build:** `tsc` → `dist/`, dev via `tsx watch`

## Architecture
```
SQS Request Queue (FIFO)
        ↓ poll (long-polling)
   llm-worker
        ↓ POST /v1/chat/completions
   Private LLM
        ↓
SQS Response Queue (FIFO)
   (agent polls, matches by requestId)
```

## Key Design Decisions

### Queue Auto-Creation
`resolveQueueUrl()` in `src/sqs.ts`:
1. `GetQueueUrl` first
2. On `QueueDoesNotExist` → `CreateQueue` automatically
3. FIFO: queue name ending in `.fifo` → sets `FifoQueue=true`, `ContentBasedDeduplication=false`

### Flexible LLM Parameters
All inference parameters are **optional** — only included in request if env var is set.
Prevents "Unsupported parameter" errors from models that don't support `top_p`, `seed`, etc.

| Env Var | Notes |
|---------|-------|
| `LLM_MAX_TOKENS` | Default: 8096 |
| `LLM_USE_MAX_COMPLETION_TOKENS=true` | Use `max_completion_tokens` instead of `max_tokens` |
| `LLM_TEMPERATURE` | Optional — omit if unsupported |
| `LLM_TOP_P` | Optional — omit if unsupported |
| `LLM_SEED` | Optional — omit if unsupported |

### DLQ Flow
On LLM error:
1. Original request forwarded to DLQ
2. Error response published to response queue (agent is not left waiting/timing out)
3. Original request deleted from request queue

### Graceful Shutdown
`AbortController` signal — current poll completes before loop exits on `SIGTERM`/`SIGINT`.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SQS_REGION` | AWS region | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | FIFO queue for incoming requests | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | FIFO queue for outgoing responses | `llm-response.fifo` |
| `SQS_REQUEST_DLQ_NAME` | FIFO DLQ for failed requests | `llm-request-dlq.fifo` |
| `SQS_POLL_WAIT_SECONDS` | Long-poll wait (max 20) | `10` |
| `SQS_MAX_MESSAGES` | Max messages per poll batch | `5` |
| `LLM_BASE_URL` | Private LLM base URL | required |
| `LLM_API_KEY` | API key (`none` if not needed) | `none` |
| `LLM_MODEL` | Model name | required |
| `LLM_MAX_TOKENS` | Max output tokens | `8096` |
| `LLM_USE_MAX_COMPLETION_TOKENS` | Use `max_completion_tokens` param | `false` |
| `LLM_TEMPERATURE` | Optional inference param | — |
| `LLM_TOP_P` | Optional inference param | — |
| `LLM_SEED` | Optional inference param | — |
| `LOG_LEVEL` | `error\|warn\|info\|debug` | `debug` (dev), `info` (prod) |
| `AWS_ACCESS_KEY_ID` | Local dev only — use IRSA on EKS | — |
| `AWS_SECRET_ACCESS_KEY` | Local dev only — use IRSA on EKS | — |

## IAM Permissions Required
```json
{
  "Action": [
    "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
    "sqs:GetQueueUrl", "sqs:CreateQueue"
  ],
  "Resource": [
    "arn:aws:sqs:*:*:llm-request.fifo",
    "arn:aws:sqs:*:*:llm-response.fifo",
    "arn:aws:sqs:*:*:llm-request-dlq.fifo"
  ]
}
```

## Correlation Flow
- Agent generates `requestId = randomUUID()`
- Published with `MessageGroupId=requestId`, `MessageDeduplicationId=requestId`
- Worker publishes response with same `requestId` in body
- Agent matches `body.requestId === requestId`, ignores others (non-matching messages stay in queue)

## File Structure
```
src/
├── config.ts    # All config from env vars
├── llm.ts       # OpenAI-compatible LLM caller, optional params
├── logger.ts    # Winston, LOG_LEVEL support
├── sqs.ts       # resolveQueueUrl() with auto-create
├── types.ts     # SQSRequest, SQSResponse, LLMResponse, Message
└── worker.ts    # Poll loop, processMessage, DLQ forwarding
index.ts         # Entry point + graceful shutdown
```

## Known Issues Fixed
- `max_tokens` → some models require `max_completion_tokens` instead: `LLM_USE_MAX_COMPLETION_TOKENS=true`
- `top_p` unsupported by some models: leave `LLM_TOP_P` unset

## AWS Authentication

Controlled by `AWS_AUTH_MODE` env var (read by `entrypoint.sh`):

| Mode | Setup | Use case |
|------|-------|----------|
| `iam-anywhere` | Writes `~/.aws/config` with `credential_process` | On-premise / private network with X.509 cert |
| `irsa` | No setup needed | EKS with IRSA |
| `env` | No setup needed | Local dev (`AWS_ACCESS_KEY_ID`/`SECRET`) |
| `instance-profile` | No setup needed | EC2 instance metadata |

Default is `iam-anywhere` — **set `AWS_AUTH_MODE=irsa` on EKS, `AWS_AUTH_MODE=env` for local dev**.

## Potential Improvements
- [ ] SQS visibility timeout should exceed LLM inference time (prevents duplicate processing)
- [ ] CloudWatch alarm on DLQ message count
- [ ] Support Anthropic API directly (not just OpenAI-compatible)
- [ ] Request queue depth → CloudWatch → auto-scale worker replicas
