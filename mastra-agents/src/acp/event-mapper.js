export function inferToolKind(name) {
    if (!name)
        return 'other';
    if (name === 'workspace.read-file')
        return 'read';
    if (name === 'workspace.write-file' || name === 'workspace.replace-in-file')
        return 'edit';
    if (name === 'workspace.list-files')
        return 'search';
    if (name.includes('shell') || name.includes('sandbox'))
        return 'execute';
    return 'other';
}
export function mapMastraChunkToUpdates(chunk) {
    if (!isRecord(chunk))
        return [];
    const type = str(chunk.type);
    if (type === 'text-delta')
        return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textFrom(chunk) } }];
    if (type === 'reasoning-delta' || type === 'reasoning')
        return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: textFrom(chunk) }, _meta: { mastra: { reasoning: chunk } } }];
    if (type === 'finish')
        return chunk.usage ? [{ sessionUpdate: 'usage_update', used: num(chunk.usage, 'totalTokens') ?? 0, size: num(chunk.usage, 'totalTokens') ?? 0 }] : [];

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
        const status = type === 'tool-result' ? 'completed' : type === 'tool-error' ? 'failed' : (type === 'tool-call-input-streaming-start' ? 'in_progress' : 'pending');
        const update = {
            sessionUpdate: 'tool_call_update',
            toolCallId: str(p.toolCallId) ?? str(p.id) ?? 'unknown',
            status,
            title: str(p.toolName) ?? str(p.name) ?? 'tool',
            kind: inferToolKind(str(p.toolName) ?? str(p.name)),
            rawInput: p.args,
            rawOutput: p.error ?? p.result,
            content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ args: p.args, result: p.result, error: p.error }) } }],
            _meta: { mastra: chunk },
        };
        return [update];
    }
    return [];
}
const isRecord = (v) => typeof v === 'object' && !!v;
const str = (v) => (typeof v === 'string' ? v : undefined);
const idPart = (v) => {
    if (typeof v === 'string')
        return v.length > 0 ? v : undefined;
    if (typeof v === 'number')
        return Number.isFinite(v) ? String(v) : undefined;
    if (typeof v === 'boolean')
        return String(v);
    return undefined;
};
const textFrom = (c) => str(c.text) ?? str(c.delta) ?? str(c.payload?.text) ?? '';
const num = (o, k) => (typeof o?.[k] === 'number' ? o[k] : undefined);
