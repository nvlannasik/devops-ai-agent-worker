# llm-worker

SQS consumer that bridges `devops-ai-agent` requests to a private LLM. Runs inside the
private network — **outbound-only** access to AWS SQS, no inbound exceptions. Part of a
3-repo system: `devops-ai-agent`, `devops-mcp-server`, `llm-worker` (this).

**Read `MEMORY_BANK.md` before changing the SQS flow or message contract** — it holds the
architecture and design decisions.

## Commands
- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (`node:test` + tsx, zero extra deps)
- Dev: `npm run dev`
- **Node 24 required.** Default shell node is v14 — use `~/.nvm/versions/node/v24.16.0/bin` on the PATH.

## Conventions
- TypeScript ESM (NodeNext). Test files `*.test.ts` excluded from the build.

## Gotchas (see MEMORY_BANK.md for the full list)
- **Message contract is shared with the agent:** request `{ requestId, messages, tools, systemPrompt, traceId? }` → response `{ requestId, response | error }`. Changing this shape must be coordinated with `devops-ai-agent`'s `SQSLLMClient`. `traceId` (the agent's Slack threadId) is logging-only and optional.
- **`LLM_API_FORMAT` picks the wire format, not the vendor:** `openai` (default, `/v1/chat/completions`), `anthropic` (`/v1/messages`, `anthropic.ts`), or `agent-builder` (`agent-builder.ts`). The Anthropic path needs **no** translation layer — the agent's blocks already are Anthropic blocks — so don't add one. `LLM_SEED` / `LLM_REASONING_EFFORT` / `LLM_USE_MAX_COMPLETION_TOKENS` are openai-only; sending them to `/v1/messages` is a 400.
- **`agent-builder` is a stopgap, and the migration off it is one env var.** The private LLM has its own OpenAI-compatible endpoint, but getting access to it needs a long approval; the agent builder (a self-service Langflow platform) needs none. So `agent-builder` buys tool calling today, and flipping `LLM_API_FORMAT` to `openai` when approval lands retires the whole file. Keep the flow itself **empty** — Chat Input → Model → Chat Output. Adding memory duplicates the transcript we already resend every round; a prompt component splits the contract across two repos; an output parser mangles both the Slack mrkdwn and the JSON; a tool component would require exposing the MCP server to the platform, which is the one thing this design exists to avoid.
- **On the `agent-builder` path `LLM_BASE_URL` is the full run endpoint** (`https://<host>/api/v1/run/<flow-id>`), not a `/v1` base, and `LLM_API_KEY` goes out as `x-api-key`. `LLM_MODEL` and `LLM_MAX_TOKENS` are inert — the model and its output cap live in the flow. The envelope reports no token counts, so `usage` is omitted and the agent's usage tracking shows zeros for this backend.
- **`toOpenAIMessages` (`llm.ts`) must stay in sync** with the agent's `openai-compatible.ts` copy. Never flatten content blocks with `JSON.stringify` — a small model imitates the JSON it sees and answers with it instead of calling a tool.
- **The backend needs its tool-call parser on** (vLLM: `--enable-auto-tool-choice --tool-call-parser <parser>`), or no `tool_calls` are ever returned.
- **Response queue is shared** across agent replicas; the agent routes by `requestId`. The worker just publishes the response with its `requestId` — don't assume a dedicated per-agent queue.
- **FIFO queues:** `MessageGroupId` / `MessageDeduplicationId` = `requestId`.
- Talks to the private LLM over an **OpenAI-compatible** API by default; see `LLM_API_FORMAT` above.

## Working style
- Chat in Indonesian; keep technical/English terms untranslated. **Docs are written in English.**
- Don't commit or push unless asked.
