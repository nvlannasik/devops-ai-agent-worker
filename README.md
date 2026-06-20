# LLM Worker

SQS consumer that bridges AI agent requests to a private LLM. Deployed inside the private network — only needs **outbound** access to AWS SQS. No inbound exceptions required.

## How It Works

```
devops-ai-agent (EKS)
    ↓ publish {requestId, messages, tools, systemPrompt}
SQS Request Queue (FIFO)
    ↓ poll
llm-worker (Private Network)
    ↓ POST /v1/chat/completions
Private LLM
    ↓
SQS Response Queue (FIFO)
    ↓ poll (agent waits for matching requestId)
devops-ai-agent (EKS)
```

## Requirements

- Node.js >= 24
- AWS credentials with SQS permissions (or IRSA on EKS/EC2)
- Private LLM with OpenAI-compatible API

## Setup

```bash
cp env.example .env
npm install
npm run dev
npm run build && npm start
npm test                       # unit tests
```

## Testing

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build. Current coverage: `parseSqsRequest` (poison-pill / malformed-message validation).

## Reliability

| Behavior | Details |
|----------|---------|
| Continuous polling | Messages processed as independent in-flight tasks (up to `SQS_MAX_CONCURRENCY`) — a slow LLM call never blocks pickup of other requests |
| Graceful drain | On `SIGTERM`/`SIGINT`, in-flight LLM calls finish and publish their responses before exit |
| Poison-pill guard | Unparseable / missing-`requestId` messages go straight to the DLQ instead of being redelivered forever |
| RedrivePolicy | Best-effort backstop: SQS dead-letters a message after `SQS_MAX_RECEIVE_COUNT` receives (skipped with a warning if IAM is missing) |
| Request timeouts | SQS client `connectionTimeout`/`requestTimeout` so a hung call can't freeze the poll loop |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SQS_REGION` | AWS region | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | FIFO queue for requests | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | FIFO queue for responses | `llm-response.fifo` |
| `SQS_REQUEST_DLQ_NAME` | FIFO dead-letter queue | `llm-request-dlq.fifo` |
| `SQS_POLL_WAIT_SECONDS` | Long-poll wait (max 20) | `10` |
| `SQS_MAX_MESSAGES` | Max messages per poll | `5` |
| `SQS_MAX_CONCURRENCY` | Max messages processed concurrently (poll loop never blocks on a slow LLM call) | `10` |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | Request queue visibility timeout — must exceed max LLM inference time | `300` |
| `SQS_MAX_RECEIVE_COUNT` | Receives before SQS moves a message to the DLQ (RedrivePolicy) | `3` |
| `LLM_BASE_URL` | Private LLM base URL | required |
| `LLM_API_KEY` | API key (`none` if not needed) | `none` |
| `LLM_MODEL` | Model name | required |
| `LLM_MAX_TOKENS` | Max output tokens | `8096` |
| `LLM_USE_MAX_COMPLETION_TOKENS` | Use `max_completion_tokens` instead of `max_tokens` | `false` |
| `LLM_TEMPERATURE` | Optional — omit if model doesn't support it | — |
| `LLM_TOP_P` | Optional — omit if model doesn't support it | — |
| `LLM_SEED` | Optional — omit if model doesn't support it | — |
| `LOG_LEVEL` | `error\|warn\|info\|debug` | `debug` (dev), `info` (prod) |
| `AWS_ACCESS_KEY_ID` | Local dev only — use IRSA in production | — |
| `AWS_SECRET_ACCESS_KEY` | Local dev only — use IRSA in production | — |

Queues are **auto-created** if they don't exist (FIFO detected from `.fifo` suffix).

## Common Model Compatibility Issues

| Error | Fix |
|-------|-----|
| `'max_tokens' is not supported` | Set `LLM_USE_MAX_COMPLETION_TOKENS=true` |
| `'top_p' is not supported` | Leave `LLM_TOP_P` unset |
| `'temperature' is not supported` | Leave `LLM_TEMPERATURE` unset |

## AWS Authentication

Set `AWS_AUTH_MODE` to control how credentials are obtained (read by `entrypoint.sh`):

| `AWS_AUTH_MODE` | Use case | Extra env vars needed |
|-----------------|----------|-----------------------|
| `iam-anywhere` (default) | On-premise with X.509 cert | `AWS_TRUST_ANCHOR_ARN`, `AWS_ROLESANYWHERE_PROFILE_ARN`, `AWS_ROLE_ARN`, `CERT_PATH`, `CERT_KEY_PATH` |
| `irsa` | EKS with IAM Roles for Service Accounts | none |
| `env` | Local dev / CI | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `instance-profile` | EC2 / ECS | none |

## AWS Setup

Required IAM permissions (attach to instance role or IRSA):
```json
{
  "Action": [
    "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
    "sqs:GetQueueUrl", "sqs:CreateQueue"
  ],
  "Resource": "arn:aws:sqs:*:*:llm-*.fifo"
}
```

## Docker

```bash
docker build -t llm-worker .

docker run \
  -e SQS_REGION=ap-southeast-1 \
  -e SQS_REQUEST_QUEUE_NAME=llm-request.fifo \
  -e SQS_RESPONSE_QUEUE_NAME=llm-response.fifo \
  -e LLM_BASE_URL=http://your-llm:8080/v1 \
  -e LLM_MODEL=your-model \
  llm-worker
```

## File Structure

```
src/
├── config.ts    # All config from env vars
├── llm.ts       # LLM caller — optional params, max_tokens/max_completion_tokens switch
├── logger.ts    # Winston + LOG_LEVEL
├── sqs.ts       # resolveQueueUrl() with auto-create
├── types.ts     # SQSRequest, SQSResponse, LLMResponse
└── worker.ts    # Poll loop, DLQ forwarding, graceful shutdown
```
