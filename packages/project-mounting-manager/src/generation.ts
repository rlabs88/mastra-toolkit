import type { Agent, ToolsInput } from "@mastra/core/agent";
import type { ProjectSpecialist } from "./specialists.js";
import type { ProjectWorkflow } from "./workflows.js";

export interface ProjectGenerationState {
  readonly id: number;
  readonly specialists: ReadonlyMap<string, ProjectSpecialist>;
  readonly specialistAgents: ReadonlyMap<string, Agent>;
  readonly workflows: ReadonlyMap<string, ProjectWorkflow>;
  readonly tools: Readonly<ToolsInput>;
}

export const emptyProjectGeneration: ProjectGenerationState = Object.freeze({
  id: 0,
  specialists: new Map(),
  specialistAgents: new Map(),
  workflows: new Map(),
  tools: {},
});

export class ProjectGenerationStore {
  #current: ProjectGenerationState;

  constructor(initial: ProjectGenerationState = emptyProjectGeneration) {
    this.#current = initial;
  }

  snapshot(): ProjectGenerationState {
    return this.#current;
  }

  activate(generation: ProjectGenerationState): ProjectGenerationState {
    this.#current = generation;
    return generation;
  }
}
