export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
}

export interface SQSRequest {
  requestId: string;
  messages: Message[];
  tools: ToolDefinition[];
  systemPrompt: string;
  // the agent's Slack threadId — logging only, so the agent log, this worker's log and
  // the Slack thread all join on one id. Optional: older agents don't send it.
  traceId?: string;
}

export interface SQSResponse {
  requestId: string;
  response?: LLMResponse;
  error?: string;
}
