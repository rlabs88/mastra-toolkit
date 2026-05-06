import type { DelegationConfig } from "@mastra/core/dist/agent/agent.types.js";

export function createDelegationObservabilityOptions(options?: {
  parentAgentId?: string;
  parentAgentName?: string;
}): DelegationConfig;
