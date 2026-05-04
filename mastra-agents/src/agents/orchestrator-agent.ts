import { Agent } from "@mastra/core/agent";

import {
  orchestratorAgentDescription,
  orchestratorInstructionsPrompt,
  orchestratorModePrompts,
  orchestratorPolicyPrompts,
  orchestratorToolPrompts,
} from "../prompts/agents/orchestrator.js";
import { sharedPolicyPrompts } from "../prompts/policy.js";
import { sharedToolPrompts } from "../prompts/tools.js";
import { workspaceTools } from "../tools/workspace.js";
import { advisorAgent } from "./advisor-agent.js";
import { architectAgent } from "./architect-agent.js";
import { developerAgent } from "./developer-agent.js";
import { researcherAgent } from "./researcher-agent.js";
import { scoutAgent } from "./scout-agent.js";
import { agentDefaultOptions, agentModesFromPrompts, composeAgentInstructions, createAgentMemory, defaultSupervisorModel, withAgentModes } from "./shared.js";
import { validatorAgent } from "./validator-agent.js";

export const orchestratorAgent = withAgentModes(new Agent({
  id: "orchestrator-agent",
  name: "Orchestrator",
  description: orchestratorAgentDescription,
  instructions: composeAgentInstructions(
    orchestratorInstructionsPrompt,
    orchestratorModePrompts.balanced,
    sharedPolicyPrompts.supervisor,
    sharedToolPrompts.supervisor,
    orchestratorPolicyPrompts,
    orchestratorToolPrompts,
  ),
  model: defaultSupervisorModel,
  memory: createAgentMemory(),
  defaultOptions: agentDefaultOptions.orchestrator,
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
}), agentModesFromPrompts(orchestratorModePrompts));
