# Model handling

The wire format (`LLM_API_FORMAT`) and the `LLM_*` settings: [CONFIGURATION.md](CONFIGURATION.md#llm).

## Reasoning models

- `finish_reason: "length"` is surfaced to the agent as `max_tokens` (not disguised as a clean `end_turn`), so truncation is visible in both worker and agent logs.
- **Auto-retry safeguard:** if a response is cut off by the token limit with **no content at all** (a reasoning model spent the whole budget thinking), the worker retries once with **2× the token budget**. Partial answers are never retried. A `warn` log marks each retry — frequent retries mean `LLM_MAX_TOKENS` is too small.
- The agent's `SQS_LLM_TIMEOUT_SECONDS` must cover a slow call plus this retry (default there is `240`).

## Common model compatibility issues

| Error | Fix |
|-------|-----|
| `'max_tokens' is not supported` | Set `LLM_USE_MAX_COMPLETION_TOKENS=true` |
| `'top_p' is not supported` | Leave `LLM_TOP_P` unset |
| `'temperature' is not supported` | Leave `LLM_TEMPERATURE` unset |
