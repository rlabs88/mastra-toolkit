import { Harness, type HarnessMode } from "@mastra/core/harness";

import { workspace } from "../workspace.js";
import { orchestratorAgent } from "./orchestrator-agent.js";
import { supervisorAgent } from "./agent.js";
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
  agent: harnessAgents[mode.agentId],
  color: mode.color,
}));

export function createMastraAgentHarness(): Harness<MastraAgentHarnessState> {
  return new Harness<MastraAgentHarnessState>({
    id: "mastra-system-agents",
    workspace: workspace as any,
    initialState: {
      activeAgentId: DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID,
      harnessMode: DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE,
      orchestratorMode: DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE,
      harnessModeId: defaultMastraAgentHarnessModeId(),
      hardnessMode: defaultMastraAgentHarnessModeId(),
    },
    modes: mastraAgentHarnessModes,
  });
}

export const mastraAgentHarness = createMastraAgentHarness();
