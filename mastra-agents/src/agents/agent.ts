import { Agent } from "@mastra/core/agent";

import {
  supervisorAgentDescription,
  supervisorInstructionsPrompt,
  supervisorModePrompts,
  supervisorPolicyPrompts,
  supervisorToolPrompts,
} from "../prompts/agents/supervisor.js";
import { sharedPolicyPrompts } from "../prompts/policy.js";
import { sharedToolPrompts } from "../prompts/tools.js";
import { workspaceTools } from "../tools/workspace.js";
import { workspace } from "../workspace.js";
import { advisorAgent } from "./advisor-agent.js";
import { orchestratorAgent } from "./orchestrator-agent.js";
import { architectAgent } from "./architect-agent.js";
import { createDelegationObservabilityOptions } from "./delegation-observability.js";
import { developerAgent } from "./developer-agent.js";
import { researcherAgent } from "./researcher-agent.js";
import { scoutAgent } from "./scout-agent.js";
import { buildAgentChannels } from "./channels.js";
import { agentDefaultOptions, agentModesFromPrompts, composeAgentInstructions, createAgentMemory, resolveRuntimeModel, withAgentModes } from "./shared.js";
import { validatorAgent } from "./validator-agent.js";

export const supervisorAgent = withAgentModes(new Agent({
  id: "supervisor-agent",
  name: "Supervisor Lead",
  description: supervisorAgentDescription,
  instructions: composeAgentInstructions(
    supervisorInstructionsPrompt,
    supervisorModePrompts.base, // Active scope prompt injected into instruction string
    sharedPolicyPrompts.supervisor,
    sharedToolPrompts.supervisor,
    supervisorPolicyPrompts,
    supervisorToolPrompts,
  ),
  model: resolveRuntimeModel,
  channels: buildAgentChannels(),
  memory: createAgentMemory(),
  workspace,
  defaultOptions: {
    ...agentDefaultOptions.supervisor,
    delegation: createDelegationObservabilityOptions({
      parentAgentId: "supervisor-agent",
      parentAgentName: "Supervisor Lead",
    }),
  },
  agents: {
    scoutAgent,
    researcherAgent,
    architectAgent,
    advisorAgent,
    developerAgent,
    validatorAgent,
  },
  tools: {
    list_files: workspaceTools.listFiles,
    read_file: workspaceTools.readFile,
    write_file: workspaceTools.writeFile,
    edit_file: workspaceTools.replaceInFile,
    read_snapshots: workspaceTools.readSnapshots,
    git_snapshot_query: workspaceTools.gitSnapshotQuery,
    capture_snapshot: workspaceTools.captureSnapshot,
  },
}), agentModesFromPrompts(supervisorModePrompts, "base"));

export const mastraAgents = {
  orchestratorAgent,
  supervisorAgent,
  scoutAgent,
  researcherAgent,
  architectAgent,
  advisorAgent,
  developerAgent,
  validatorAgent,
};
