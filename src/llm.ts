import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { socksConnector } from "fetch-socks";
import { config } from "./config.js";
import logger from "./logger.js";
import type { LLMResponse, Message, ToolDefinition, ContentBlock } from "./types.js";

// Parse a SOCKS proxy URL (socks5://[user:pass@]host:port; socks4:// → type 4) into the
// shape fetch-socks wants. Returns null for empty/invalid input (→ direct connection).
// Exported for unit tests.
export function parseSocksProxy(url: string): { type: 4 | 5; host: string; port: number; userId?: string; password?: string } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const type = u.protocol === "socks4:" || u.protocol === "socks4a:" ? 4 : 5;
  return {
    type,
    host: u.hostname,
    port: Number(u.port) || 1080,
    ...(u.username ? { userId: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

export type SocksProxyCfg = NonNullable<ReturnType<typeof parseSocksProxy>>;

// The agent speaks Anthropic-shaped content blocks; the private LLM speaks OpenAI chat.
// This used to be `JSON.stringify(m.content)` — which put the literal
// `[{"type":"tool_use",...}]` into the prompt as TEXT. A big model ignores the noise; a
// small one imitates it and answers with that JSON instead of calling a tool, which the
// agent then posts to Slack verbatim (and re-stringifies next turn → nested escaping).
// tool_use → assistant.tool_calls, tool_result → a role:"tool" message. Exported for tests.
export function toOpenAIMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");

    if (m.role === "assistant") {
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? "",
          type: "function" as const,
          function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({ role: "assistant", content: text, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) });
      continue;
    }
    // user turn: tool results must come FIRST — OpenAI requires every tool message to
    // follow the assistant turn that requested it, before any new user text
    for (const b of m.content.filter((b) => b.type === "tool_result")) {
      out.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: b.content ?? "" });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

// A fetch that dials through the SOCKS proxy. Uses undici's OWN fetch + Agent (not Node's
// global fetch): the connector's dispatcher must come from the SAME undici that runs the
// request, or the handler interfaces mismatch (UND_ERR_INVALID_ARG onRequestStart). TLS/SNI
// to the real host is preserved by the connector, so no /etc/hosts trick is needed.
// Exported for tests. Returns a fetch typed as the global one for the OpenAI SDK.
export function buildSocksFetch(proxy: SocksProxyCfg): typeof fetch {
  const agent = new Agent({ connect: socksConnector({ type: proxy.type, host: proxy.host, port: proxy.port, userId: proxy.userId, password: proxy.password }) });
  const f = (input: string | URL, init?: Record<string, unknown>) => undiciFetch(input, { ...init, dispatcher: agent });
  return f as unknown as typeof fetch;
}

function buildClient(): OpenAI {
  const proxy = parseSocksProxy(config.llm.socksProxy);
  if (!proxy) return new OpenAI({ baseURL: config.llm.baseUrl, apiKey: config.llm.apiKey });
  logger.info(`[llm] routing LLM API through SOCKS${proxy.type} proxy ${proxy.host}:${proxy.port}`);
  return new OpenAI({ baseURL: config.llm.baseUrl, apiKey: config.llm.apiKey, fetch: buildSocksFetch(proxy) });
}

const client = buildClient();

// Reasoning models can spend the ENTIRE output budget on hidden thinking and return no
// content at all (finish_reason=length, empty message). That specific failure gets one
// automatic retry with double the token budget — a partial answer is never retried.
export function isEmptyTokenExhaustion(res: LLMResponse): boolean {
  return res.stopReason === "max_tokens" && res.content.length === 0;
}

export async function callLLM(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string
): Promise<LLMResponse> {
  const first = await requestOnce(messages, tools, systemPrompt, config.llm.maxTokens);
  if (!isEmptyTokenExhaustion(first)) return first;

  logger.warn(
    `Empty response: reasoning consumed the whole ${config.llm.maxTokens}-token budget — retrying once with 2x`
  );
  return requestOnce(messages, tools, systemPrompt, config.llm.maxTokens * 2);
}

async function requestOnce(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string,
  maxTokens: number
): Promise<LLMResponse> {
  const tokenParam = config.llm.useMaxCompletionTokens
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };

  const response = await client.chat.completions.create({
    model: config.llm.model,
    ...tokenParam,
    ...(config.llm.reasoningEffort && { reasoning_effort: config.llm.reasoningEffort }),
    ...(config.llm.temperature !== undefined && { temperature: config.llm.temperature }),
    ...(config.llm.topP !== undefined && { top_p: config.llm.topP }),
    ...(config.llm.seed !== undefined && { seed: config.llm.seed }),
    stream: false,
    messages: [{ role: "system", content: systemPrompt }, ...toOpenAIMessages(messages)],
    // omit tools entirely when the agent disables them (tool budget reached) —
    // some OpenAI-compatible backends reject an empty tools array
    ...(tools.length > 0 && {
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    }),
  });

  const choice = response.choices[0];
  const content: ContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.type !== "function") continue;
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    });
  }

  // "length" = cut off by the token limit — surface it instead of disguising it as a clean
  // end_turn: reasoning models can burn the entire budget thinking and return empty content
  const stopReason =
    choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";

  return {
    content,
    stopReason: stopReason as LLMResponse["stopReason"],
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}
