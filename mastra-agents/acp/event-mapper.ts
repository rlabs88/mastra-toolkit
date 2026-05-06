import type { SessionUpdate, ToolCall, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';

interface ToolOutputState {
  response: string;
  thought: string;
  activity: string[];
}

interface MastraChunkMappingState {
  toolInputDeltas: Map<string, string>;
  toolOutputs: Map<string, ToolOutputState>;
}

export function createMastraChunkMapper() {
  const state: MastraChunkMappingState = {
    toolInputDeltas: new Map(),
    toolOutputs: new Map(),
  };
  return (chunk: unknown) => mapMastraChunkToUpdates(chunk, state);
}

export function inferToolKind(name?: string): ToolKind {
  if (!name) return 'other';
  const normalized = name.toLowerCase();
  if (normalized === 'workspace.read-file') return 'read';
  if (normalized === 'workspace.write-file' || normalized === 'workspace.replace-in-file') return 'edit';
  if (normalized === 'workspace.list-files') return 'search';
  if (['shell', 'bash', 'command', 'exec', 'execute', 'terminal', 'sandbox'].some((part) => normalized.includes(part))) return 'execute';
  return 'other';
}

export function mapMastraChunkToUpdates(chunk: unknown, state?: MastraChunkMappingState): SessionUpdate[] {
  if (!isRecord(chunk)) return [];
  const type = str(chunk.type);
  if (type === 'text-delta') return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textFrom(chunk) } }];
  if (type === 'reasoning-delta' || type === 'reasoning') return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: textFrom(chunk) }, _meta: { mastra: { reasoning: chunk } } }];
  if (type === 'finish') {
    const usage = isRecord(chunk.usage) ? chunk.usage : isRecord(chunk.payload?.usage) ? chunk.payload.usage : undefined;
    return usage ? [{ sessionUpdate: 'usage_update', used: num(usage, 'totalTokens') ?? 0, size: num(usage, 'totalTokens') ?? 0, _meta: { mastra: chunk } }] : [];
  }

  if (type === "observational-memory-event") {
    const payload = isRecord(chunk.payload) ? chunk.payload : {};
    const eventType = str(payload.type) ?? "om_event";
    const toolCallId = observationalMemoryToolCallId(payload, eventType);
    const title = observationalMemoryTitle(eventType);
    const status = observationalMemoryStatus(eventType);
    const text = observationalMemoryText(payload, eventType);

    if (observationalMemoryIsStart(eventType)) {
      return [{
        sessionUpdate: "tool_call",
        toolCallId,
        status,
        title,
        kind: "other",
        rawInput: payload,
        _meta: { mastra: chunk },
      }];
    }

    return [{
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      title,
      kind: "other",
      rawOutput: payload,
      content: [{ type: "content", content: { type: "text", text } }],
      _meta: { mastra: chunk },
    }];
  }

  if (type === "delegation-event") {
    const payload = isRecord(chunk.payload) ? chunk.payload : {};
    const fallbackIdParts = [
      idPart(payload.delegationId),
      idPart(payload.runId),
      idPart(payload.agentRunId),
      idPart(payload.threadId),
      idPart(payload.timestamp),
      idPart(payload.phase),
      idPart(payload.delegatedAgentId) ?? idPart(payload.delegatedName),
    ].filter(Boolean);
    const fallbackId = fallbackIdParts.length > 0 ? `delegation:${fallbackIdParts.join(":")}` : `delegation:${Date.now()}`;
    const phase = str(payload.phase) ?? "delegation";
    const toolCallId = str(payload.delegationId) ?? fallbackId;
    const title = str(payload.delegatedName) ?? str(payload.delegatedAgentId) ?? "delegation";
    const status = phase === "delegation_complete" ? (payload.success === false ? "failed" : "completed") : "in_progress";
    const summary = {
      target: payload.delegatedAgentId ?? payload.delegatedName,
      prompt: payload.prompt,
      response: payload.response,
      error: payload.error,
      success: payload.success,
      durationMs: payload.durationMs,
    };
    if (phase === "delegation_start") {
      const input = normalizePromptInput(payload.prompt);
      const content = promptContent(input);
      return [{
        sessionUpdate: "tool_call",
        toolCallId,
        status,
        title,
        kind: "other",
        ...(input ? { rawInput: input } : {}),
        ...(content ? { content } : {}),
        _meta: { mastra: chunk },
      }];
    }

    const output = payload.response ?? payload.error ?? summary;
    const input = normalizePromptInput(payload.prompt);
    return [{
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      title,
      kind: "other",
      ...(input ? { rawInput: input } : {}),
      rawOutput: output,
      content: [{ type: "content", content: { type: "text", text: stringifyToolContent(output) } }],
      _meta: { mastra: chunk },
    }];
  }

  if (type?.startsWith('tool-')) {
    const p = isRecord(chunk.payload) ? chunk.payload : chunk;
    const toolName = str(p.toolName) ?? str(p.name);
    const toolCallId = str(p.toolCallId) ?? str(p.id) ?? 'unknown';
    const title = toolName ?? 'tool';
    const kind = inferToolKind(toolName);

    if (type === 'tool-call') {
      const rawInput = normalizeToolInput(toolName, p.args);
      const content = promptContent(rawInput);
      const call: ToolCall & { sessionUpdate: 'tool_call' } = {
        sessionUpdate: 'tool_call',
        toolCallId,
        status: 'in_progress',
        title,
        kind,
        ...(rawInput ? { rawInput } : {}),
        ...(content ? { content } : {}),
        _meta: mastraMeta(chunk),
      };
      return [call];
    }

    if (type === 'tool-output') {
      const contentText = state ? updateNestedToolOutput(state, toolCallId, p.output) : nestedToolOutputText(p.output);
      if (contentText) {
        return [{
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          title,
          kind,
          rawOutput: p.output,
          content: textContent(contentText),
          _meta: mastraMeta(chunk),
        }];
      }
      return [];
    }

    const terminal = terminalMetaForChunk(kind, p);
    const fields = toolUpdateFields(type, p, title, kind, state);
    if (!fields) return [];
    const update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' } = {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      ...fields,
      _meta: mastraMeta(chunk, terminal ? { terminal } : undefined),
    };
    return [update];
  }
  return [];
}

function toolUpdateFields(type: string, payload: Record<string, any>, title: string, kind: ToolKind, state?: MastraChunkMappingState): Omit<ToolCallUpdate, 'toolCallId' | '_meta'> | undefined {
  const toolName = str(payload.toolName) ?? str(payload.name);
  const isAgentTool = isAgentToolName(toolName);

  if (type === 'tool-call-input-streaming-start') {
    if (isAgentTool) return undefined;
    return { status: 'in_progress', title, kind };
  }

  if (type === 'tool-call-delta') {
    const toolCallId = str(payload.toolCallId) ?? str(payload.id);
    const accumulatedInput = toolCallId && state && typeof payload.argsTextDelta === 'string'
      ? appendInputDelta(state, toolCallId, payload.argsTextDelta)
      : undefined;
    const parsedInput = parseJsonObject(accumulatedInput);
    if (isAgentTool && !parsedInput) return undefined;
    const rawInput = parsedInput ? normalizeToolInput(toolName, parsedInput) : { argsTextDelta: payload.argsTextDelta };
    return {
      status: 'in_progress',
      ...(toolName ? { title, kind } : {}),
      rawInput,
      ...(promptContent(rawInput) ? { content: promptContent(rawInput) } : {}),
    };
  }

  if (type === 'tool-call-input-streaming-end') {
    if (isAgentTool) return undefined;
    return {
      status: 'in_progress',
      ...(toolName ? { title, kind } : {}),
    };
  }

  const output = payload.error ?? payload.result;
  if (type === 'tool-result' || type === 'tool-error') {
    return {
      status: type === 'tool-error' ? 'failed' : 'completed',
      ...(str(payload.toolName) || str(payload.name) ? { title, kind } : {}),
      rawOutput: output,
      content: [{ type: 'content', content: { type: 'text', text: stringifyToolContent(output) } }],
    };
  }

  const rawInput = normalizeToolInput(toolName, payload.args);
  const content = promptContent(rawInput);
  return {
    status: 'pending',
    title,
    kind,
    ...(rawInput ? { rawInput } : {}),
    rawOutput: output,
    content: content ?? [{ type: 'content', content: { type: 'text', text: stringifyToolContent({ args: payload.args, result: payload.result, error: payload.error }) } }],
  };
}

function appendInputDelta(state: MastraChunkMappingState, toolCallId: string, delta: string) {
  const next = `${state.toolInputDeltas.get(toolCallId) ?? ""}${delta}`;
  state.toolInputDeltas.set(toolCallId, next);
  return next;
}

function normalizeToolInput(toolName: string | undefined, input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return normalizePromptInput(input);
  if (!isAgentToolName(toolName)) return input;

  const prompt = str(input.prompt);
  if (!prompt) return input;
  return { query: prompt, ...input };
}

function normalizePromptInput(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") return { query: input, prompt: input };
  if (isRecord(input)) return input;
  return undefined;
}

function promptContent(input: unknown): Array<{ type: "content"; content: { type: "text"; text: string } }> | undefined {
  const query = isRecord(input) ? str(input.query) ?? str(input.prompt) : undefined;
  if (!query) return undefined;
  return textContent(`query:\n${query}`);
}

function textContent(text: string): Array<{ type: "content"; content: { type: "text"; text: string } }> {
  return [{ type: "content", content: { type: "text", text } }];
}

function isAgentToolName(toolName: string | undefined) {
  return toolName?.toLowerCase().startsWith("agent-") ?? false;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function updateNestedToolOutput(state: MastraChunkMappingState, toolCallId: string, output: unknown): string | undefined {
  const existing = state.toolOutputs.get(toolCallId) ?? { response: "", thought: "", activity: [] };
  const next = nestedToolOutputDelta(output);
  if (!next) return nestedToolOutputText(output);

  if (next.kind === "response") {
    existing.response += next.text;
  } else if (next.kind === "thought") {
    existing.thought += next.text;
  } else {
    existing.activity.push(next.text);
    if (existing.activity.length > 8) existing.activity = existing.activity.slice(-8);
  }
  state.toolOutputs.set(toolCallId, existing);

  const sections: string[] = [];
  if (existing.response.trim()) sections.push(`response:\n${existing.response.trim()}`);
  if (existing.thought.trim()) sections.push(`thought:\n${existing.thought.trim()}`);
  if (existing.activity.length > 0) sections.push(`activity:\n${existing.activity.join("\n")}`);
  return sections.join("\n\n");
}

function nestedToolOutputText(output: unknown): string | undefined {
  return nestedToolOutputDelta(output)?.text;
}

function nestedToolOutputDelta(output: unknown): { kind: "response" | "thought" | "activity"; text: string } | undefined {
  if (!isRecord(output)) return undefined;
  const type = str(output.type);
  const payload = isRecord(output.payload) ? output.payload : {};

  if (type === "text-delta") {
    const text = textFrom(output);
    return text ? { kind: "response", text } : undefined;
  }

  if (type === "reasoning-delta" || type === "reasoning") {
    const text = textFrom(output);
    return text ? { kind: "thought", text } : undefined;
  }

  if (type === "tool-call") {
    const toolName = str(payload.toolName) ?? "tool";
    return { kind: "activity", text: `started ${toolName}: ${stringifyToolContent(payload.args)}` };
  }

  if (type === "tool-result" || type === "tool-error") {
    const toolName = str(payload.toolName) ?? "tool";
    const result = payload.error ?? payload.result;
    const status = type === "tool-error" ? "failed" : "completed";
    return { kind: "activity", text: `${status} ${toolName}: ${stringifyToolContent(result)}` };
  }

  if (type === "start") {
    const id = str(payload.id);
    return id ? { kind: "activity", text: `started ${id}` } : undefined;
  }

  return undefined;
}

function mastraMeta(chunk: unknown, extra?: Record<string, unknown>): Record<string, unknown> {
  return { mastra: chunk, ...(extra ?? {}) };
}

function terminalMetaForChunk(kind: ToolKind, payload: Record<string, any>): Record<string, unknown> | undefined {
  const result = isRecord(payload.result) ? payload.result : undefined;
  const error = isRecord(payload.error) ? payload.error : undefined;
  const source = result ?? error ?? payload;
  const output = terminalOutput(source);
  const command = terminalCommand(payload.args) ?? terminalCommand(source);
  const exitCode = num(source, 'exitCode') ?? num(source, 'exit_code') ?? num(source, 'code');
  const status = str(source.status);
  const isTerminalLike = kind === 'execute' || output !== undefined || command !== undefined || exitCode !== undefined;
  if (!isTerminalLike) return undefined;

  const terminal = withoutUndefined({
    output: output ?? stringOutput(payload.error ?? payload.result),
    command,
    exitCode,
    status,
  });
  return Object.keys(terminal).length > 0 ? terminal : undefined;
}

function terminalOutput(source: Record<string, any>): string | undefined {
  const stdout = str(source.stdout);
  const stderr = str(source.stderr);
  if (stdout && stderr) return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}`;
  return stdout ?? stderr ?? str(source.output) ?? str(source.text);
}

function terminalCommand(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!isRecord(value)) return undefined;
  const command = str(value.command) ?? str(value.cmd) ?? str(value.shell) ?? str(value.script);
  if (command) return command;
  const argv = Array.isArray(value.argv) ? value.argv : Array.isArray(value.args) ? value.args : undefined;
  return argv?.every((part) => typeof part === 'string') ? argv.join(' ') : undefined;
}

function observationalMemoryToolCallId(payload: Record<string, any>, eventType: string) {
  const cycleId = str(payload.cycleId);
  if (cycleId) return `observational-memory:${cycleId}`;
  const recordId = str(payload.recordId);
  if (recordId) return `observational-memory:${recordId}`;
  const threadId = str(payload.threadId);
  if (threadId) return `observational-memory:${eventType}:${threadId}`;
  return `observational-memory:${eventType}`;
}

function observationalMemoryTitle(eventType: string) {
  if (eventType.includes("reflection")) return "observational memory reflection";
  if (eventType.includes("buffering")) return "observational memory buffering";
  if (eventType.includes("activation")) return "observational memory activation";
  if (eventType.includes("thread_title")) return "observational memory thread title";
  return "observational memory";
}

function observationalMemoryStatus(eventType: string): "failed" | "completed" | "in_progress" {
  if (eventType.endsWith("_failed")) return "failed";
  if (eventType.endsWith("_end") || eventType === "om_activation" || eventType === "om_thread_title_updated") return "completed";
  return "in_progress";
}

function observationalMemoryIsStart(eventType: string) {
  return eventType.endsWith("_start");
}

function observationalMemoryText(payload: Record<string, any>, eventType: string) {
  if (eventType === "om_status" && isRecord(payload.windows)) {
    const active = isRecord(payload.windows.active) ? payload.windows.active : {};
    const messages = isRecord(active.messages) ? active.messages : {};
    const observations = isRecord(active.observations) ? active.observations : {};
    return `status: messages ${num(messages, "tokens") ?? 0}/${num(messages, "threshold") ?? 0}, observations ${num(observations, "tokens") ?? 0}/${num(observations, "threshold") ?? 0}`;
  }

  if (eventType.endsWith("_failed")) {
    return `failed: ${stringifyToolContent(payload.error)}`;
  }

  if (eventType === "om_observation_end") {
    return `observed ${num(payload, "tokensObserved") ?? 0} message tokens into ${num(payload, "observationTokens") ?? 0} observation tokens`;
  }

  if (eventType === "om_reflection_end") {
    return `reflected observations into ${num(payload, "compressedTokens") ?? 0} tokens`;
  }

  if (eventType === "om_buffering_end") {
    return `buffered ${num(payload, "tokensBuffered") ?? num(payload, "bufferedTokens") ?? 0} tokens`;
  }

  if (eventType === "om_activation") {
    return `activated ${num(payload, "chunksActivated") ?? 0} chunks and ${num(payload, "messagesActivated") ?? 0} messages`;
  }

  if (eventType === "om_thread_title_updated") {
    return str(payload.newTitle) ? `thread title updated: ${payload.newTitle}` : "thread title updated";
  }

  return stringifyToolContent(payload);
}

function stringifyToolContent(value: unknown): string {
  const output = stringOutput(value);
  return output ?? JSON.stringify(value ?? null);
}

function stringOutput(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  return terminalOutput(value) ?? str(value.message);
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && !!v && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const idPart = (v: unknown) => {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === 'boolean') return String(v);
  return undefined;
};
const textFrom = (c: Record<string, any>) => str(c.text) ?? str(c.delta) ?? str(c.payload?.text) ?? '';
const num = (o: any, k: string) => (typeof o?.[k] === 'number' ? o[k] : undefined);
