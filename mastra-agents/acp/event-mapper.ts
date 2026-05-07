import type { SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk';

export type MastraChunkMapper = (chunk: unknown) => SessionUpdate[];

type MastraChunkMapperState = {
  startedToolCallIds: Set<string>;
  inputTextByToolCallId: Map<string, string>;
  titleByToolCallId: Map<string, string>;
  kindByToolCallId: Map<string, ToolCall['kind']>;
};

export function createMastraChunkMapper(): MastraChunkMapper {
  const state: MastraChunkMapperState = {
    startedToolCallIds: new Set(),
    inputTextByToolCallId: new Map(),
    titleByToolCallId: new Map(),
    kindByToolCallId: new Map(),
  };
  return (chunk) => mapMastraChunkToUpdates(chunk, state);
}

export function inferToolKind(name?: string): ToolCall['kind'] {
  if (!name) return 'other';
  if (name.startsWith('agent-') || name.includes('delegate')) return 'think';
  if (name === 'workspace.read-file') return 'read';
  if (name === 'workspace.write-file' || name === 'workspace.replace-in-file') return 'edit';
  if (name === 'workspace.list-files') return 'search';
  if (name.includes('grep') || name.includes('search') || name.includes('list')) return 'search';
  if (name.includes('read')) return 'read';
  if (name.includes('write') || name.includes('replace') || name.includes('edit')) return 'edit';
  if (name.includes('shell') || name.includes('sandbox')) return 'execute';
  return 'other';
}


function optionalContent(...values: unknown[]): ToolCallContent[] | undefined {
  for (const value of values) {
    const text = toolContentText(value);
    if (text) {
      return [{ type: 'content', content: { type: 'text', text } } as ToolCallContent];
    }
  }
  return undefined;
}

export function mapMastraChunkToUpdates(chunk: unknown, state?: MastraChunkMapperState): SessionUpdate[] {
  if (!isRecord(chunk)) return [];
  const type = str(chunk.type);
  if (type === 'text-delta') return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textFrom(chunk) } }];
  if (type === 'reasoning-delta' || type === 'reasoning') return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: textFrom(chunk) }, _meta: { mastra: { reasoning: chunk } } }];
  if (type === 'finish') return chunk.usage ? [{ sessionUpdate: 'usage_update', used: num(chunk.usage, 'totalTokens') ?? 0, size: num(chunk.usage, 'totalTokens') ?? 0 }] : [];

  if (type === 'delegation-event') {
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
    const fallbackId = fallbackIdParts.length > 0 ? `delegation:${fallbackIdParts.join(':')}` : `delegation:${Date.now()}`;
    const phase = str(payload.phase) ?? 'delegation';
    const toolCallId = str(payload.delegationId) ?? fallbackId;
    const title = str(payload.delegatedName) ?? str(payload.delegatedAgentId) ?? 'delegation';
    const content = optionalContent(payload.response, payload.error, payload.prompt);
    const base = {
      toolCallId,
      title,
      kind: 'think',
      rawInput: payload.prompt,
      rawOutput: payload.response ?? payload.error,
      content,
      _meta: { mastra: chunk },
    } satisfies Partial<ToolCall>;

    if (phase !== 'delegation_complete') {
      return [startToolCall(state, {
        ...base,
        status: 'in_progress',
        sessionUpdate: 'tool_call',
      })];
    }

    const status = payload.success === false ? 'failed' : 'completed';
    return withStartedToolCall(state, {
      sessionUpdate: 'tool_call',
      status: 'in_progress',
      ...base,
    }, {
      sessionUpdate: 'tool_call_update',
      status,
      ...base,
    });
  }

  if (type?.startsWith('tool-')) {
    const p = isRecord(chunk.payload) ? chunk.payload : chunk;
    const toolCallId = str(p.toolCallId) ?? str(p.id) ?? 'unknown';
    const explicitTitle = str(p.toolName) ?? str(p.name);
    const title = explicitTitle ?? state?.titleByToolCallId.get(toolCallId) ?? 'tool';
    const kind = inferToolKind(title);
    let content = type === 'tool-output'
      ? contentFromToolOutput(p.output)
      : optionalContent(p.result, p.error, p.delta, p.text, p.args);
    let rawInput = p.args ?? p.input;
    const rawOutput = p.error ?? p.result ?? p.output;

    if (type === 'tool-call-input-streaming-end') return [];

    if (type === 'tool-call-delta') {
      const nextInputText = accumulatedInputText(state, toolCallId, str(p.argsTextDelta) ?? str(p.delta) ?? str(p.text));
      rawInput = rawInput ?? nextInputText;
      content = content ?? contentFromInputText(nextInputText);
    }

    if (type === 'tool-call-input-streaming-start') {
      return [startToolCall(state, {
        sessionUpdate: 'tool_call',
        toolCallId,
        status: 'in_progress',
        title,
        kind,
        rawInput,
        rawOutput,
        content,
        _meta: { mastra: chunk },
      })];
    }

    const status = type === 'tool-result'
      ? 'completed'
      : type === 'tool-error'
        ? 'failed'
        : type === 'tool-call' && state?.startedToolCallIds.has(toolCallId)
          ? 'in_progress'
          : 'pending';

    const update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' } = {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status,
      ...(explicitTitle ? { title } : {}),
      ...(explicitTitle ? { kind } : state?.kindByToolCallId.has(toolCallId) ? { kind: state.kindByToolCallId.get(toolCallId)! } : {}),
      rawInput,
      rawOutput,
      content,
      _meta: { mastra: chunk },
    };

    if (type === 'tool-call') {
      return withStartedToolCall(state, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind,
        status: 'pending',
        rawInput,
        rawOutput,
        content,
        _meta: { mastra: chunk },
      }, update);
    }

    if (type === 'tool-result' || type === 'tool-error') {
      return withStartedToolCall(state, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind,
        status: 'pending',
        rawInput,
        _meta: { mastra: chunk },
      }, update);
    }

    return [update];
  }
  return [];
}

function startToolCall(state: MastraChunkMapperState | undefined, update: ToolCall & { sessionUpdate: 'tool_call' }): SessionUpdate {
  rememberToolCall(state, update);
  return update;
}

function withStartedToolCall(
  state: MastraChunkMapperState | undefined,
  initial: ToolCall & { sessionUpdate: 'tool_call' },
  update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' },
): SessionUpdate[] {
  if (!state) return [initial, update];
  if (state.startedToolCallIds.has(initial.toolCallId)) return [update];
  rememberToolCall(state, initial);
  return [initial, update];
}

function rememberToolCall(state: MastraChunkMapperState | undefined, update: ToolCall & { sessionUpdate: 'tool_call' }): void {
  if (!state) return;
  state.startedToolCallIds.add(update.toolCallId);
  if (update.title) state.titleByToolCallId.set(update.toolCallId, update.title);
  if (update.kind) state.kindByToolCallId.set(update.toolCallId, update.kind);
}

function contentFromToolOutput(output: unknown): ToolCallContent[] | undefined {
  if (!isRecord(output)) return optionalContent(output);
  const outputType = str(output.type);
  const payload = isRecord(output.payload) ? output.payload : {};
  if (outputType === 'text-delta') return optionalContent(payload.text);
  if (outputType === 'tool-result') return optionalContent(payload.result);
  if (outputType === 'tool-error' || outputType === 'error') return optionalContent(payload.error, payload.message);
  return undefined;
}

function accumulatedInputText(
  state: MastraChunkMapperState | undefined,
  toolCallId: string,
  delta: string | undefined,
): string | undefined {
  if (!delta) return state?.inputTextByToolCallId.get(toolCallId);
  if (!state) return delta;
  const text = `${state.inputTextByToolCallId.get(toolCallId) ?? ''}${delta}`;
  state.inputTextByToolCallId.set(toolCallId, text);
  return text;
}

function contentFromInputText(inputText: string | undefined): ToolCallContent[] | undefined {
  if (!inputText) return undefined;
  try {
    const parsed = JSON.parse(inputText);
    if (isRecord(parsed)) {
      return optionalContent(parsed.prompt, parsed.query, parsed.input, parsed.command, parsed.path) ?? optionalContent(inputText);
    }
  } catch {
    // Partial streamed JSON is still useful as progress text.
  }
  return optionalContent(inputText);
}

function toolContentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!isRecord(value)) return undefined;

  for (const key of ['text', 'message', 'objective', 'result', 'output', 'response', 'error', 'prompt', 'query', 'command', 'path']) {
    const nested = toolContentText(value[key]);
    if (nested) return nested;
  }

  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 12000 ? `${text.slice(0, 12000)}\n...` : text;
  } catch {
    return String(value);
  }
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && !!v;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const idPart = (v: unknown) => {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === 'boolean') return String(v);
  return undefined;
};
const textFrom = (c: Record<string, any>) => str(c.text) ?? str(c.delta) ?? str(c.payload?.text) ?? '';
const num = (o: any, k: string) => (typeof o?.[k] === 'number' ? o[k] : undefined);
