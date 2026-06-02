import OpenAI from "openai";
import { config } from "./config.js";
import type { LLMResponse, Message, ToolDefinition, ContentBlock } from "./types.js";

const client = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
});

export async function callLLM(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string
): Promise<LLMResponse> {
  const response = await client.chat.completions.create({
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ],
    tools: tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
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

  return {
    content,
    stopReason: (choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn") as LLMResponse["stopReason"],
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}
