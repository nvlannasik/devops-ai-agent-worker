import { config } from "./config.js";
import logger from "./logger.js";
import { proxiedFetch } from "./socks.js";
import type { ContentBlock, LLMResponse, Message, ToolDefinition } from "./types.js";

// The agent builder path (`LLM_API_FORMAT=agent-builder`).
//
// The agent builder is a self-service flow platform in front of the private LLM. We use it
// as a transport, not as an agent: the flow is Chat Input → Model → Chat Output and nothing
// else. No memory (this worker resends the whole transcript every round, so a remembering
// flow would show the model its history twice), no prompt component (the contract below is
// versioned here, not in someone's UI), no output parser (it would mangle the Slack mrkdwn
// and the JSON alike), and above all no tool component — the flow reasons, the agent acts,
// and the MCP server is never exposed to the platform.
//
// The price of that envelope: it has no `tools` field and no `system` field. Everything is
// flattened into one `input_value` string, and a tool request comes back as JSON inside the
// answer text rather than as a native tool_call. That is what toAgentBuilderPrompt and
// parseReply are for. When the private LLM's own OpenAI-compatible endpoint is approved,
// `LLM_API_FORMAT=openai` replaces this whole file with native tool calling.

// ponytail: same default as the other two formats. The SQS visibility extender covers long
// calls — a recorded full RCA took 104 s — this only stops a hung socket holding a slot.
const REQUEST_TIMEOUT_MS = 600_000;

// Sent at the top of input_value on every round that offers tools. Three of these lines are
// paid for by a recorded probe failure rather than by taste:
//   - the four-call cap: probe L1 asked for seven tools in one reply and the JSON broke at
//     the seventh. Shorter replies break less. repairToolCalls below is the net, not the fix.
//   - "never assert what a tool did not return": probe L3 ruled out node pressure it had
//     never measured, and invented a leader election that appeared in no tool result.
//   - "nothing after the Confidence line": probe L3 appended a TIME CONTEXT line that would
//     have landed in Slack verbatim.
const TOOL_PROTOCOL = `You cannot run tools yourself. The calling agent runs them for you inside the cluster.
Each round you may either ask for tool results, or deliver the final answer.

TO ASK FOR TOOLS — reply with ONLY this JSON. No prose before or after it, no code fence:
{"tool_calls":[{"id":"c1","name":"<tool>","args":{...}}]}
Ask for up to four tools in one reply; they run in parallel. Ask for everything you can
determine now — a round trip is expensive — but never more than four in one reply.

TO FINISH — reply with the final answer as prose, in the format the instructions above give.
Never mix the two: a reply containing that JSON is treated as a tool request and its prose is
discarded.

Stop asking and answer as soon as the evidence supports a conclusion. Never assert what a
tool did not return: if you did not run it, you may not rule it out. Say "inconclusive" and
name what you ruled out rather than filling the template with a cause you cannot show.
Output nothing after the final line of the required format.`;

// Shown to the model with its own unparseable reply when the repair below could not save it.
// Probe L4 confirmed the model recovers from exactly this, so it is worth one round trip.
const CORRECTION = `Your last reply could not be parsed. It was not a valid JSON object of the required shape,
and it was not a final answer either.

Reply again. Either ONLY a JSON object exactly like
{"tool_calls":[{"id":"c1","name":"<tool>","args":{...}}]}
with no prose before or after it, all keys quoted and args a JSON object; or the final answer
as prose with no JSON in it.

This is the only correction you will receive.`;

/** `k8s_get_pod_logs(namespace, name, container?, previous?) — container logs` */
function toolSignature(tool: ToolDefinition): string {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(schema.required ?? []);
  // Full JSON Schema per tool would be the obvious thing to send, but there are ~35 tools and
  // the payload ceiling was never probed. A signature line carries what the model actually
  // needs — the arg names and which may be omitted.
  const args = Object.keys(schema.properties ?? {}).map((k) => (required.has(k) ? k : `${k}?`));
  return `${tool.name}(${args.join(", ")}) — ${tool.description.replace(/\s+/g, " ").trim()}`;
}

function renderTranscript(messages: Message[]): string {
  // tool_result carries only the id, so the tool's name has to be recovered from the tool_use
  // that asked for it — "[c1 k8s_describe_pod]" reads far better to the model than "[c1]".
  const toolNames = new Map<string, string>();
  const lines: string[] = [];

  for (const m of messages) {
    const label = m.role === "user" ? "User" : "Assistant";
    if (typeof m.content === "string") {
      if (m.content) lines.push(`${label}: ${m.content}`);
      continue;
    }

    const texts = m.content.filter((b) => b.type === "text" && b.text);
    const toolUses = m.content.filter((b) => b.type === "tool_use");
    const results = m.content.filter((b) => b.type === "tool_result");

    // results before text on a user turn, matching the OpenAI path: the agent appends its
    // budget notices after the tool output they comment on.
    if (results.length > 0) {
      const body = results
        .map((b) => {
          const name = toolNames.get(b.tool_use_id ?? "");
          return `[${b.tool_use_id ?? ""}${name ? ` ${name}` : ""}]\n${b.content ?? ""}`;
        })
        .join("\n\n");
      lines.push(`User: === Tool results ===\n${body}`);
    }

    for (const t of texts) lines.push(`${label}: ${t.text}`);

    if (toolUses.length > 0) {
      for (const b of toolUses) toolNames.set(b.id ?? "", b.name ?? "");
      // Echoed back in the exact shape TOOL_PROTOCOL asks for, so round N+1 never shows the
      // model a rendering of its own request that it did not write.
      const calls = toolUses.map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: b.input ?? {} }));
      lines.push(`Assistant: ${JSON.stringify({ tool_calls: calls })}`);
    }
  }

  return lines.join("\n\n");
}

/**
 * Flattens the whole request into the single `input_value` string the Langflow envelope
 * allows. Exported for tests — this is the half worth asserting on without a live flow.
 */
export function toAgentBuilderPrompt(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string
): string {
  const parts = [systemPrompt.trim()];
  // No tools means nothing to ask for: conversation mode sends none, and the contract plus
  // the catalog would be several KB of dead weight against an unknown payload ceiling.
  if (tools.length > 0) {
    parts.push(`=== Tool protocol ===\n${TOOL_PROTOCOL}`);
    parts.push(`=== Available tools ===\n${tools.map(toolSignature).join("\n")}`);
  }
  parts.push(`--- Conversation ---\n${renderTranscript(messages)}`);
  return parts.join("\n\n");
}

interface Envelope {
  outputs?: Array<{
    outputs?: Array<{ results?: { message?: { text?: string; error?: boolean } } }>;
  }>;
}

/**
 * Digs the answer out of the Langflow envelope. Throws rather than returning a string on any
 * shape it does not recognise: a silent "" here becomes an empty RCA in Slack.
 * Exported for tests.
 */
export function extractText(data: unknown): string {
  const message = (data as Envelope)?.outputs?.[0]?.outputs?.[0]?.results?.message;
  if (!message || typeof message.text !== "string") {
    throw new Error(`Agent builder returned no output: ${JSON.stringify(data).slice(0, 500)}`);
  }
  // A failure can arrive as HTTP 200 with error:true inside the message — probe P4 was never
  // run, so we cannot assume a non-2xx status. Unchecked, the error string would be posted to
  // Slack dressed as an RCA.
  if (message.error === true) {
    throw new Error(`Agent builder flow error: ${message.text.slice(0, 500)}`);
  }
  return message.text;
}

function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
  return fenced ? fenced[1].trim() : text.trim();
}

// Probe L1's reply lost the opening brace of its seventh call: `..."step":"60"}},"id":"c7"`.
// In this schema "id" is only ever legal directly after `{`, so `},"id":` cannot occur in a
// well-formed reply and the repair is unambiguous. A valid array reads `},{"id":` and is
// left alone.
function repairToolCalls(json: string): string {
  return json.replace(/\},\s*"id"\s*:\s*"/g, '},{"id":"');
}

interface RawToolCall {
  name?: unknown;
  args?: unknown;
}

/**
 * Turns one flow reply into an LLMResponse.
 *
 * Returns `null` for the one case the caller must handle rather than post: a reply that was
 * meant to be a tool request and cannot be parsed even after repair. Prose — including prose
 * that merely talks about tool_calls — is a finished answer.
 * Exported for tests.
 */
export function parseReply(text: string): LLMResponse | null {
  const body = stripFence(text);
  const finished = (): LLMResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

  const looksLikeToolRequest = body.startsWith("{") || /"tool_calls"\s*:/.test(body);
  if (!looksLikeToolRequest) return finished();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = JSON.parse(repairToolCalls(body));
      logger.warn("Repaired a malformed tool_calls reply from the agent builder");
    } catch {
      return null;
    }
  }

  const calls = (parsed as { tool_calls?: unknown })?.tool_calls;
  // Valid JSON that is not a tool request — the RCA itself, or the {"need":[…]} shape — is an
  // answer. Only the agent decides what to do with it.
  if (!Array.isArray(calls) || calls.length === 0) return finished();

  const content: ContentBlock[] = calls.map((raw, i) => {
    const call = raw as RawToolCall;
    return {
      type: "tool_use",
      // Positional and ours. Probe L2 reused c3..c6 across rounds; an id that collides with a
      // live tool_use/tool_result pair would mis-route a result.
      id: `c${i + 1}`,
      name: String(call.name ?? ""),
      input: toArgs(call.args),
    };
  });

  return { content, stopReason: "tool_use" };
}

// Small models sometimes emit args as a JSON *string* rather than an object — the same class
// of malformity llm.ts already guards on the OpenAI path. Keep the block either way: dropping
// it would break tool_use/tool_result pairing, and the tool's own schema validation tells the
// model what it got wrong.
function toArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      logger.warn(`Tool args arrived as an unparseable string: ${args.slice(0, 200)}`);
      return {};
    }
  }
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

const doFetch = proxiedFetch(config.llm.socksProxy) ?? fetch;

async function post(inputValue: string, sessionId?: string): Promise<string> {
  // LLM_BASE_URL is the full run endpoint here (https://<host>/api/v1/run/<flow-id>), not a
  // /v1 base as on the other two paths. One env var, one secret, no new GitOps values.
  const res = await doFetch(config.llm.baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.llm.apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      input_type: "chat",
      output_type: "chat",
      input_value: inputValue,
      // The agent's Slack threadId. Cosmetic for correctness — the flow has no memory and we
      // own the transcript — but it joins the platform's own logs to ours and to the thread.
      ...(sessionId && { session_id: sessionId }),
    }),
  });

  if (!res.ok) {
    throw new Error(`Agent builder ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return extractText(await res.json());
}

export async function agentBuilderRequest(
  messages: Message[],
  tools: ToolDefinition[],
  systemPrompt: string,
  traceId?: string
): Promise<LLMResponse> {
  const prompt = toAgentBuilderPrompt(messages, tools, systemPrompt);

  const first = await post(prompt, traceId);
  const parsed = parseReply(first);
  if (parsed) return parsed;

  // One correction, mirroring the single retry callLLM already spends on token exhaustion.
  logger.warn("Agent builder sent an unparseable tool request — spending the one correction");
  const second = await post(`${prompt}\n\nAssistant: ${first}\n\nUser: ${CORRECTION}`, traceId);
  const retried = parseReply(second);
  if (retried) return retried;

  // Deliberate: return the wreckage as the answer rather than throwing. A throw would retry
  // the SQS message and eventually DLQ it, losing the whole investigation silently. This way
  // it reaches Slack — parseRca() needs two *bold* sections and app/index.ts looks for a Root
  // Cause heading, so a JSON blob posts as plain text rather than as an RCA card. Ugly and
  // visible beats lost and quiet.
  logger.error("Agent builder tool request still unparseable after the correction — returning it as the answer");
  return { content: [{ type: "text", text: second }], stopReason: "end_turn" };
}

// No usage block: the Langflow envelope reports no token counts, and `usage` is optional on
// LLMResponse. The agent's usage tracking shows zeros for this backend — a property of the
// transport, not something to invent numbers for.
