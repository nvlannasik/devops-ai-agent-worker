import OpenAI from "openai";
import { config } from "./config.js";
import logger from "./logger.js";
import type { LLMResponse, Message, ToolDefinition, ContentBlock } from "./types.js";

const client = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
});

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
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ],
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
