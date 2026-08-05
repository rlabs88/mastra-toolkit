import { defineRole } from "../role.js";
import { cortexPrompt } from "./prompt.js";

export const CORTEX_ROLE = defineRole({
  id: "cortex",
  name: "Cortex",
  description: "Precision software-engineering agent for implementation, debugging, architecture, and verified repository change.",
  temperature: 0.2,
  steps: 80,
  prompts: cortexPrompt,
});
