import { config } from "./config.js";
import { proxiedFetch } from "./socks.js";
import type { ContentBlock, LLMResponse, Message, ToolDefinition } from "./types.js";

// The Anthropic Messages API path (`LLM_API_FORMAT=anthropic`).
//
// There is no `toAnthropicMessages` counterpart to `toOpenAIMessages` on purpose: the agent's
// wire format IS Anthropic's. `ContentBlock` is already `{type:"tool_use", id, name, input}` /
// `{type:"tool_result", tool_use_id, content}`, and `stopReason` is already the exact
// `end_turn | tool_use | max_tokens` union. The OpenAI path needs a translation layer
// precisely because it speaks a different shape; this one only needs re-keying.
//
// Blocks are still rebuilt field-by-field rather than passed through: `ContentBlock` is one
// loose union of all three shapes, so a `text` block carries `id`/`name`/`input` as absent-or-
// undefined keys, and the API rejects unknown keys on a block.

const ANTHROPIC_VERSION = "2023-06-01";

// ponytail: matches the OpenAI SDK's own default so both formats behave the same. The SQS
// visibility extender already covers long calls; this only stops a hung socket from holding
// a concurrency slot for ever. Env knob if a backend legitimately needs longer.
const REQUEST_TIMEOUT_MS = 600_000;

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

// Exported for tests.
export function toAnthropicContent(content: string | ContentBlock[]): string | AnthropicBlock[] {
  if (typeof content === "string") return content;
  const out: AnthropicBlock[] = [];
  for (const b of content) {
    if (b.type === "text") {
      // the API rejects an empty text block ("text content blocks must be non-empty"), which
      // the OpenAI path silently tolerates. Dropping it is safe — an empty block carries
      // nothing — while dropping a tool block would break tool_use/tool_result pairing.
      // ponytail: if this empties a message's content the API still 400s; the fix for that
      // belongs in the agent's sanitizeContentBlocks, not here.
      if (b.text) out.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      out.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} });
    } else {
      out.push({ type: "tool_result", tool_use_id: b.tool_use_id ?? "", content: b.content ?? "" });
    }
  }
  return out;
}

// `LLM_BASE_URL` is shared with the OpenAI path, where it conventionally already ends in /v1
// (e.g. http://vllm:8000/v1). Accept it with or without, so one env var works for both formats.
// Exported for tests.
export function messagesEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// Exported for tests — this is the half worth asserting on without a live backend.
export function fromAnthropicResponse(data: AnthropicResponse): LLMResponse {
  const content: ContentBlock[] = [];
  for (const b of data.content ?? []) {
    // `thinking` / `redacted_thinking` blocks appear when extended thinking is on and are not
    // part of the answer — the agent has no representation for them.
    if (b.type === "text" && b.text) content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") {
      content.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} });
    }
  }

  // stop_reason also has stop_sequence / pause_turn / refusal — none of which are a token-limit
  // or tool signal, so they collapse to end_turn exactly as the OpenAI path collapses its own.
  const stopReason: LLMResponse["stopReason"] =
    data.stop_reason === "tool_use" ? "tool_use" : data.stop_reason === "max_tokens" ? "max_tokens" : "end_turn";

  return {
    content,
    stopReason,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      // unlike the OpenAI path, these are real numbers here rather than hardcoded zeros
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

const doFetch = proxiedFetch(config.llm.socksProxy) ?? fetch;

export async function anthropicRequest(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string,
  maxTokens: number
): Promise<LLMResponse> {
  const res = await doFetch(messagesEndpoint(config.llm.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.llm.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: config.llm.model,
      // required by this API, unlike OpenAI's — and the one knob the retry in callLLM turns
      max_tokens: maxTokens,
      // a top-level parameter here, NOT a role:"system" message
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      ...(tools.length > 0 && {
        // no {type:"function", function:{…}} envelope, and `input_schema` not `parameters`
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      }),
      ...(config.llm.temperature !== undefined && { temperature: config.llm.temperature }),
      ...(config.llm.topP !== undefined && { top_p: config.llm.topP }),
      // LLM_REASONING_EFFORT and LLM_SEED are deliberately not forwarded: neither exists in
      // this API (thinking is configured by a `thinking` budget object instead), and an
      // unknown top-level field is a 400.
    }),
  });

  if (!res.ok) {
    // the body carries the actual reason (bad model id, key, oversized request); without it
    // the worker reports a bare status to the agent and on to Slack
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  return fromAnthropicResponse((await res.json()) as AnthropicResponse);
}
