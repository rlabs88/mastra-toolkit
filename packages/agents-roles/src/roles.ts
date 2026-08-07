import { DEFAULT_ACTIVE_ALIAS } from "@rlabs/runtime-config";
import {
  cortexPrompt,
  fluxPrompt,
  zenPrompt,
  type RolePrompt,
} from "./prompts.js";

export const ROLE_IDS = Object.freeze(["cortex", "flux", "zen"] as const);
export type RoleId = (typeof ROLE_IDS)[number];

export interface RoleDefinition<TId extends RoleId = RoleId> {
  readonly id: TId;
  readonly name: string;
  readonly description: string;
  readonly model: {
    readonly id: string;
    readonly temperature: number;
    readonly steps: number;
  };
  readonly prompts: RolePrompt;
}

export type Archetype = RoleDefinition;

export function defineRole<TId extends RoleId>(options: {
  readonly id: TId;
  readonly name: string;
  readonly description: string;
  readonly temperature: number;
  readonly steps: number;
  readonly prompts: RolePrompt;
}): RoleDefinition<TId> {
  return deepFreeze({
    id: options.id,
    name: options.name,
    description: options.description,
    model: {
      id: DEFAULT_ACTIVE_ALIAS,
      temperature: options.temperature,
      steps: options.steps,
    },
    prompts: options.prompts,
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}


export const CORTEX_ROLE = defineRole({
  id: "cortex",
  name: "Cortex",
  description: "Precision software-engineering agent for implementation, debugging, architecture, and verified repository change.",
  temperature: 0.2,
  steps: 80,
  prompts: cortexPrompt,
});


export const FLUX_ROLE = defineRole({
  id: "flux",
  name: "Flux",
  description: "Divergent agent for design, interface work, scoping, and open problems that benefit from re-framing.",
  temperature: 0.7,
  steps: 80,
  prompts: fluxPrompt,
});


export const ZEN_ROLE = defineRole({
  id: "zen",
  name: "Zen",
  description: "Knowledge-plane agent for retrieval, synthesis, provenance, contradiction detection, and current truth.",
  temperature: 0.1,
  steps: 48,
  prompts: zenPrompt,
});


export const ROLES = Object.freeze({ cortex: CORTEX_ROLE, flux: FLUX_ROLE, zen: ZEN_ROLE });
export const ARCHETYPES = ROLES;
