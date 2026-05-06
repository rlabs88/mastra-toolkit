import type { SessionUpdate, ToolCall, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';

export function inferToolKind(name?: string): ToolKind {
  if (!name) return 'other';
  const normalized = name.toLowerCase();
  if (normalized === 'workspace.read-file') return 'read';
  if (normalized === 'workspace.write-file' || normalized === 'workspace.replace-in-file') return 'edit';
  if (normalized === 'workspace.list-files') return 'search';
  if (['shell', 'bash', 'command', 'exec', 'execute', 'terminal', 'sandbox'].some((part) => normalized.includes(part))) return 'execute';
  return 'other';
}

export function mapMastraChunkToUpdates(chunk: unknown): SessionUpdate[] {
  if (!isRecord(chunk)) return [];
  const type = str(chunk.type);
  if (type === 'text-delta') return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textFrom(chunk) } }];
  if (type === 'reasoning-delta' || type === 'reasoning') return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: textFrom(chunk) }, _meta: { mastra: { reasoning: chunk } } }];
  if (type === 'finish') {
    const usage = isRecord(chunk.usage) ? chunk.usage : isRecord(chunk.payload?.usage) ? chunk.payload.usage : undefined;
    return usage ? [{ sessionUpdate: 'usage_update', used: num(usage, 'totalTokens') ?? 0, size: num(usage, 'totalTokens') ?? 0, _meta: { mastra: chunk } }] : [];
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
    const status = phase === "delegation_complete" ? (payload.success === false ? "failed" : "completed") : "in_progress";
    const summary = {
      target: payload.delegatedAgentId ?? payload.delegatedName,
      prompt: payload.prompt,
      response: payload.response,
      error: payload.error,
      success: payload.success,
      durationMs: payload.durationMs,
    };
    return [{
      sessionUpdate: "tool_call_update",
      toolCallId: str(payload.delegationId) ?? fallbackId,
      status,
      title: str(payload.delegatedName) ?? str(payload.delegatedAgentId) ?? "delegation",
      kind: "other",
      rawInput: payload.prompt,
      rawOutput: payload.response ?? payload.error,
      content: [{ type: "content", content: { type: "text", text: JSON.stringify(summary) } }],
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
      const call: ToolCall & { sessionUpdate: 'tool_call' } = {
        sessionUpdate: 'tool_call',
        toolCallId,
        status: 'in_progress',
        title,
        kind,
        rawInput: p.args,
        _meta: mastraMeta(chunk),
      };
      return [call];
    }

    const terminal = terminalMetaForChunk(kind, p);
    const update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' } = {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      ...toolUpdateFields(type, p, title, kind),
      _meta: mastraMeta(chunk, terminal ? { terminal } : undefined),
    };
    return [update];
  }
  return [];
}

function toolUpdateFields(type: string, payload: Record<string, any>, title: string, kind: ToolKind): Omit<ToolCallUpdate, 'toolCallId' | '_meta'> {
  if (type === 'tool-call-input-streaming-start') {
    return { status: 'in_progress', title, kind };
  }

  if (type === 'tool-call-delta') {
    return {
      status: 'in_progress',
      ...(str(payload.toolName) || str(payload.name) ? { title, kind } : {}),
      rawInput: { argsTextDelta: payload.argsTextDelta },
    };
  }

  if (type === 'tool-call-input-streaming-end') {
    return {
      status: 'in_progress',
      ...(str(payload.toolName) || str(payload.name) ? { title, kind } : {}),
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

  return {
    status: 'pending',
    title,
    kind,
    rawInput: payload.args,
    rawOutput: output,
    content: [{ type: 'content', content: { type: 'text', text: stringifyToolContent({ args: payload.args, result: payload.result, error: payload.error }) } }],
  };
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
