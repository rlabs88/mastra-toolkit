import { type CurrentToolSnapshotPort, type HostGenerationRegistration, type McpLifecyclePort, type ModelAliasResolverPort, type PreparedHostRegistration, type PreparedMcpGeneration, type ProjectGenerationState, ProjectGenerationStore, type ProjectMountingDiagnostic, type ProjectMountingDiagnosticListener, type ProjectMountingDiagnosticPhase, ProjectMountingDiagnostics, type StagedHostRegistrationPort } from "./contract.js";
import { discoverProjectSpecialists, discoverProjectWorkflows, type ProjectResourceWatcher, type ProjectSpecialist, type ProjectWorkflow, validateProjectMcpConfiguration, watchProjectResources } from "./discovery.js";
import { Agent, type ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import type { Workspace } from "@mastra/core/workspace";
import { z } from "zod";

export interface ProjectMountingManagerOptions {
  readonly projectRoot: string;
  readonly modelAliases: ModelAliasResolverPort;
  readonly mcp: McpLifecyclePort;
  readonly currentTools: CurrentToolSnapshotPort;
  readonly host: StagedHostRegistrationPort;
  readonly workspace?: Workspace;
  readonly specialistMaxSteps?: number;
  readonly requiredSpecialistTools?: readonly string[];
  readonly onDiagnostic?: ProjectMountingDiagnosticListener;
}

export interface ProjectMountingWatchOptions {
  readonly debounceMs?: number;
}

export class ProjectMountingManager {
  readonly #options: ProjectMountingManagerOptions;
  readonly #store = new ProjectGenerationStore();
  readonly #diagnostics: ProjectMountingDiagnostics;
  readonly #specialistTool: ReturnType<typeof createProjectSpecialistTool>;
  #nextGeneration = 1;
  #reloadQueue: Promise<void> = Promise.resolve();
  #watcher: ProjectResourceWatcher | undefined;

  private constructor(options: ProjectMountingManagerOptions) {
    this.#options = options;
    this.#diagnostics = new ProjectMountingDiagnostics(options.onDiagnostic);
    this.#specialistTool = createProjectSpecialistTool(() => this.snapshot());
  }

  static async create(options: ProjectMountingManagerOptions): Promise<ProjectMountingManager> {
    const manager = new ProjectMountingManager(options);
    await manager.reload();
    return manager;
  }

  snapshot(): ProjectGenerationState {
    return this.#store.snapshot();
  }

  getTools(): ToolsInput {
    return { ...this.snapshot().tools };
  }

  diagnostics(): readonly ProjectMountingDiagnostic[] {
    return this.#diagnostics.snapshot();
  }

  reload(): Promise<ProjectGenerationState> {
    const reload = this.#reloadQueue.then(() => this.activateCandidate());
    this.#reloadQueue = reload.then(() => undefined, () => undefined);
    return reload;
  }

  startWatching(options: ProjectMountingWatchOptions = {}): ProjectResourceWatcher {
    this.#watcher?.close();
    this.#watcher = watchProjectResources({
      projectRoot: this.#options.projectRoot,
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      reload: async () => {
        await this.reload();
      },
      onError: error => {
        this.#diagnostics.record("watch", error);
      },
    });
    return this.#watcher;
  }

  async close(): Promise<void> {
    this.#watcher?.close();
    this.#watcher = undefined;
    await this.#reloadQueue;
    try {
      await this.#options.mcp.close();
    } catch (error) {
      this.#diagnostics.record("close", error);
      throw error;
    }
  }

  private async activateCandidate(): Promise<ProjectGenerationState> {
    let phase: ProjectMountingDiagnosticPhase = "discover";
    let mcpStage: PreparedMcpGeneration | undefined;
    let hostStage: PreparedHostRegistration | undefined;
    try {
      const specialists = await discoverProjectSpecialists(
        this.#options.projectRoot,
        this.#options.modelAliases,
      );
      const workflows = await discoverProjectWorkflows(this.#options.projectRoot);
      await validateProjectMcpConfiguration(this.#options.projectRoot);

      phase = "mcp";
      mcpStage = await this.#options.mcp.prepare();

      phase = "prepare";
      const publishedTools = mergeToolSnapshots(
        await this.#options.currentTools.snapshot(),
        await mcpStage.snapshot(),
        workflowTools(workflows),
      );
      const generation = this.createGeneration(specialists, workflows, publishedTools);
      const registration: HostGenerationRegistration = { generation };
      hostStage = await this.#options.host.prepare(registration);

      phase = "commit";
      await mcpStage.commit();
      await hostStage.commit();

      this.#nextGeneration += 1;
      const activated = this.#store.activate(generation);
      try {
        await mcpStage.retirePrevious?.();
      } catch (error) {
        this.#diagnostics.record("close", error);
      }
      return activated;
    } catch (error) {
      await this.rollback(hostStage, mcpStage);
      this.#diagnostics.record(phase, error);
      throw error;
    }
  }

  private createGeneration(
    specialists: ReadonlyMap<string, ProjectSpecialist>,
    workflows: ReadonlyMap<string, ProjectWorkflow>,
    publishedTools: ToolsInput,
  ): ProjectGenerationState {
    const id = this.#nextGeneration;
    const specialistAgents = createSpecialistAgents({
      generationId: id,
      specialists,
      tools: publishedTools,
      requiredTools: this.#options.requiredSpecialistTools ?? [],
      ...(this.#options.workspace ? { workspace: this.#options.workspace } : {}),
      maxSteps: this.#options.specialistMaxSteps ?? 48,
    });
    return {
      id,
      specialists,
      specialistAgents,
      workflows,
      tools: { ...publishedTools, project_specialist: this.#specialistTool },
    };
  }

  private async rollback(
    hostStage: PreparedHostRegistration | undefined,
    mcpStage: PreparedMcpGeneration | undefined,
  ): Promise<void> {
    const rollbacks = [hostStage?.rollback(), mcpStage?.rollback()].filter(
      (rollback): rollback is Promise<void> => rollback !== undefined,
    );
    const results = await Promise.allSettled(rollbacks);
    for (const result of results) {
      if (result.status === "rejected") this.#diagnostics.record("rollback", result.reason);
    }
  }
}

interface CreateSpecialistAgentsOptions {
  readonly generationId: number;
  readonly specialists: ReadonlyMap<string, ProjectSpecialist>;
  readonly tools: ToolsInput;
  readonly requiredTools: readonly string[];
  readonly workspace?: Workspace;
  readonly maxSteps: number;
}

function createSpecialistAgents(options: CreateSpecialistAgentsOptions): ReadonlyMap<string, Agent> {
  const agents = new Map<string, Agent>();
  for (const specialist of options.specialists.values()) {
    const tools = selectSpecialistTools(specialist, options.tools, options.requiredTools);
    agents.set(specialist.id, new Agent({
      id: `project-specialist-${specialist.id}-${options.generationId}`,
      name: specialist.name,
      description: specialist.description,
      instructions: specialist.instructions,
      model: specialist.model,
      tools,
      ...(options.workspace ? { workspace: options.workspace } : {}),
      defaultOptions: { maxSteps: options.maxSteps },
    }));
  }
  return agents;
}

function selectSpecialistTools(
  specialist: ProjectSpecialist,
  available: ToolsInput,
  required: readonly string[],
): ToolsInput {
  if (!specialist.tools) return { ...available };
  const selected: ToolsInput = {};
  for (const toolName of new Set([...specialist.tools, ...required])) {
    if (!Object.hasOwn(available, toolName)) {
      throw new Error(`Unknown tool for specialist ${specialist.id}: ${toolName}`);
    }
    selected[toolName] = available[toolName]!;
  }
  return selected;
}

function workflowTools(workflows: ReadonlyMap<string, ProjectWorkflow>): ToolsInput {
  const tools: ToolsInput = {};
  for (const workflow of workflows.values()) {
    if (workflow.tool) tools[workflow.tool.id] = workflow.tool;
  }
  return tools;
}

function mergeToolSnapshots(...snapshots: readonly Readonly<ToolsInput>[]): ToolsInput {
  const merged: ToolsInput = {};
  for (const snapshot of snapshots) {
    for (const [id, tool] of Object.entries(snapshot)) {
      if (Object.hasOwn(merged, id)) throw new Error(`Duplicate published tool ID: ${id}`);
      merged[id] = tool;
    }
  }
  return merged;
}

const specialistInputSchema = z.object({
  specialist: z.string().min(1),
  task: z.string().min(1),
});

const specialistOutputSchema = z.object({
  specialist: z.string(),
  generation: z.number().int().nonnegative(),
  text: z.string(),
});

export function createProjectSpecialistTool(
  getGeneration: () => ProjectGenerationState,
): ReturnType<typeof createTool> {
  return createTool({
    id: "project_specialist",
    description: "Delegate a bounded task to a mounted project specialist.",
    inputSchema: specialistInputSchema,
    outputSchema: specialistOutputSchema,
    execute: async (input, context) => {
      const generation = getGeneration();
      const specialist = generation.specialists.get(input.specialist);
      if (!specialist) throw new Error(`Unknown project specialist: ${input.specialist}`);
      if (specialist.disableModelInvocation) {
        throw new Error(`Project specialist is disabled for model invocation: ${input.specialist}`);
      }
      const agent = generation.specialistAgents.get(input.specialist);
      if (!agent) throw new Error(`Project specialist is unavailable: ${input.specialist}`);
      const result = await agent.generate(input.task, { requestContext: context.requestContext });
      return { specialist: specialist.id, generation: generation.id, text: result.text };
    },
  });
}
