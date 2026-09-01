import OpenAI from "openai";
import { config } from "./config.js";
import { proxiedFetch } from "./socks.js";
import { anthropicRequest } from "./anthropic.js";
import { agentBuilderRequest } from "./agent-builder.js";
import logger from "./logger.js";
import type { LLMResponse, Message, ToolDefinition, ContentBlock } from "./types.js";

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

function buildClient(): OpenAI {
  const f = proxiedFetch(config.llm.socksProxy);
  return new OpenAI({ baseURL: config.llm.baseUrl, apiKey: config.llm.apiKey, ...(f && { fetch: f }) });
}

// only the OpenAI path needs a client object; the Anthropic path is a plain fetch
const client = config.llm.apiFormat === "openai" ? buildClient() : null;

// Called once at worker startup so a typo'd LLM_API_FORMAT stops the pod instead of failing
// the first alert of the day — the same rule the agent's backend registry follows.
export function assertApiFormat(): void {
  const f = config.llm.apiFormat;
  if (f !== "openai" && f !== "anthropic" && f !== "agent-builder") {
    throw new Error(`LLM_API_FORMAT="${f}" is not a known format (openai, anthropic, agent-builder)`);
  }
  logger.info(`[llm] API format: ${f}, model ${config.llm.model}`);
}

// Reasoning models can spend the ENTIRE output budget on hidden thinking and return no
// content at all (finish_reason=length, empty message). That specific failure gets one
// automatic retry with double the token budget — a partial answer is never retried.
export function isEmptyTokenExhaustion(res: LLMResponse): boolean {
  return res.stopReason === "max_tokens" && res.content.length === 0;
}

export async function callLLM(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string,
  traceId?: string
): Promise<LLMResponse> {
  const first = await requestOnce(messages, tools, systemPrompt, config.llm.maxTokens, traceId);
  if (!isEmptyTokenExhaustion(first)) return first;

  logger.warn(
    `Empty response: reasoning consumed the whole ${config.llm.maxTokens}-token budget — retrying once with 2x`
  );
  return requestOnce(messages, tools, systemPrompt, config.llm.maxTokens * 2, traceId);
}

async function requestOnce(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string,
  maxTokens: number,
  traceId?: string
): Promise<LLMResponse> {
  // Only the request/response shape differs per format. Everything around it — the
  // token-exhaustion retry above, the SQS envelope, the visibility extender — is shared.
  if (config.llm.apiFormat === "anthropic") {
    return anthropicRequest(messages, tools, systemPrompt, maxTokens);
  }

  // maxTokens has nowhere to go on this path: the Langflow envelope carries no token budget,
  // so the output cap lives in the flow's own model component. The retry above is therefore
  // dead code here — agent-builder never reports a max_tokens stop reason to trigger it.
  if (config.llm.apiFormat === "agent-builder") {
    return agentBuilderRequest(messages, tools, systemPrompt, traceId);
  }

  const tokenParam = config.llm.useMaxCompletionTokens
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };

  const response = await client!.chat.completions.create({
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
    // Small models emit malformed argument JSON regularly. An unguarded parse threw out
    // of the whole request, so one bad tool call killed the investigation with an opaque
    // "Unexpected token" and no hint of which tool. Keep the block (dropping it breaks
    // tool_use/tool_result pairing) with empty args — the tool's own schema validation
    // then tells the model what it got wrong, and it retries.
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      logger.warn(`Malformed tool arguments from the model for "${tc.function.name}": ${tc.function.arguments.slice(0, 200)}`);
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
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
