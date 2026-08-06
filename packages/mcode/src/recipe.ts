import { createHash } from "node:crypto";
import type { AgentControllerMode, AgentControllerSubagent } from "@mastra/core/agent-controller";
import {
  createToolkitAgents,
  type ToolkitAgents,
  type ToolkitAgentsOptions,
} from "@rlabs/agents-roles";
import type { ModelProfile } from "@rlabs/runtime-config";
import { createCodeModes } from "./modes/index.js";
import { createCodeSubagents } from "./subagents.js";

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
    readonly memory: {
      readonly contextBudgetTokens: number;
      readonly observationThresholdTokens: number;
    };
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
  readonly settings: {
    readonly profile: ModelProfile;
  };
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
    settings: { profile: options.profile },
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
      memory: profile.memory,
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
