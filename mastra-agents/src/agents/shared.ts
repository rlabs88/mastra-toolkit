import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import type { RequestContext } from "@mastra/core/request-context";
import type { MastraModelConfig } from "@mastra/core/llm";

export const defaultMiniMaxModel = "minimax-coding-plan/MiniMax-M2.7";
function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const defaultAgentModel =
  optionalEnv("MASTRA_AGENT_MODEL") ??
  optionalEnv("MASTRA_SUBAGENT_MODEL") ??
  optionalEnv("MASTRA_MODEL") ??
  defaultMiniMaxModel;
export const defaultSupervisorModel =
  optionalEnv("MASTRA_SUPERVISOR_MODEL") ??
  optionalEnv("MASTRA_AGENT_MODEL") ??
  optionalEnv("MASTRA_SUBAGENT_MODEL") ??
  optionalEnv("MASTRA_MODEL") ??
  defaultMiniMaxModel;

export function resolveRuntimeModel({
  requestContext,
}: {
  requestContext: RequestContext;
}): MastraModelConfig {
  return (
    stringContextValue(requestContext, "modelId") ??
    stringRecordContextValue(requestContext, "acp", "modelId") ??
    stringRecordContextValue(requestContext, "harness", "state", "currentModelId") ??
    stringRecordContextValue(requestContext, "harness", "state", "modelId") ??
    defaultSupervisorModel
  );
}

const defaultToolCallConcurrency = 15;

export type AgentModeMetadata = {
  id: string;
  name: string;
  default?: boolean;
};

export const sharedAgentModeNames = {
  base: "Base",
  balanced: "Balanced",
  scope: "Scope",
  spec: "Spec",
  exec: "Execution",
  plan: "Plan",
  build: "Build",
  verify: "Verify",
  quick: "Quick",
  precision: "Precision",
  auto: "Auto",
  research: "Research",
  brainstorm: "Brainstorm",
  analysis: "Analysis",
  test: "Test",
  audit: "Audit",
  debug: "Debug",
} as const;

export type SharedAgentModeId = keyof typeof sharedAgentModeNames;

export type AgentModePromptMap = Partial<Record<SharedAgentModeId, string>>;

export function agentModesFromPrompts(
  modePrompts: AgentModePromptMap,
  defaultModeId: SharedAgentModeId = "balanced",
): AgentModeMetadata[] {
  return Object.keys(modePrompts).map((id) => {
    const modeId = id as SharedAgentModeId;
    return {
      id: modeId,
      name: sharedAgentModeNames[modeId],
      default: modeId === defaultModeId,
    };
  });
}

export const defaultAgentModes = agentModesFromPrompts({
  balanced: "Use balanced mode.",
});

export const defaultObservationalMemoryModel =
  optionalEnv("MASTRA_OBSERVATIONAL_MEMORY_MODEL") ?? defaultAgentModel;

export const defaultObservationalMemoryOptions = {
  enabled: true,
  model: defaultObservationalMemoryModel,
} as const;

const storage = new PostgresStore({
  id: "mastra-agent-memory",
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://mastra:mastra@mastra-postgres:5432/mastra",
});

export function createAgentMemory() {
  return new Memory({
    storage,
    vector: false,
    options: {
      lastMessages: 40,
      semanticRecall: false,
      observationalMemory: defaultObservationalMemoryOptions,
      workingMemory: {
        enabled: true,
        scope: "resource",
      },
      generateTitle: false,
    },
  });
}

export const agentDefaultOptions = {
  supervisor: { maxSteps: 50, toolCallConcurrency: defaultToolCallConcurrency },
  orchestrator: { maxSteps: 50, toolCallConcurrency: defaultToolCallConcurrency },
  scout: { maxSteps: 35, toolCallConcurrency: defaultToolCallConcurrency },
  researcher: { maxSteps: 35, toolCallConcurrency: defaultToolCallConcurrency },
  advisor: { maxSteps: 20, toolCallConcurrency: defaultToolCallConcurrency },
  architect: { maxSteps: 40, toolCallConcurrency: defaultToolCallConcurrency },
  developer: { maxSteps: 80, toolCallConcurrency: defaultToolCallConcurrency },
  validator: { maxSteps: 45, toolCallConcurrency: defaultToolCallConcurrency },
} as const;

export const streamingDefaultOptions = agentDefaultOptions.supervisor;

export function composeAgentInstructions(
  instructions: string,
  activeModePrompt?: string,
  ...promptGroups: Array<readonly string[]>
): string {
  const userSubmittedRuntimePrompts = promptGroups
    .flat()
    .filter((content) => content.trim().length > 0);

  const runtimePrompts = [
    ...(activeModePrompt ? [activeModePrompt] : []),
    ...userSubmittedRuntimePrompts,
  ];

  if (runtimePrompts.length === 0) {
    return instructions;
  }

  return [
    instructions,
    "# Runtime Policy And Tooling",
    ...runtimePrompts,
  ].join("\n\n");
}

function stringContextValue(requestContext: RequestContext, key: string): string | undefined {
  const value = requestContext.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringRecordContextValue(requestContext: RequestContext, key: string, ...path: string[]): string | undefined {
  let value: unknown = requestContext.get(key);
  for (const segment of path) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withAgentModes<TAgent extends object>(
  agent: TAgent,
  modes: readonly AgentModeMetadata[] = defaultAgentModes,
): TAgent & { mode: string; modes: readonly AgentModeMetadata[] } {
  const defaultMode = modes.find((mode) => mode.default) ?? modes[0];
  return Object.assign(agent, {
    mode: defaultMode?.id ?? "default",
    modes,
  });
}
