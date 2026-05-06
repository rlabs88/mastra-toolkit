export type DelegationEventPayload = Record<string, unknown> & {
  phase?: string;
  delegationId?: string;
  delegatedName?: string;
  delegatedAgentId?: string;
  prompt?: unknown;
  response?: unknown;
  error?: unknown;
  success?: boolean;
  durationMs?: number;
  runId?: string;
  agentRunId?: string;
  threadId?: string;
  resourceId?: string;
  timestamp?: number;
};

export function subscribeDelegationEvents(
  sink: (payload: DelegationEventPayload) => void,
): () => boolean;
export function emitDelegationEvent(payload: DelegationEventPayload): void;
export function delegationPayloadFromEvent(event: unknown): DelegationEventPayload;
export function delegationStartPayloadFromContext(context: Record<string, unknown>): DelegationEventPayload;
export function delegationCompletePayloadFromContext(context: Record<string, unknown>): DelegationEventPayload;
