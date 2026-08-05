import { DEFAULT_ACTIVE_ALIAS } from "@rlabs/runtime-config";
import type { RolePrompt } from "./prompt.js";

export const ROLE_IDS = ["cortex", "flux", "zen"] as const;
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
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    model: {
      id: DEFAULT_ACTIVE_ALIAS,
      temperature: options.temperature,
      steps: options.steps,
    },
    prompts: options.prompts,
  };
}
