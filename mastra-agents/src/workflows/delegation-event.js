export function delegationPayloadFromEvent(event) {
  const payload = isRecord(event?.payload) ? event.payload : event;
  const phase = typeof event?.type === 'string' ? event.type : 'delegation';
  return {
    phase,
    delegationId: stringFromUnknown(payload.delegationId) ?? stringFromUnknown(payload.id),
    delegatedName: stringFromUnknown(payload.delegatedName) ?? stringFromUnknown(payload.agentName) ?? stringFromUnknown(payload.targetAgentName),
    delegatedAgentId: stringFromUnknown(payload.delegatedAgentId) ?? stringFromUnknown(payload.agentId) ?? stringFromUnknown(payload.targetAgentId),
    prompt: structuredFromUnknown(payload.prompt ?? payload.query ?? payload.input),
    response: structuredFromUnknown(payload.response ?? payload.result ?? payload.output),
    error: structuredFromUnknown(payload.error),
    success: booleanFromUnknown(payload.success),
    durationMs: numberFromUnknown(payload.durationMs ?? payload.duration),
    runId: stringFromUnknown(payload.runId),
    agentRunId: stringFromUnknown(payload.agentRunId),
    threadId: stringFromUnknown(payload.threadId),
    resourceId: stringFromUnknown(payload.resourceId),
    timestamp: Date.now(),
    raw: payload,
  };
}

function structuredFromUnknown(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  try { JSON.stringify(value); return value; } catch { return String(value); }
}
const stringFromUnknown = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);
const numberFromUnknown = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const booleanFromUnknown = (v) => (typeof v === 'boolean' ? v : undefined);
const isRecord = (v) => typeof v === 'object' && !!v && !Array.isArray(v);
