import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';

export function inferToolKind(name?: string): ToolCallUpdate['kind'] {
  if (!name) return 'other';
  if (name === 'workspace.read-file') return 'read';
  if (name === 'workspace.write-file' || name === 'workspace.replace-in-file') return 'edit';
  if (name === 'workspace.list-files') return 'search';
  if (name.includes('shell') || name.includes('sandbox')) return 'execute';
  return 'other';
}

export function mapMastraChunkToUpdates(chunk: unknown): SessionUpdate[] {
  if (!isRecord(chunk)) return [];
  const type = str(chunk.type);
  if (type === 'text-delta') return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textFrom(chunk) } }];
  if (type === 'reasoning-delta' || type === 'reasoning') return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: textFrom(chunk) }, _meta: { mastra: { reasoning: chunk } } }];
  if (type === 'finish') return chunk.usage ? [{ sessionUpdate:'usage_update', used: num(chunk.usage,'totalTokens') ?? 0, size: num(chunk.usage,'totalTokens') ?? 0 }] : [];

  if (type?.startsWith('tool-')) {
    const p = isRecord(chunk.payload) ? chunk.payload : chunk;
    const status = type === 'tool-result' ? 'completed' : type === 'tool-error' ? 'failed' : (type === 'tool-call-input-streaming-start' ? 'in_progress' : 'pending');
    const update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' } = {
      sessionUpdate: 'tool_call_update',
      toolCallId: str(p.toolCallId) ?? str(p.id) ?? 'unknown',
      status,
      title: str(p.toolName) ?? str(p.name) ?? 'tool',
      kind: inferToolKind(str(p.toolName) ?? str(p.name)),
      rawInput: p.args,
      rawOutput: p.error ?? p.result,
      content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ args:p.args, result:p.result, error:p.error }) } }],
      _meta: { mastra: chunk },
    };
    return [update];
  }
  return [];
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && !!v;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const textFrom = (c: Record<string, any>) => str(c.text) ?? str(c.delta) ?? str(c.payload?.text) ?? '';
const num = (o: any, k: string) => (typeof o?.[k] === 'number' ? o[k] : undefined);
