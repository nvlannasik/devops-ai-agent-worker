# LLM Worker

SQS consumer service that bridges AI agent requests to a private LLM. Deployed inside the private network — only needs outbound access to AWS SQS (no inbound exceptions required).

## How It Works

```
devops-ai-agent (EKS)
    ↓ publish {requestId, messages, tools, systemPrompt}
SQS Request Queue (FIFO)
    ↓ poll
llm-worker (Private Network)
    ↓ call
Private LLM API (OpenAI-compatible)
    ↓ response
SQS Response Queue (FIFO)
    ↓ poll
devops-ai-agent (EKS)
```

## Requirements

- Node.js >= 24
- AWS credentials with SQS permissions (`sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`)
- Private LLM with OpenAI-compatible API (`/v1/chat/completions`)

## Setup

```bash
cp env.example .env
# Edit .env
npm install
npm run dev       # development
npm run build && npm start  # production
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS region | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_URL` | FIFO queue URL for incoming requests | required |
| `SQS_RESPONSE_QUEUE_URL` | FIFO queue URL for outgoing responses | required |
| `SQS_POLL_WAIT_SECONDS` | SQS long-poll wait time (max 20) | `10` |
| `SQS_MAX_MESSAGES` | Max messages per poll (max 10) | `5` |
| `LLM_BASE_URL` | Private LLM base URL | required |
| `LLM_API_KEY` | API key (use `none` if not required) | `none` |
| `LLM_MODEL` | Model name | required |
| `LLM_MAX_TOKENS` | Max output tokens | `8096` |

## AWS SQS Setup

Create two **FIFO** queues:

```bash
# Request queue
aws sqs create-queue \
  --queue-name llm-request.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

# Response queue
aws sqs create-queue \
  --queue-name llm-response.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
```

Required IAM permissions for both the agent (EKS) and worker (private network):

```json
{
  "Effect": "Allow",
  "Action": ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
  "Resource": ["arn:aws:sqs:*:*:llm-request.fifo", "arn:aws:sqs:*:*:llm-response.fifo"]
}
```

## Docker

```bash
docker build -t llm-worker .

docker run \
  -e AWS_REGION=ap-southeast-1 \
  -e SQS_REQUEST_QUEUE_URL=https://sqs... \
  -e SQS_RESPONSE_QUEUE_URL=https://sqs... \
  -e LLM_BASE_URL=http://your-llm:8080/v1 \
  -e LLM_MODEL=your-model \
  llm-worker
```

## File Structure

```
src/
├── config.ts    # Configuration
├── llm.ts       # OpenAI-compatible LLM caller
├── logger.ts    # Winston logger
├── types.ts     # Shared types (SQSRequest, SQSResponse, LLMResponse)
└── worker.ts    # SQS consumer loop
```
