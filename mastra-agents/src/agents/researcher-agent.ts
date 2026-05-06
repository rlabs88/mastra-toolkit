import { Agent } from "@mastra/core/agent";

import {
  researcherAgentDescription,
  researcherInstructionsPrompt,
  researcherModePrompts,
  researcherPolicyPrompts,
  researcherToolPrompts,
} from "../prompts/agents/researcher.js";
import { sharedPolicyPrompts } from "../prompts/policy.js";
import { sharedToolPrompts } from "../prompts/tools.js";
import { agentDefaultOptions, agentModesFromPrompts, composeAgentInstructions, createAgentMemory, defaultAgentModel, withAgentModes } from "./shared.js";
import { getDeepWikiTools } from "../mcp/index.js";

// Initialize DeepWiki tools for researcher agent
// DeepWiki is primary for researcher - used for repo analysis, research, benchmarking
const deepWikiTools = await getDeepWikiTools();

export const researcherAgent = withAgentModes(new Agent({
  id: "researcher-agent",
  name: "Researcher Agent",
  description: researcherAgentDescription,
  instructions: composeAgentInstructions(
    researcherInstructionsPrompt,
    undefined,
    sharedPolicyPrompts.specialist,
    sharedToolPrompts.specialist,
    researcherPolicyPrompts,
    researcherToolPrompts,
  ),
  model: defaultAgentModel,
  memory: createAgentMemory(),
  defaultOptions: agentDefaultOptions.researcher,
  tools: deepWikiTools,
}), agentModesFromPrompts(researcherModePrompts));
