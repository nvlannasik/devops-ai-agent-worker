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
SQS Response Queue (FIFO, shared)
   (agent's per-replica dispatcher routes by requestId)
```

## Key Design Decisions

### Visibility Timeout Management
- `SQS_VISIBILITY_TIMEOUT_SECONDS` (default: 300) applied to request queue on startup via `SetQueueAttributes`
- Applied both on queue creation and on existing queues — ensures correct value after deploy
- `startVisibilityExtender()` extends visibility every 90s during LLM inference as backup
- **Extend immediately** on message receive before `callLLM()` — prevents expiry on default 30s queues
- IAM permission required: `sqs:ChangeMessageVisibility`

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

### Poison-pill handling (malformed messages)
- `parseSqsRequest(body)` in `src/message.ts` parses + validates the body up front. Returns null on unparseable JSON or missing `requestId`.
- On null → `deadLetterRaw()` sends the raw body to the DLQ (synthetic `malformed-<uuid>` group/dedup id) and the request is **deleted**. Prevents the old bug where `JSON.parse` ran *outside* any try/catch, so a corrupt body threw and the message was redelivered forever.
- Only `requestId` is required to pass validation — a parseable message with a bad `messages`/`tools` payload flows through and fails in `callLLM`, which still sends an error response the agent can see.

### RedrivePolicy (SQS-level backstop)
- `ensureRedrivePolicy()` (in `src/sqs.ts`) sets the request queue's `RedrivePolicy` → DLQ with `maxReceiveCount` (`SQS_MAX_RECEIVE_COUNT`, default 3) on every startup (idempotent).
- Backstop for any message received but never deleted (worker crash mid-process, a failed delete, a bug) — SQS itself moves it aside after N receives instead of redelivering until retention.
- **Best-effort / non-fatal:** wrapped in try/catch in `resolveQueues()`. Needs `sqs:GetQueueAttributes` + `sqs:SetQueueAttributes`; if those are denied (or any error), the worker logs a warning and runs **without** the RedrivePolicy rather than crash-looping. (An earlier version let this throw at startup → `process.exit(1)` → CrashLoopBackOff.)
- Note: the visibility extender does NOT increment `ApproximateReceiveCount`, so a long legit LLM call is not falsely dead-lettered.

### Concurrency model (continuous polling)
- `startWorker()` keeps an `inFlight: Set<Promise<void>>` and processes each message as an independent task — it does **not** `await Promise.all(batch)`.
- Poll loop: if `inFlight.size >= SQS_MAX_CONCURRENCY` → `await Promise.race(inFlight)` for a free slot; otherwise receive up to `min(SQS_MAX_MESSAGES, remaining capacity)` and start each task without blocking.
- **Why:** the old `await Promise.all(batch)` blocked the next poll for as long as the *slowest* message in the batch took. With a slow LLM, a long call stalled pickup of every later request → concurrent investigations timed out on the agent side. Now a slow call holds one slot only.
- Receive passes `{ abortSignal: signal }` so shutdown interrupts a long-poll immediately.

### SQSClient timeouts
- Created with `requestHandler: { connectionTimeout: 5000, requestTimeout: (pollWaitSeconds + 15)s }` + `maxAttempts: 3`. Without a timeout a hung SQS call freezes the poll loop. `requestTimeout` must exceed the long-poll wait.
- `processMessage` logs `Replied requestId=...` **after** the response is published. The earlier `Done requestId=...` only means the LLM finished — the publish (which the agent actually waits on) happens after, so a crash between the two looks like success in the logs.

### Graceful Shutdown
- `AbortController` signal → loop breaks, then `await Promise.allSettled(inFlight)` **drains** remaining in-flight LLM calls so their responses are still published (agents aren't left waiting).
- `index.ts` calls `process.exit(0)` once `startWorker` resolves (after drain).

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SQS_REGION` | AWS region | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | FIFO queue for incoming requests | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | FIFO queue for outgoing responses | `llm-response.fifo` |
| `SQS_REQUEST_DLQ_NAME` | FIFO DLQ for failed requests | `llm-request-dlq.fifo` |
| `SQS_POLL_WAIT_SECONDS` | Long-poll wait (max 20) | `10` |
| `SQS_MAX_MESSAGES` | Max messages per poll batch | `5` |
| `SQS_MAX_CONCURRENCY` | Max messages processed concurrently | `10` |
| `SQS_MAX_RECEIVE_COUNT` | Receives before SQS dead-letters a message | `3` |
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
    "sqs:GetQueueUrl", "sqs:CreateQueue", "sqs:ChangeMessageVisibility",
    "sqs:GetQueueAttributes", "sqs:SetQueueAttributes"
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
- Worker publishes response to the shared `SQS_RESPONSE_QUEUE_NAME` with the same `requestId` in the body
- **Multi-replica routing lives on the agent side:** the agent runs one dispatcher per replica over the shared response queue and releases (`ChangeMessageVisibility`) any message that isn't its own so the owning replica can grab it. The worker stays simple — it always replies to the one shared response queue.

## File Structure
```
src/
├── config.ts    # All config from env vars
├── llm.ts       # OpenAI-compatible LLM caller, optional params
├── logger.ts    # Winston, LOG_LEVEL support
├── sqs.ts       # resolveQueueUrl() with auto-create, ensureRedrivePolicy()
├── message.ts   # parseSqsRequest() — body parse + validation (poison-pill guard)
├── types.ts     # SQSRequest, SQSResponse, LLMResponse, Message
└── worker.ts    # Poll loop, processMessage, DLQ forwarding, deadLetterRaw()
index.ts         # Entry point + graceful shutdown
```

## Testing
- `npm test` → `node --import tsx --test 'src/**/*.test.ts'` (Node >= 24 built-in runner + tsx, zero new deps)
- `*.test.ts` excluded from the `tsc` build so `dist/` stays clean
- Covered so far: `parseSqsRequest` (poison-pill validation)

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
