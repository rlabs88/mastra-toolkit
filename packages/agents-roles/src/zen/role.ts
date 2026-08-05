import { defineRole } from "../role.js";
import { zenPrompt } from "./prompt.js";

export const ZEN_ROLE = defineRole({
  id: "zen",
  name: "Zen",
  description: "Knowledge-plane agent for retrieval, synthesis, provenance, contradiction detection, and current truth.",
  temperature: 0.1,
  steps: 48,
  prompts: zenPrompt,
});
