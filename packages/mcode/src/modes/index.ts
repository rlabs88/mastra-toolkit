import type { ToolsInput } from "@mastra/core/agent";
import type { AgentControllerMode } from "@mastra/core/agent-controller";
import type { ToolkitAgents } from "@rlabs/agents-roles";
import {
  DEFAULT_ACTIVE_ALIAS,
  resolveAliasModelId,
  type ModelProfile,
} from "@rlabs/runtime-config";
import { buildModePrompt } from "./build/prompt.js";
import { scopeModePrompt } from "./scope/prompt.js";

export const CANONICAL_AGENT_IDS = ["cortex", "flux", "zen"] as const;
export const CODE_MODE_NAMES = ["scope", "build"] as const;

export type CanonicalAgentId = (typeof CANONICAL_AGENT_IDS)[number];
export type CodeModeId = (typeof CODE_MODE_NAMES)[number];

export interface AgentModeSelection {
  readonly agent: CanonicalAgentId;
  readonly mode: CodeModeId;
}

export const CODE_MODE_IDS = CANONICAL_AGENT_IDS.flatMap(agent =>
  CODE_MODE_NAMES.map(mode => `${agent}/${mode}` as const),
);

const modePrompts = { scope: scopeModePrompt, build: buildModePrompt } as const;

export function createCodeModes(
  agents: ToolkitAgents,
  profile: ModelProfile,
  additionalTools?: ToolsInput,
): AgentControllerMode[] {
  const defaultModelId = resolveAliasModelId(profile, DEFAULT_ACTIVE_ALIAS);
  return CODE_MODE_IDS.map(id => {
    const selection = decodeAgentMode(id);
    return {
      id,
      name: `${capitalize(selection.agent)} · ${capitalize(selection.mode)}`,
      description: `${capitalize(selection.agent)} using the ${selection.mode} prompt overlay`,
      defaultModelId,
      agent: agents[selection.agent],
      instructions: modePrompts[selection.mode],
      metadata: {
        agent: selection.agent,
        mode: selection.mode,
        ...(id === "cortex/build" ? { default: true } : {}),
      },
      ...(additionalTools ? { additionalTools } : {}),
    };
  });
}

export function encodeAgentMode(selection: AgentModeSelection): (typeof CODE_MODE_IDS)[number] {
  return `${selection.agent}/${selection.mode}`;
}

export function decodeAgentMode(value: string): AgentModeSelection {
  const [agent, mode, extra] = value.split("/");
  if (extra || !isCanonicalAgentId(agent) || !isCodeModeId(mode)) {
    throw new Error(`Invalid agent mode: ${value}`);
  }
  return { agent, mode };
}

export function switchAgent(selection: AgentModeSelection, agent: CanonicalAgentId): AgentModeSelection {
  return { agent, mode: selection.mode };
}

export function switchMode(selection: AgentModeSelection, mode: CodeModeId): AgentModeSelection {
  return { agent: selection.agent, mode };
}

function isCanonicalAgentId(value: string | undefined): value is CanonicalAgentId {
  return CANONICAL_AGENT_IDS.some(agent => agent === value);
}

function isCodeModeId(value: string | undefined): value is CodeModeId {
  return CODE_MODE_NAMES.some(mode => mode === value);
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
