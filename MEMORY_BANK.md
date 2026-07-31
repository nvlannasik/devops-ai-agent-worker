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
| `LLM_REASONING_EFFORT` | Optional — forwarded as `reasoning_effort` (low/medium/high); caps hidden thinking tokens |

The `tools` param is **omitted entirely when the agent sends an empty tools array** (tool
budget reached) — some OpenAI-compatible backends reject `tools: []`.

### SOCKS proxy for the LLM API (`LLM_SOCKS_PROXY`, `llm.ts`)
Optional — for hosts that reach the LLM API only through a SOCKS tunnel (`ssh -D`). Node's
`fetch`/undici has **no SOCKS support** and ignores `ALL_PROXY`, so without this the worker
connects directly and times out (curl works, Node doesn't — classic symptom).
- `buildSocksFetch(proxy)` builds a custom `fetch` from **undici's OWN `fetch` + `Agent` +
  `fetch-socks` `socksConnector`** — NOT Node's global fetch. Mixing `fetch-socks`'s
  `socksDispatcher` (its bundled undici Agent) with Node's internal fetch fails
  `UND_ERR_INVALID_ARG: invalid onRequestStart method` — the dispatcher and the fetch that
  runs it must come from the SAME undici (handler interfaces diverge across versions). This
  bug was caught by a live loopback-SOCKS integration test (`socks.test.ts`) — keep it.
- Scoped to the OpenAI client's `fetch` only (NOT `setGlobalDispatcher`) so the GitOps
  GitHub calls in the same process aren't forced through the LLM tunnel.
- `parseSocksProxy` (exported, tested) parses `socks5://[user:pass@]host:port` (socks4/5).
  Unset → plain client, zero behavior change (remove the env once whitelisted).
- New deps: `undici` (its fetch/Agent) + `fetch-socks` (the socks connector) + `socks`.
- Container gotcha: `127.0.0.1` in a container ≠ the host running the tunnel — use host
  networking or `host.docker.internal` (see README).

### Reasoning-model handling (`llm.ts`)
- `finish_reason: "length"` → mapped to `max_tokens` (was disguised as `end_turn`), so truncation is visible end-to-end.
- **Auto-retry safeguard:** `isEmptyTokenExhaustion()` (unit-tested) — empty content + `max_tokens` means the model spent the ENTIRE budget on hidden thinking; retry once with **2× the token budget**. Partial answers are never retried; one retry max. Frequent `warn` retries = raise `LLM_MAX_TOKENS` (16384 recommended for reasoning models; thinking counts toward the limit).
- Agent-side `SQS_LLM_TIMEOUT_SECONDS` must cover attempt + retry (agent default now 240s — 120s once lost the race by 23s).

### Backend wire format (`LLM_API_FORMAT`, `llm.ts` + `anthropic.ts`)
The flag names the **wire format, not the model vendor**: `openai` (default) is
`POST /v1/chat/completions` — vLLM, Ollama, SGLang, most gateways — and `anthropic` is
`POST /v1/messages`. Default preserves every existing deployment.

The asymmetry is the point: **the Anthropic path has no translation layer at all.** The agent's
wire format already *is* Anthropic's — `ContentBlock` is `{type:"tool_use", id, name, input}` /
`{type:"tool_result", tool_use_id, content}`, and `stopReason` is the exact
`end_turn | tool_use | max_tokens` union. `toOpenAIMessages` exists precisely because the OpenAI
path speaks a different shape. So `anthropic.ts` only re-keys: blocks are rebuilt field-by-field
(never spread — `ContentBlock` is one loose union, and the API 400s on keys foreign to a block
type), `systemPrompt` becomes a top-level `system` parameter rather than a message, and tools use
`input_schema` with no `{type:"function", function:{…}}` envelope.

- **No new dependency.** It is one POST, so it uses `fetch` and reuses `buildSocksFetch` from
  `socks.ts` — the Anthropic SDK would be a dependency for what fits in one file.
- `parseSocksProxy`/`buildSocksFetch` moved `llm.ts` → `socks.ts` so both paths share one proxy
  decision (and its single startup log line) without a circular import.
- Only the request/response shape differs. The token-exhaustion retry, the SQS envelope, and the
  visibility extender are shared and format-agnostic.
- **Not forwarded on this path:** `LLM_SEED`, `LLM_REASONING_EFFORT`, `LLM_USE_MAX_COMPLETION_TOKENS`
  — none exist in the Messages API (thinking is a `thinking` budget object), and an unknown
  top-level field is a 400.
- `cacheReadTokens`/`cacheCreationTokens` are real numbers here; the OpenAI path hardcodes them to 0.
- `assertApiFormat()` runs at the top of `startWorker()`, so a typo'd format fails the pod at boot
  rather than the first alert of the day — same rule as the agent's backend registry. It is called
  there and not at config import so the failure lands inside `index.ts`'s `.catch` and gets a clean
  logged exit instead of a raw unhandled rejection.
- **Bedrock is a third format, not this one.** It speaks the same message shape but needs SigV4 and
  `/model/<id>/invoke`; adding it means a new `apiFormat` value, not a tweak here.

### Anthropic-shaped history → OpenAI chat (`toOpenAIMessages`, `llm.ts`)
The agent speaks Anthropic-style content blocks (`{type:"tool_use"|"tool_result"|"text"}`);
the private LLM speaks OpenAI chat. `toOpenAIMessages()` translates: `tool_use` →
`assistant.tool_calls[]`, `tool_result` → a `role:"tool"` message with `tool_call_id`, text
blocks joined. Tool results are emitted **before** any new user text in the same turn —
OpenAI requires every tool message to directly follow the assistant turn that requested it.
- **This used to be `JSON.stringify(m.content)`.** The literal `[{"type":"tool_use",...}]`
  went into the prompt as TEXT. A large model ignores the noise; a small one **imitates it**
  and answers with that JSON instead of calling a tool. The agent then posted the raw array
  to Slack and re-stringified it next turn, so each round added a layer of escaping.
  Symptom: nested `[{\"type\":\"text\",\"text\":\"[{\\\"type\\\"...` walls in Slack, and
  `chatcmpl-tool-<id>` values that repeat across turns (the model copying an id it saw).
- The identical bug existed in the agent's own `openai-compatible.ts` (direct-HTTP path).
  Both are fixed; the two copies must stay in sync (separate repos, no shared module).
- **Backend requirement:** vLLM & friends only emit `tool_calls` with
  `--enable-auto-tool-choice --tool-call-parser <hermes|llama3_json|mistral|...>`. Without
  it the symptom returns even though the code is correct.
- Malformed tool-call arguments (common with small models) no longer throw out of the whole
  request: the `tool_use` block is kept with `input: {}` (dropping it would break
  tool_use/tool_result pairing) and a warning logs the raw arguments. The tool's own schema
  validation then tells the model what it got wrong.

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
- **Publish BEFORE delete, sequentially** (was `Promise.all([send, delete])`). Run concurrently, a failed publish could still pair with a successful delete: the request is gone, no reply ever arrives, and the agent blocks to timeout with nothing in either log explaining it. Publish-first means a delete failure only costs a redelivery — a duplicate LLM call whose duplicate reply the agent's tombstone drops. Duplicate work beats a lost reply.

### Graceful Shutdown
- `AbortController` signal → loop breaks, then `await Promise.allSettled(inFlight)` **drains** remaining in-flight LLM calls so their responses are still published (agents aren't left waiting).
- `index.ts` calls `process.exit(0)` once `startWorker` resolves (after drain).

### GitOps PR-flow bridge (`src/gitops/`, DESIGN_gitops_pr_remediation.md)
The worker is ALSO the private-network bridge to **GitHub Enterprise** (reachable only from
here, like the private LLM). Step 2 shipped the building blocks (no live SQS handler yet — that's Step 3):
- **Auth — PAT or GitHub App.** `GITHUB_TOKEN` (PAT) is used directly as the bearer and **takes precedence** (simple, chosen for the initial phase — GitHub App registration was access-limited on the target GHE). Without a PAT, the App flow runs. `config.gitops.enabled` = `(GITHUB_TOKEN || GITHUB_APP_ID) && GITOPS_REPO`.
- **`github-app.ts`** — GitHub App auth hand-rolled with `node:crypto` (no `@octokit` dep): `buildAppJwt` (RS256 JWT, iss=appId, exp ≤10min) → `getInstallationToken` (exchange for a ≤1h token). Unit-tested with a real generated keypair (sign + verify). Unused when a PAT is set.
- **`github-client.ts`** — thin REST client over `fetch` (configurable `apiUrl` for GHE): `listYamlFiles` (recursive tree), `getFile`, `createBranch`, `putFile` (contents API — no clone), `openPr`. `token()` returns the PAT directly when set, else the cached App installation token (~1min-before-expiry refresh). `fetch` injectable for tests (PAT path unit-tested: skips the App exchange).
- **`resolve.ts`** — locate + edit, **line-based, NO yaml dependency** (targeted one-line edit → minimal diff, comments preserved; a parse+reserialize would rewrite the whole file). `resolveGitOpsEdit(files, helmRelease, changeSpec)`: find the HelmRelease file (`kind: HelmRelease` + matching `name:`), edit the value line(s), return `{path, valuesKey, before, after, newContent, diff}`. Per action: **set_image** (`tag`/`image` via `tagOf`), **scale** (`replicaCount`/`replicas`) — single scalar; **set_resources** (`resolveResourceEdit`) — nested `resources.{requests,limits}.{cpu,memory}` leaves located via an indentation-tracked parent stack (disambiguates `limits.memory` from `requests.memory`), supports multiple changes → multi-hunk diff. Refuses (honest) on: HR file missing/ambiguous, >1 matching line, or two changes hitting the same line. **Base→overlay ADD:** when the value isn't in the overlay (`tryBase`), the worker derives the base prefix (`deriveBasePrefix`: `apps/dev/systems`→`apps/base/systems`), fetches the base HR, learns the value's path by KEY (`findKeyPaths`), and ADDS it to the overlay's `spec.values` via the **`yaml` Document API** (`setIn` — creates the nested key, preserves the rest) — overriding base per-env, so a remediation isn't refused just because the value wasn't overridden in the overlay yet. Safe: path copied from base, never guessed. Scope: scale + resources (image tags ~always in overlays). `yaml` is the ONE dep here — in-overlay edits stay line-based (minimal diff). **Component disambiguation:** for multi-component charts (`controller.replicaCount` + `proxy.replicaCount`), the request carries `component` (the workload's `app.kubernetes.io/component` label, from the MCP guard); `narrowByComponent` keeps only the path whose ancestors include that component. Fail-safe — if it doesn't narrow to exactly one, refuses (never guesses). `// ponytail:` resources isn't container-scoped; component is label-only (no name-based fallback yet).
- **Cluster/GitOps drift detection (`detectDrift` in `resolve.ts`).** The line search matches key AND value, so "the overlay doesn't set this key" and "the overlay sets it to a *different* value" were indistinguishable — both fell through to the base-add path and surfaced as *"the value is not set in the overlay and can't be auto-added for this action"*. That message is wrong whenever somebody changed the cluster directly (`kubectl set image`): the incident context's `from` is the DRIFTED cluster value, which of course isn't in Git. Now, when the value search finds nothing, `findKeyLines` re-scans by KEY alone; exactly one hit with a different value ⇒ **drift**, returned as `{ok:false, reason, drift:{path, valuesKey, gitValue, clusterValue}}` and logged `DRIFT ... git=X cluster=Y`. Drift is checked BEFORE `tryBase` (the key is right here, it just disagrees) and it is NOT a plain refusal — the agent turns it into a `flux_reconcile` proposal, because the repo is the source of truth. Ambiguous matches stay undefined and fall back to the old message (never guesses). Covers set_image, scale, set_resources.
- **`addFromBase` refuses when `doc.hasIn(path)` is already true** — backstop for the drift cases `detectDrift` can't decide. `setIn` would otherwise REPLACE the operator's value while `additiveDiff` rendered it as a clean insertion, i.e. a human approving a diff that hides an overwrite. `additiveDiff` now also reports leftover original lines as removals rather than dropping them.
- **`listYamlFiles` throws on a truncated tree.** GitHub silently truncates a `recursive=1` tree past ~100k entries / 7MB and sets `truncated: true`. Ignoring it made missing files look nonexistent → "value not found in the overlay", a wrong answer with no error anywhere.
- Config: `config.gitops` (enabled when `GITHUB_APP_ID` + `GITOPS_REPO` set); private key from `GITHUB_APP_PRIVATE_KEY` or `_FILE`.
- **`message.ts`** — SQS contract (agent → worker): `{requestId, op:"dry_run"|"open_pr", helmRelease:{name,namespace}, action, container?, changes:[{field,from,to}], pathPrefix?, incident?}` → `{requestId, response: GitOpsPayload | error}`. `repo`/`branch` are NOT in the message (worker owns them = single-repo blast radius). `pathPrefix` IS in the message — the agent auto-detects the per-env overlay from the Flux Kustomization `spec.path` and sends it; `listCandidateFiles(pathPrefix ?? config.pathPrefix)` scopes the file search to it (falls back to `GITOPS_PATH_PREFIX`). `parseGitOpsRequest` validates (trust boundary), unit-tested.
- **`handler.ts`** — `runGitOps(req, backend)`: locate+resolve → dry_run returns the diff, open_pr re-reads the sha (catches drift), branches, commits the one file, opens the PR. GitHub side behind a `GitOpsBackend` interface (unit-tested with a fake). `githubBackend` narrows to release-like YAML (`mapLimit` bounded fetch) then falls back to all. `prTitle`/`prBody` (exported, tested) build a short action-specific title (`Remediation: bump \`x\` image to v2`) + a clean body (workload/file, change table, collapsible diff, provenance) from the structured change — NOT the agent's verbose card summary.
- **Worker wiring (`worker.ts`):** the receive/concurrency/drain loop was extracted into a generic `pollLoop(signal, queueUrl, label, maxConcurrency, handle)`; `startWorker` runs it for the LLM queue and — when `config.gitops.enabled` — a second loop on the `gitops` queue. `processGitOpsMessage` publishes on the **shared response queue** routed by `requestId` (agent's gitops client routes it, Step 4). Business refusals travel in `response.ok=false`; only exceptions use the envelope `error`. **The LLM `processMessage` is unchanged.**

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
| `LLM_API_FORMAT` | Backend wire format: `openai` \| `anthropic` | `openai` |
| `LLM_BASE_URL` | Private LLM base URL (trailing `/v1` optional for `anthropic`) | required |
| `LLM_API_KEY` | API key (`none` if not needed) — `Bearer` on openai, `x-api-key` on anthropic | `none` |
| `LLM_MODEL` | Model name | required |
| `LLM_MAX_TOKENS` | Max output tokens | `8096` |
| `LLM_USE_MAX_COMPLETION_TOKENS` | Use `max_completion_tokens` param (openai only) | `false` |
| `LLM_TEMPERATURE` | Optional inference param | — |
| `LLM_TOP_P` | Optional inference param | — |
| `LLM_SEED` | Optional inference param (openai only) | — |
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
- **`traceId` (optional, logging only)** — the agent's Slack `threadId`, carried on the request
  and echoed in every worker log line for that message. `requestId` correlates the two
  processes; `traceId` correlates them to the **Slack thread a human is looking at**, so one
  grep spans all three. Agent-side it comes from an `AsyncLocalStorage` set in `investigate()`
  (no `LLMClient.chat()` signature change for a logging concern). Absent on older agents —
  never required, never used for routing.
  ```
  agent : [sqs-llm] → requestId=abc-123 trace=1785135868.123 msgs=7 tools=24 awaiting=2
  worker: Processing requestId=abc-123 trace=1785135868.123 msgs=7 tools=24
  worker: Done requestId=abc-123 trace=... 8241ms stop=tool_use content=[text,tool_use] in=12043 out=87
  ```

## File Structure
```
src/
├── config.ts    # All config from env vars
├── llm.ts       # Format dispatch + shared retry; OpenAI path, toOpenAIMessages()
├── anthropic.ts # Messages API path (/v1/messages) — no translation layer needed
├── socks.ts     # parseSocksProxy(), buildSocksFetch(), proxiedFetch() — shared by both paths
├── logger.ts    # Winston, LOG_LEVEL support, errDetail() (stack-preserving)
├── sqs.ts       # resolveQueueUrl() with auto-create, ensureRedrivePolicy()
├── message.ts   # parseSqsRequest() — body parse + validation (poison-pill guard)
├── types.ts     # SQSRequest, SQSResponse, LLMResponse, Message
└── worker.ts    # Poll loop, processMessage, DLQ forwarding, deadLetterRaw()
index.ts         # Entry point + graceful shutdown
```

## Testing
- `npm test` → `node --import tsx --test 'src/**/*.test.ts'` (Node >= 24 built-in runner + tsx, zero new deps)
- `*.test.ts` excluded from the `tsc` build so `dist/` stays clean
- Covered so far: `parseSqsRequest` (poison-pill validation), `toOpenAIMessages` (tool round-trip + tool-before-user ordering), `isEmptyTokenExhaustion`, `parseSocksProxy`/`buildSocksFetch`, gitops `resolve` incl. drift + base-add, `parseGitOpsRequest`, `prTitle`/`prBody`, GitHub App JWT
- Anthropic path: `toAnthropicContent`/`fromAnthropicResponse`/`messagesEndpoint` as pure functions
  (`anthropic.test.ts`), plus `anthropic.request.test.ts` — a stub HTTP server asserting the actual
  wire shape (`/v1/messages`, `x-api-key`, `anthropic-version`, top-level `system`, `input_schema`,
  no `Authorization`). That file sets env **before** a dynamic import, since config is read at
  module load; node:test gives each file its own process, so it affects nothing else.

## Known Issues Fixed
- `max_tokens` → some models require `max_completion_tokens` instead: `LLM_USE_MAX_COMPLETION_TOKENS=true`
- `top_p` unsupported by some models: leave `LLM_TOP_P` unset
- **Content blocks reached the model as stringified JSON** — see `toOpenAIMessages` above. The single biggest cause of garbled Slack output with a small private LLM.
- **Malformed tool-call arguments killed the whole request** with an opaque `Unexpected token` naming no tool.
- **Lost replies from `Promise.all([send, delete])`** — now publish-then-delete.
- **A truncated GitHub tree looked like "file not found"** — now an explicit error.
- **Errors logged without stacks** — `errDetail()` in `logger.ts` replaces `${err}` (which prints only `Error: message`) on every hot path.

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
