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
- **Message contract is shared with the agent:** request `{ requestId, messages, tools, systemPrompt }` → response `{ requestId, response | error }`. Changing this shape must be coordinated with `devops-ai-agent`'s `SQSLLMClient`.
- **Response queue is shared** across agent replicas; the agent routes by `requestId`. The worker just publishes the response with its `requestId` — don't assume a dedicated per-agent queue.
- **FIFO queues:** `MessageGroupId` / `MessageDeduplicationId` = `requestId`.
- Talks to the private LLM over an **OpenAI-compatible** API.

## Working style
- Chat in Indonesian; keep technical/English terms untranslated. **Docs are written in English.**
- Don't commit or push unless asked.
