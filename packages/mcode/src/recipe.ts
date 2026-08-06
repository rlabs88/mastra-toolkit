import type { ToolsInput } from "@mastra/core/agent";
import type { AgentControllerMode, AgentControllerSubagent } from "@mastra/core/agent-controller";
import { ARCHETYPES, composePrompt, createToolkitAgents, ROLE_IDS, type RoleId, type ToolkitAgents, type ToolkitAgentsOptions } from "@rlabs/agents-roles";
import { DEFAULT_ACTIVE_ALIAS, type ModelProfile, resolveAliasModelId, resolveProxyGatewayModelId } from "@rlabs/runtime-config";
import { createHash } from "node:crypto";

export const buildModePrompt = `# Build mode

Implement the requested project change as a verified vertical slice. Preserve repository policy, approvals, containment, and current user choices. Exercise the complete coding tool surface as needed, validate behavior, and leave concrete evidence.`;

export const scopeModePrompt = `# Scope mode

Establish the project boundary, current evidence, constraints, risks, and the smallest coherent next change. You retain the complete coding tool surface and ordinary approval rules. Use tools whenever they improve the evidence; do not treat this prompt overlay as a read-only boundary.`;

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

export function createCodeSubagents(
  profile: ModelProfile,
  tools: ToolsInput,
): AgentControllerSubagent[] {
  return ROLE_IDS.map(id => {
    const archetype = ARCHETYPES[id];
    return {
      id,
      name: archetype.name,
      description: archetype.description,
      instructions: composePrompt(archetype),
      tools,
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

export const MCODE_RECIPE_VERSION = 1 as const;
export const MCODE_CAPABILITY_SCHEMA_VERSION = 1 as const;

export interface McodeRecipeOptions extends Omit<ToolkitAgentsOptions, "profile"> {
  readonly profile: ModelProfile;
}

export interface McodeControllerIngredientsV1 {
  readonly modes: AgentControllerMode[];
  readonly subagents: AgentControllerSubagent[];
}

export interface McodeCapabilityDescriptorV1 {
  readonly schemaVersion: typeof MCODE_CAPABILITY_SCHEMA_VERSION;
  readonly recipeVersion: typeof MCODE_RECIPE_VERSION;
  readonly modes: readonly string[];
  readonly subagents: readonly string[];
  readonly requiredTools: readonly ["command_run"];
  readonly behavior: {
    readonly toolContract: "command-run/v1";
    readonly modeInstructionDigests: Readonly<Record<string, `sha256:${string}`>>;
    readonly subagentInstructionDigests: Readonly<Record<string, `sha256:${string}`>>;
    readonly subagentMaxSteps: Readonly<Record<string, number>>;
  };
  readonly models: {
    readonly providerId: string;
    readonly aliases: readonly string[];
    readonly modeDefaults: Readonly<Record<string, string>>;
    readonly subagentDefaults: Readonly<Record<string, string>>;
  };
  readonly defaults: {
    readonly mode: "cortex/build";
    readonly preserveExplicitSelections: true;
    readonly preferences: {
      readonly yolo: false;
      readonly thinkingLevel: "off";
    };
  };
  readonly sandbox: {
    readonly commandExecution: "workspace-sandbox";
    readonly projectBinding: "project-user-session";
  };
  readonly local: {
    readonly controllerConstruction: "supported";
    readonly repositoryConfiguration: "project-mounting-manager";
  };
  readonly digest: `sha256:${string}`;
}

export interface McodeRecipeV1 {
  readonly version: typeof MCODE_RECIPE_VERSION;
  readonly agents: ToolkitAgents;
  readonly tools: {
    readonly command_run: McodeRecipeOptions["commandRun"];
  };
  readonly controller: McodeControllerIngredientsV1;
  readonly capability: McodeCapabilityDescriptorV1;
}

export function createMcodeRecipe(options: McodeRecipeOptions): McodeRecipeV1 {
  const agents = createToolkitAgents(options);
  const modes = createCodeModes(agents, options.profile);
  const subagents = createCodeSubagents(options.profile, { command_run: options.commandRun });
  return {
    version: MCODE_RECIPE_VERSION,
    agents,
    tools: { command_run: options.commandRun },
    controller: { modes, subagents },
    capability: createMcodeCapabilityDescriptor(options.profile, modes, subagents),
  };
}

export function createMcodeCapabilityDescriptor(
  profile: ModelProfile,
  modes: AgentControllerMode[],
  subagents: AgentControllerSubagent[],
): McodeCapabilityDescriptorV1 {
  const payload = {
    schemaVersion: MCODE_CAPABILITY_SCHEMA_VERSION,
    recipeVersion: MCODE_RECIPE_VERSION,
    modes: modes.map(mode => mode.id),
    subagents: subagents.map(subagent => subagent.id),
    requiredTools: ["command_run"],
    behavior: {
      toolContract: "command-run/v1",
      modeInstructionDigests: Object.fromEntries(modes.map(mode => [mode.id, digestInstructions(mode.instructions)])),
      subagentInstructionDigests: Object.fromEntries(subagents.map(subagent => [subagent.id, digestInstructions(subagent.instructions)])),
      subagentMaxSteps: Object.fromEntries(subagents.flatMap(subagent =>
        typeof subagent.maxSteps === "number" ? [[subagent.id, subagent.maxSteps]] : [])),
    },
    models: {
      providerId: profile.provider.id,
      aliases: profile.aliases,
      modeDefaults: Object.fromEntries(modes.flatMap(mode =>
        typeof mode.defaultModelId === "string" ? [[mode.id, mode.defaultModelId]] : [])),
      subagentDefaults: Object.fromEntries(subagents.flatMap(subagent =>
        typeof subagent.defaultModelId === "string" ? [[subagent.id, subagent.defaultModelId]] : [])),
    },
    defaults: {
      mode: "cortex/build",
      preserveExplicitSelections: true,
      preferences: { yolo: false, thinkingLevel: "off" },
    },
    sandbox: {
      commandExecution: "workspace-sandbox",
      projectBinding: "project-user-session",
    },
    local: {
      controllerConstruction: "supported",
      repositoryConfiguration: "project-mounting-manager",
    },
  } as const;
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, digest: `sha256:${digest}` };
}

function digestInstructions(instructions: unknown): `sha256:${string}` {
  if (typeof instructions !== "string") {
    throw new Error("MCode capability instructions must be static strings");
  }
  return `sha256:${createHash("sha256").update(instructions).digest("hex")}`;
}
