import {
  delegationCompletePayloadFromContext,
  delegationStartPayloadFromContext,
  emitDelegationEvent,
} from "../workflows/delegation-event.js";

export function createDelegationObservabilityOptions(options = {}) {
  const source = {
    parentAgentId: options.parentAgentId,
    parentAgentName: options.parentAgentName,
  };
  const activeDelegations = new Map();

  return {
    onDelegationStart: (context) => {
      const payload = {
        ...delegationStartPayloadFromContext({
          ...context,
          ...source,
        }),
        source: "delegation-hook",
      };
      if (context.toolCallId) {
        activeDelegations.set(context.toolCallId, {
          threadId: payload.threadId,
          resourceId: payload.resourceId,
        });
      }
      emitDelegationEvent(payload);
    },
    onDelegationComplete: (context) => {
      const correlation = context.toolCallId ? activeDelegations.get(context.toolCallId) : undefined;
      if (context.toolCallId) {
        activeDelegations.delete(context.toolCallId);
      }
      emitDelegationEvent({
        ...delegationCompletePayloadFromContext({
          ...context,
          ...correlation,
          ...source,
        }),
        source: "delegation-hook",
      });
    },
  };
}
