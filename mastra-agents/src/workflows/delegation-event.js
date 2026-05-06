const delegationEventSinks = new Set();

export function subscribeDelegationEvents(sink) {
  delegationEventSinks.add(sink);
  return () => delegationEventSinks.delete(sink);
}

export function emitDelegationEvent(payload) {
  for (const sink of delegationEventSinks) {
    sink(payload);
  }
}

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

export function delegationStartPayloadFromContext(context) {
  return {
    phase: 'delegation_start',
    delegationId: stringFromUnknown(context.toolCallId),
    delegatedName: stringFromUnknown(context.primitiveId),
    delegatedAgentId: stringFromUnknown(context.primitiveId),
    prompt: structuredFromUnknown(context.prompt),
    runId: stringFromUnknown(context.runId),
    agentRunId: stringFromUnknown(context.parentAgentId),
    threadId: stringFromUnknown(context.threadId),
    resourceId: stringFromUnknown(context.resourceId),
    parentAgentId: stringFromUnknown(context.parentAgentId),
    parentAgentName: stringFromUnknown(context.parentAgentName),
    iteration: numberFromUnknown(context.iteration),
    timestamp: Date.now(),
    raw: context,
  };
}

export function delegationCompletePayloadFromContext(context) {
  return {
    phase: 'delegation_complete',
    delegationId: stringFromUnknown(context.toolCallId),
    delegatedName: stringFromUnknown(context.primitiveId),
    delegatedAgentId: stringFromUnknown(context.primitiveId),
    prompt: structuredFromUnknown(context.prompt),
    response: structuredFromUnknown(context.result),
    error: structuredFromUnknown(context.error),
    success: booleanFromUnknown(context.success),
    durationMs: numberFromUnknown(context.duration),
    runId: stringFromUnknown(context.runId),
    agentRunId: stringFromUnknown(context.parentAgentId),
    threadId: stringFromUnknown(context.threadId),
    resourceId: stringFromUnknown(context.resourceId),
    parentAgentId: stringFromUnknown(context.parentAgentId),
    parentAgentName: stringFromUnknown(context.parentAgentName),
    iteration: numberFromUnknown(context.iteration),
    timestamp: Date.now(),
    raw: context,
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
