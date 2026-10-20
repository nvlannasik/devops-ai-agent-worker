# LLM Worker

SQS consumer that bridges [devops-ai-agent](../devops-ai-agent) requests to a private LLM — and, optionally, to
GitHub Enterprise for the GitOps PR flow. Deployed inside the private network — only needs **outbound**
access to AWS SQS. No inbound exceptions required. (Directory `devops-ai-agent-worker`; the service and
the chart's subchart are `llm-worker` / `devops-llm-worker`.)

## How It Works

```
devops-ai-agent
    ↓ publish {requestId, messages, tools, systemPrompt, traceId?}
SQS Request Queue (FIFO)                    SQS GitOps Request Queue (FIFO)   ← optional
    ↓ poll                                      ↓ poll {op: dry_run | open_pr | history | revert_pr | locate, ...}
llm-worker (Private Network) ───────────────────┘
    ↓ openai: POST /v1/chat/completions  |  anthropic: POST /v1/messages  |  agent-builder: run endpoint
Private LLM                                 GitHub Enterprise (PR against the GitOps repo)
    ↓
SQS Response Queue (FIFO, shared by both flows)
    ↓ poll (agent routes by requestId)
devops-ai-agent
```

The agent never sends cluster credentials or GitHub credentials anywhere: it holds none for GitHub,
and its credential-ish identifiers (IPs, hostnames, ARNs, emails) are already masked before a request
reaches this queue. `traceId` is the agent's Slack thread id — logged here so one grep joins the
agent log, this log and the Slack thread.

## Requirements

- Node.js >= 24
- AWS credentials with SQS permissions (or IRSA on EKS/EC2)
- A private LLM speaking the OpenAI or Anthropic Messages API, or an agent-builder (Langflow) run endpoint

## Setup

```bash
cp env.example .env            # every variable: docs/CONFIGURATION.md
npm install
npm run dev
npm run build && npm start
npm test                       # unit tests
```

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build. Covered: request parsing (poison-pill guard), the OpenAI translation (`toOpenAIMessages`, native `tool_calls` — never stringified), the Anthropic and agent-builder paths, the SOCKS proxy (live loopback), and the GitOps flow (message parsing, value resolution in base/overlay, GitHub client, PAT and App auth, drift detection).

## Reliability

| Behavior | Details |
|----------|---------|
| Continuous polling | Messages processed as independent in-flight tasks (up to `SQS_MAX_CONCURRENCY`) — a slow LLM call never blocks pickup of other requests |
| Graceful drain | On `SIGTERM`/`SIGINT`, in-flight LLM calls finish and publish their responses before exit |
| Poison-pill guard | Unparseable / missing-`requestId` messages go straight to the DLQ instead of being redelivered forever |
| RedrivePolicy | Best-effort backstop: SQS dead-letters a message after `SQS_MAX_RECEIVE_COUNT` receives (skipped with a warning if IAM is missing) |
| Request timeouts | SQS client `connectionTimeout`/`requestTimeout` so a hung call can't freeze the poll loop |

## Documentation

| Page | What is in it |
|---|---|
| [CONFIGURATION](docs/CONFIGURATION.md) | Every env var (SQS, LLM), the SOCKS proxy, AWS authentication and IAM |
| [GITOPS](docs/GITOPS.md) | The GitOps PR-flow: its five ops, PAT vs GitHub App auth, its env vars |
| [MODELS](docs/MODELS.md) | Reasoning-model handling and common model compatibility fixes |

## Docker

```bash
docker build -t llm-worker .

docker run \
  -e AWS_REGION=ap-southeast-1 \
  -e SQS_REQUEST_QUEUE_NAME=llm-request.fifo \
  -e SQS_RESPONSE_QUEUE_NAME=llm-response.fifo \
  -e LLM_BASE_URL=http://your-llm:8080/v1 \
  -e LLM_MODEL=your-model \
  llm-worker
```

## File Structure

```
index.ts              # Entry: SIGTERM/SIGINT → abort → drain
src/
├── config.ts         # All config from env vars
├── llm.ts            # OpenAI path — toOpenAIMessages() (keep in sync with the agent's copy), max_tokens switch
├── anthropic.ts      # LLM_API_FORMAT=anthropic — /v1/messages, no translation
├── agent-builder.ts  # LLM_API_FORMAT=agent-builder — Langflow run endpoint as a transport
├── socks.ts          # LLM_SOCKS_PROXY — undici fetch over SOCKS
├── message.ts        # parseSqsRequest() — poison-pill guard
├── logger.ts         # Winston + LOG_LEVEL
├── sqs.ts            # resolveQueueUrl() with auto-create
├── types.ts          # SQSRequest, SQSResponse, LLMResponse
├── worker.ts         # Poll loop, DLQ forwarding, graceful shutdown
└── gitops/           # PR flow: message.ts, resolve.ts (find + edit the value), github-client.ts, github-app.ts, handler.ts
```
