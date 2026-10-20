# Configuration

Every setting is an environment variable (`cp env.example .env` for local dev). The GitOps PR-flow
has its own variables: [GITOPS.md](GITOPS.md). Model quirks: [MODELS.md](MODELS.md).

## SQS

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS region | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | FIFO queue for requests | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | FIFO queue for responses | `llm-response.fifo` |
| `SQS_REQUEST_DLQ_NAME` | FIFO dead-letter queue | `llm-request-dlq.fifo` |
| `SQS_POLL_WAIT_SECONDS` | Long-poll wait (max 20) | `10` |
| `SQS_MAX_MESSAGES` | Max messages per poll | `5` |
| `SQS_MAX_CONCURRENCY` | Max messages processed concurrently (poll loop never blocks on a slow LLM call) | `10` |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | Request queue visibility timeout — must exceed max LLM inference time | `300` |
| `SQS_MAX_RECEIVE_COUNT` | Receives before SQS moves a message to the DLQ (RedrivePolicy) | `3` |
| `AWS_ACCESS_KEY_ID` | Local dev only — use IRSA in production | — |
| `AWS_SECRET_ACCESS_KEY` | Local dev only — use IRSA in production | — |

Queues are **auto-created** if they don't exist (FIFO detected from `.fifo` suffix).

## LLM

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_BASE_URL` | Private LLM base URL. On `agent-builder` it is the **full run endpoint**, `https://<host>/api/v1/run/<flow-id>` | required |
| `LLM_API_FORMAT` | Wire format, not vendor: `openai` (`/v1/chat/completions`), `anthropic` (`/v1/messages`), or `agent-builder` (Langflow run endpoint). The Anthropic path needs no message translation — the agent's blocks already are Anthropic blocks. `LLM_SEED` / `LLM_REASONING_EFFORT` / `LLM_USE_MAX_COMPLETION_TOKENS` are **openai-only** and 400 on `/v1/messages`; on `agent-builder`, `LLM_MODEL` and `LLM_MAX_TOKENS` are inert too — both live in the flow | `openai` |
| `LLM_API_KEY` | API key (`none` if not needed) — sent as `x-api-key` on `anthropic` and `agent-builder` | `none` |
| `LLM_SOCKS_PROXY` | Optional SOCKS proxy for the LLM API only, e.g. `socks5://127.0.0.1:1080`. Unset = direct connection. See [SOCKS proxy](#socks-proxy-llm_socks_proxy) below | — |
| `LLM_MODEL` | Model name | required |
| `LLM_MAX_TOKENS` | Max output tokens. **Reasoning models:** hidden thinking counts toward this — use `16384`+ so thinking + answer fit | `8096` |
| `LLM_USE_MAX_COMPLETION_TOKENS` | Use `max_completion_tokens` instead of `max_tokens` | `false` |
| `LLM_REASONING_EFFORT` | Optional — forwarded as `reasoning_effort` (`low`/`medium`/`high`) to cap hidden thinking tokens. Leave unset if the backend rejects it | — |
| `LLM_TEMPERATURE` | Optional — omit if model doesn't support it | — |
| `LLM_TOP_P` | Optional — omit if model doesn't support it | — |
| `LLM_SEED` | Optional — omit if model doesn't support it | — |
| `LOG_LEVEL` | `error\|warn\|info\|debug` | `debug` (dev), `info` (prod) |

## SOCKS proxy (`LLM_SOCKS_PROXY`)

When the worker's host can only reach the LLM API through a **SOCKS tunnel** (e.g. `ssh -D`
via a whitelisted jump host), set `LLM_SOCKS_PROXY=socks5://<host>:<port>`. Node's built-in
`fetch` (undici) has **no SOCKS support** and ignores `ALL_PROXY` — so a tunnel that `curl`
reaches is invisible to the worker without this. The proxy is scoped to the **LLM client
only** (not the GitOps GitHub calls) and TLS/SNI to the real API host is preserved (no
`/etc/hosts` trick needed). Leave it unset once the host is whitelisted — no code change.

> **Running in a container:** `127.0.0.1` inside the container is the container, **not** the
> host where the SSH tunnel listens. Use one of:
> - host networking (`--network host` / `hostNetwork: true`) → `socks5://127.0.0.1:1080` works, or
> - `LLM_SOCKS_PROXY=socks5://host.docker.internal:1080` + (Linux) `--add-host=host.docker.internal:host-gateway`, or
> - the tunnel bound to the host's LAN IP and `socks5://<host-lan-ip>:1080`.

> Implementation note: uses undici's own `fetch` + `Agent` + `fetch-socks` `socksConnector`
> (NOT Node's global fetch) — mixing a `fetch-socks` dispatcher with Node's internal undici
> fails with `UND_ERR_INVALID_ARG onRequestStart` (two undici instances). Covered by a live
> loopback-SOCKS test.

## AWS authentication

Set `AWS_AUTH_MODE` to control how credentials are obtained (read by `entrypoint.sh`):

| `AWS_AUTH_MODE` | Use case | Extra env vars needed |
|-----------------|----------|-----------------------|
| `iam-anywhere` (default) | On-premise with X.509 cert | `AWS_TRUST_ANCHOR_ARN`, `AWS_ROLESANYWHERE_PROFILE_ARN`, `AWS_ROLE_ARN`, `CERT_PATH`, `CERT_KEY_PATH` |
| `irsa` | EKS with IAM Roles for Service Accounts | none |
| `env` | Local dev / CI | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `instance-profile` | EC2 / ECS | none |

## AWS setup

Required IAM permissions (attach to instance role or IRSA):
```json
{
  "Action": [
    "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
    "sqs:GetQueueUrl", "sqs:CreateQueue"
  ],
  "Resource": ["arn:aws:sqs:*:*:llm-*.fifo", "arn:aws:sqs:*:*:gitops-*.fifo"]
}
```
