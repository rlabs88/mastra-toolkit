import { Harness, type HarnessMode } from "@mastra/core/harness";
import { z } from "zod";

import { workspace } from "../workspace.js";
import { orchestratorAgent } from "./orchestrator-agent.js";
import { supervisorAgent } from "./agent.js";
import { defaultSupervisorModel } from "./shared.js";
import {
  DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID,
  DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE,
  defaultMastraAgentHarnessModeId,
  mastraAgentHarnessModeSpecs,
  type MastraAgentHarnessAgentId,
  type MastraAgentHarnessState,
} from "./harness-modes.js";

export {
  DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID,
  DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE,
  DEFAULT_MASTRA_AGENT_HARNESS_MODE_ID,
  REQUEST_CONTEXT_ACTIVE_AGENT_ID_KEY,
  REQUEST_CONTEXT_HARDNESS_MODE_KEY,
  REQUEST_CONTEXT_HARNESS_MODE_ID_KEY,
  REQUEST_CONTEXT_HARNESS_MODE_KEY,
  REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY,
  defaultMastraAgentHarnessModeId,
  formatMastraAgentHarnessModePrompt,
  isMastraAgentHarnessModeId,
  mastraAgentModeDefinitions,
  resolveMastraAgentHarnessMode,
  resolveMastraAgentHarnessModeId,
} from "./harness-modes.js";

export type {
  MastraAgentHarnessAgentId,
  MastraAgentHarnessLocalModeId,
  MastraAgentHarnessModeId,
  MastraAgentHarnessModeSpec,
  MastraAgentHarnessState,
  OrchestratorModeId,
  ResolvedMastraAgentHarnessMode,
  SupervisorScopeId,
} from "./harness-modes.js";

const harnessAgents: Record<MastraAgentHarnessAgentId, HarnessMode<MastraAgentHarnessState>["agent"]> = {
  orchestrator: orchestratorAgent,
  supervisor: supervisorAgent,
};

export const mastraAgentHarnessModes: HarnessMode<MastraAgentHarnessState>[] = mastraAgentHarnessModeSpecs.map((mode) => ({
  id: mode.id,
  name: mode.name,
  default: mode.default,
  defaultModelId: defaultSupervisorModel,
  agent: harnessAgents[mode.agentId],
  color: mode.color,
}));

const mastraAgentHarnessStateSchema = z.object({
  activeAgentId: z.enum(["orchestrator", "supervisor"]).optional(),
  supervisorScope: z.enum(["base", "scope", "spec", "exec"]).optional(),
  orchestratorMode: z.enum(["quick", "precision", "auto"]).optional(),
  currentModelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceSettings: z.record(z.unknown()).optional(),
  toolSettings: z.record(z.unknown()).optional(),
  runtimeSettings: z.record(z.unknown()).optional(),
  harnessMode: z.enum(["base", "scope", "spec", "exec", "quick", "precision", "auto"]).optional(),
  harnessModeId: z.enum([
    "supervisor.base",
    "supervisor.scope",
    "supervisor.spec",
    "supervisor.exec",
    "orchestrator.quick",
    "orchestrator.precision",
    "orchestrator.auto",
  ]).optional(),
  lastSubmittedHarnessModeId: z.enum([
    "supervisor.base",
    "supervisor.scope",
    "supervisor.spec",
    "supervisor.exec",
    "orchestrator.quick",
    "orchestrator.precision",
    "orchestrator.auto",
  ]).optional(),
  hardnessMode: z.string().optional(),
});

export function createMastraAgentHarness(): Harness<MastraAgentHarnessState> {
  return new Harness<MastraAgentHarnessState>({
    id: "mastra-system-agents",
    workspace: workspace as any,
    stateSchema: mastraAgentHarnessStateSchema,
    initialState: {
      activeAgentId: DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID,
      harnessMode: DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE,
      orchestratorMode: DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE,
      harnessModeId: defaultMastraAgentHarnessModeId(),
      hardnessMode: defaultMastraAgentHarnessModeId(),
      currentModelId: defaultSupervisorModel,
      modelId: defaultSupervisorModel,
      workspaceSettings: {},
      toolSettings: {},
      runtimeSettings: {},
    },
    modes: mastraAgentHarnessModes,
  });
}

export const mastraAgentHarness = createMastraAgentHarness();
