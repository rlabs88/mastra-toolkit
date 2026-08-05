import { CORTEX_ROLE } from "./cortex/index.js";
import { FLUX_ROLE } from "./flux/index.js";
import { ZEN_ROLE } from "./zen/index.js";

export { CORTEX_ROLE, cortexPrompt } from "./cortex/index.js";
export { FLUX_ROLE, fluxPrompt } from "./flux/index.js";
export {
  TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
  createToolkitAgents,
  type ToolkitAdditionalTools,
  type ToolkitAgents,
  type ToolkitAgentsOptions,
} from "./factory.js";
export {
  PROMPT_SECTION_HEADINGS,
  composePrompt,
  type PromptRole,
  type RolePrompt,
} from "./prompt.js";
export { ROLE_IDS, type Archetype, type RoleDefinition, type RoleId } from "./role.js";
export { ZEN_ROLE, zenPrompt } from "./zen/index.js";

export const ROLES = {
  cortex: CORTEX_ROLE,
  flux: FLUX_ROLE,
  zen: ZEN_ROLE,
} as const;

export const ARCHETYPES = ROLES;
