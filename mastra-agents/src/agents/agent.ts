import { createLinearAdapter } from "@chat-adapter/linear";
import { Agent } from "@mastra/core/agent";
import { createSlackAdapter } from "@chat-adapter/slack";

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
import { advisorAgent } from "./advisor-agent.js";
import { orchestratorAgent } from "./orchestrator-agent.js";
import { architectAgent } from "./architect-agent.js";
import { developerAgent } from "./developer-agent.js";
import { researcherAgent } from "./researcher-agent.js";
import { scoutAgent } from "./scout-agent.js";
import { agentDefaultOptions, agentModesFromPrompts, composeAgentInstructions, createAgentMemory, defaultSupervisorModel, withAgentModes } from "./shared.js";
import { validatorAgent } from "./validator-agent.js";

function createSupervisorChannelsConfig() {
  const adapters = {
    ...(process.env.ENABLE_SLACK_CHANNEL === "true"
      ? {
          slack: createSlackAdapter(),
        }
      : {}),
  };

  const linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  const linearAuthConfigured = Boolean(
    process.env.LINEAR_API_KEY ||
      process.env.LINEAR_ACCESS_TOKEN ||
      (process.env.LINEAR_CLIENT_ID && process.env.LINEAR_CLIENT_SECRET),
  );

  if (linearWebhookSecret && linearAuthConfigured) {
    Object.assign(adapters, {
      linear: createLinearAdapter({
        mode: process.env.LINEAR_CHANNEL_MODE === "agent-sessions" ? "agent-sessions" : "comments",
      }),
    });
  }

  return Object.keys(adapters).length > 0 ? { adapters } : undefined;
}

orchestratorAgent.channels = createSupervisorChannelsConfig();

export const supervisorAgent = withAgentModes(new Agent({
  id: "supervisor-agent",
  name: "Supervisor Lead",
  description: supervisorAgentDescription,
  instructions: composeAgentInstructions(
    supervisorInstructionsPrompt,
    supervisorModePrompts.balanced, // Active mode prompt injected into instruction string
    sharedPolicyPrompts.supervisor,
    sharedToolPrompts.supervisor,
    supervisorPolicyPrompts,
    supervisorToolPrompts,
  ),
  model: defaultSupervisorModel,
  memory: createAgentMemory(),
  defaultOptions: agentDefaultOptions.supervisor,
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
}), agentModesFromPrompts(supervisorModePrompts));

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
