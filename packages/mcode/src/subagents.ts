import type { AgentControllerSubagent } from "@mastra/core/agent-controller";
import { ARCHETYPES, composePrompt, ROLE_IDS, type RoleId } from "@rlabs/agents-roles";
import {
  resolveProxyGatewayModelId,
  type ModelProfile,
} from "@rlabs/runtime-config";

export function createCodeSubagents(profile: ModelProfile): AgentControllerSubagent[] {
  return ROLE_IDS.map(id => {
    const archetype = ARCHETYPES[id];
    return {
      id,
      name: archetype.name,
      description: archetype.description,
      instructions: composePrompt(archetype),
      defaultModelId: resolveProxyGatewayModelId(profile, profile.roles[id]),
      maxSteps: archetype.model.steps,
    };
  });
}

export function fillMissingSubagentModelId(profile: ModelProfile, input: unknown): void {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  if (typeof record.modelId === "string" && record.modelId.trim()) return;
  if (!isRoleId(record.agentType)) return;
  record.modelId = resolveProxyGatewayModelId(profile, profile.roles[record.agentType]);
}

function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && ROLE_IDS.some(id => id === value);
}
