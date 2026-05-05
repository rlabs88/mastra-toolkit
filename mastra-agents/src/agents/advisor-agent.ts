import { Agent } from "@mastra/core/agent";

import {
  advisorAgentDescription,
  advisorInstructionsPrompt,
  advisorModePrompts,
  advisorPolicyPrompts,
  advisorToolPrompts,
} from "../prompts/agents/advisor.js";
import { sharedPolicyPrompts } from "../prompts/policy.js";
import { sharedToolPrompts } from "../prompts/tools.js";
import { agentDefaultOptions, agentModesFromPrompts, composeAgentInstructions, createAgentMemory, defaultAgentModel, withAgentModes } from "./shared.js";
import { getDeepWikiTools } from "../mcp/index.js";

// Initialize DeepWiki tools for advisor agent
// DeepWiki helps advisor with repo analysis, integration research, architecture reviews
const deepWikiTools = await getDeepWikiTools();

export const advisorAgent = withAgentModes(new Agent({
  id: "advisor-agent",
  name: "Advisor Agent",
  description: advisorAgentDescription,
  instructions: composeAgentInstructions(
    advisorInstructionsPrompt,
    undefined,
    sharedPolicyPrompts.specialist,
    sharedToolPrompts.specialist,
    advisorPolicyPrompts,
    advisorToolPrompts,
  ),
  model: defaultAgentModel,
  memory: createAgentMemory(),
  defaultOptions: agentDefaultOptions.advisor,
// NOTE: advisorModePrompts are registered as agent metadata via agentModesFromPrompts and
// delivered to the model by the harness when harness mode changes. They are NOT injected
// into composeAgentInstructions here. The harness must pass the active mode prompt as the
// second argument to composeAgentInstructions for mode context to reach the model.
  tools: deepWikiTools,
}), agentModesFromPrompts(advisorModePrompts));
