import { Agent } from "@mastra/core/agent";
import type { ToolsInput } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import type { Workspace } from "@mastra/core/workspace";
import type { ToolLike } from "@mastra/code-sdk/agents/tools";
import type { ModelProfile } from "../models/profile.js";
import { AtomicResourceStore } from "./atomic-store.js";
import { validateMcpConfigFiles } from "./mcp.js";
import { createProjectSpecialistTool } from "./specialist-tool.js";
import { loadProjectSpecialists, type ProjectSpecialist } from "./specialists.js";
import { loadProjectWorkflows, type ProjectWorkflow } from "./workflows.js";

export interface ProjectMcpRuntime {
  reload(): Promise<void>;
  rollback?(): Promise<void>;
  getTools(): Record<string, unknown>;
  close(): Promise<void>;
}

export interface ProjectResourceGeneration {
  readonly id: number;
  readonly specialists: ReadonlyMap<string, ProjectSpecialist>;
  readonly specialistAgents: ReadonlyMap<string, Agent>;
  readonly workflows: ReadonlyMap<string, ProjectWorkflow>;
  readonly tools: Readonly<Record<string, ToolLike>>;
}

export interface ProjectResourceDiagnostic {
  readonly phase: "load" | "mcp" | "publish";
  readonly message: string;
  readonly occurredAt: string;
}

interface ProjectResourceRuntimeOptions {
  readonly projectRoot: string;
  readonly profile: ModelProfile;
  readonly mastra: Mastra;
  readonly mcp: ProjectMcpRuntime;
  readonly workspace?: Workspace;
  readonly onDiagnostic?: (diagnostic: ProjectResourceDiagnostic) => void;
}

const emptyGeneration: ProjectResourceGeneration = {
  id: 0,
  specialists: new Map(),
  specialistAgents: new Map(),
  workflows: new Map(),
  tools: {},
};

export class ProjectResourceRuntime {
  readonly #options: ProjectResourceRuntimeOptions;
  readonly #store = new AtomicResourceStore(emptyGeneration);
  readonly #specialistTool: ReturnType<typeof createProjectSpecialistTool>;
  #nextGeneration = 1;

  private constructor(options: ProjectResourceRuntimeOptions) {
    this.#options = options;
    this.#specialistTool = createProjectSpecialistTool(() => this.snapshot());
  }

  static async create(options: ProjectResourceRuntimeOptions): Promise<ProjectResourceRuntime> {
    const runtime = new ProjectResourceRuntime(options);
    await runtime.reload();
    return runtime;
  }

  snapshot(): ProjectResourceGeneration {
    return this.#store.snapshot();
  }

  getTools(): Record<string, ToolLike> {
    return { ...this.snapshot().tools };
  }

  async reload(): Promise<ProjectResourceGeneration> {
    try {
      const candidate = await this.buildCandidate();
      return await this.#store.reload(async () => candidate);
    } catch (error) {
      this.emitDiagnostic("load", error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#options.mcp.close();
  }

  private async buildCandidate(): Promise<ProjectResourceGeneration> {
    const generationId = this.#nextGeneration;
    const specialists = await loadProjectSpecialists(this.#options.projectRoot, this.#options.profile);
    const workflows = await loadProjectWorkflows(this.#options.projectRoot);
    await validateMcpConfigFiles(this.#options.projectRoot);
    let mcpReloaded = false;
    try {
      await this.#options.mcp.reload();
      mcpReloaded = true;
      const baseTools = collectTools(this.#options.mcp.getTools(), workflows);
      const specialistAgents = this.createSpecialistAgents(generationId, specialists, baseTools);
      const tools: Record<string, ToolLike> = {
        ...baseTools,
        project_specialist: this.#specialistTool as unknown as ToolLike,
      };
      this.registerGeneration(generationId, workflows, specialistAgents);
      this.#nextGeneration += 1;
      return { id: generationId, specialists, specialistAgents, workflows, tools };
    } catch (error) {
      if (mcpReloaded) await this.#options.mcp.rollback?.();
      throw error;
    }
  }

  private createSpecialistAgents(
    generationId: number,
    specialists: ReadonlyMap<string, ProjectSpecialist>,
    tools: Record<string, ToolLike>,
  ): ReadonlyMap<string, Agent> {
    const agents = new Map<string, Agent>();
    for (const specialist of specialists.values()) {
      const selectedTools = selectSpecialistTools(specialist, tools);
      agents.set(specialist.id, new Agent({
        id: `project-specialist-${specialist.id}-${generationId}`,
        name: specialist.name,
        description: specialist.description,
        instructions: specialist.instructions,
        model: `proxy/${specialist.modelId}`,
        tools: selectedTools as ToolsInput,
        ...(this.#options.workspace ? { workspace: this.#options.workspace } : {}),
        defaultOptions: { maxSteps: 48 },
      }));
    }
    return agents;
  }

  private registerGeneration(
    generationId: number,
    workflows: ReadonlyMap<string, ProjectWorkflow>,
    agents: ReadonlyMap<string, Agent>,
  ): void {
    for (const workflow of workflows.values()) {
      this.#options.mastra.addWorkflow(workflow.workflow, `${workflow.id}@${workflow.generation}`);
    }
    for (const [id, agent] of agents) this.#options.mastra.addAgent(agent, `project-specialist-${id}@${generationId}`);
  }

  private emitDiagnostic(phase: ProjectResourceDiagnostic["phase"], error: unknown): void {
    this.#options.onDiagnostic?.({
      phase,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: new Date().toISOString(),
    });
  }
}

function collectTools(
  mcpTools: Record<string, unknown>,
  workflows: ReadonlyMap<string, ProjectWorkflow>,
): Record<string, ToolLike> {
  const tools: Record<string, ToolLike> = {};
  for (const [id, tool] of Object.entries(mcpTools)) tools[id] = tool as ToolLike;
  for (const workflow of workflows.values()) {
    if (workflow.tool) tools[workflow.tool.id] = workflow.tool as unknown as ToolLike;
  }
  return tools;
}

function selectSpecialistTools(
  specialist: ProjectSpecialist,
  available: Record<string, ToolLike>,
): Record<string, ToolLike> {
  if (!specialist.tools) return { ...available };
  const selected: Record<string, ToolLike> = {};
  for (const toolName of specialist.tools) {
    if (!Object.hasOwn(available, toolName)) throw new Error(`Unknown tool for specialist ${specialist.id}: ${toolName}`);
    selected[toolName] = available[toolName]!;
  }
  return selected;
}
