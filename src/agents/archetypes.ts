import { baseIdentity } from "./prompts/base-identity.js";
import { baseTask } from "./prompts/base-task.js";
import { cortexPrompt } from "./prompts/cortex.js";
import { fluxPrompt } from "./prompts/flux.js";
import { sharedSecurity } from "./prompts/security.js";
import { zenPrompt } from "./prompts/zen.js";

export const ROLE_IDS = ["cortex", "flux", "zen"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

interface PromptProfile {
  readonly baseIdentity?: string;
  readonly identity: string;
  readonly sharedSecurity?: string;
  readonly security: readonly string[];
  readonly baseTask?: string;
  readonly task: string;
}

export interface Archetype {
  readonly id: RoleId;
  readonly name: string;
  readonly description: string;
  readonly model: { readonly id: string; readonly temperature: number; readonly steps: number };
  readonly prompts: PromptProfile;
}

export const ARCHETYPES = {
  cortex: archetype("cortex", "Cortex", "Precision software-engineering agent for implementation, debugging, architecture, and verified repository change.", 0.2, 80, cortexPrompt),
  flux: archetype("flux", "Flux", "Divergent agent for design, interface work, scoping, and open problems that benefit from re-framing.", 0.7, 80, fluxPrompt),
  zen: archetype("zen", "Zen", "Knowledge-plane agent for retrieval, synthesis, provenance, contradiction detection, and current truth.", 0.1, 48, zenPrompt),
} as const satisfies Record<RoleId, Archetype>;

export function composePrompt(role: Archetype): string {
  const roleSecurity = role.prompts.security.length === 0
    ? "No role-specific security additions."
    : role.prompts.security.map(addition => `- ${addition}`).join("\n");

  return [
    section("Base Identity", role.prompts.baseIdentity ?? baseIdentity),
    section("Role Identity", role.prompts.identity),
    section("Shared Security", role.prompts.sharedSecurity ?? sharedSecurity),
    section("Role Security Additions", roleSecurity),
    section("Base Task Behavior", role.prompts.baseTask ?? baseTask),
    section("Role Task Behavior", role.prompts.task),
  ].join("\n\n") + "\n";
}

function archetype<TId extends RoleId>(
  id: TId,
  name: string,
  description: string,
  temperature: number,
  steps: number,
  prompts: PromptProfile,
): Archetype & { readonly id: TId } {
  return { id, name, description, model: { id: "openai/gpt-5.6-luna", temperature, steps }, prompts };
}

function section(title: string, content: string): string {
  return `# ${title}\n\n${content.trim()}`;
}
