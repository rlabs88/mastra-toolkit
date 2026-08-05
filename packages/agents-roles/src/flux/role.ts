import { defineRole } from "../role.js";
import { fluxPrompt } from "./prompt.js";

export const FLUX_ROLE = defineRole({
  id: "flux",
  name: "Flux",
  description: "Divergent agent for design, interface work, scoping, and open problems that benefit from re-framing.",
  temperature: 0.7,
  steps: 80,
  prompts: fluxPrompt,
});
