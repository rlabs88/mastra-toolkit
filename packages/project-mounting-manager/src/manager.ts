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
  /**
   * Host tool IDs that a project may not shadow but may not call either. Reserved IDs take part in
   * collision detection without entering the published tool map, so they reach neither project
   * specialists nor `getTools()`. Pass a reserved ID here rather than through `currentTools`:
   * everything in `currentTools` is published to unrestricted specialists.
   */
  readonly reservedToolIds?: readonly string[];
  /**
   * Capability names a specialist may name instead of a published tool ID, each expanding to the
   * IDs that deliver it. `.github/agents` is shared with GitHub Copilot, whose agent files describe
   * tools as capabilities (`read`, `edit`) rather than as this host's IDs; without a translation
   * every such file fails the generation and takes the runtime down with it.
   *
   * The host owns the map because the IDs are its own. An alias resolves to whichever of its IDs
   * are actually published, so a host missing one still satisfies the capability; an alias that
   * resolves to nothing published is an unknown tool and still fails closed, as does a name that is
   * neither an alias nor a published ID.
   */
  readonly specialistToolAliases?: Readonly<Record<string, readonly string[]>>;
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
        this.#options.reservedToolIds ?? [],
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
      reservedToolIds: this.#options.reservedToolIds ?? [],
      requiredTools: this.#options.requiredSpecialistTools ?? [],
      toolAliases: this.#options.specialistToolAliases ?? {},
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
  readonly reservedToolIds: readonly string[];
  readonly requiredTools: readonly string[];
  readonly toolAliases: Readonly<Record<string, readonly string[]>>;
  readonly workspace?: Workspace;
  readonly maxSteps: number;
}

function createSpecialistAgents(options: CreateSpecialistAgentsOptions): ReadonlyMap<string, Agent> {
  const agents = new Map<string, Agent>();
  const reserved = new Set(options.reservedToolIds);
  for (const specialist of options.specialists.values()) {
    const tools = selectSpecialistTools(
      specialist,
      options.tools,
      options.requiredTools,
      reserved,
      options.toolAliases,
    );
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
  reserved: ReadonlySet<string>,
  aliases: Readonly<Record<string, readonly string[]>>,
): ToolsInput {
  // An unrestricted specialist receives every published tool, so reserved IDs are kept out of
  // `available` upstream rather than filtered here.
  if (!specialist.tools) return { ...available };
  const selected: ToolsInput = {};
  for (const toolName of new Set([...specialist.tools, ...required])) {
    if (reserved.has(toolName)) {
      throw new Error(`Reserved host tool cannot be granted to specialist ${specialist.id}: ${toolName}`);
    }
    // A published ID always wins, so a host that publishes a tool named like a capability keeps
    // its literal meaning and the alias table can never shadow a real tool.
    const isPublished = Object.hasOwn(available, toolName);
    const alias = isPublished ? undefined : aliases[toolName];
    if (!isPublished && !alias) {
      throw new Error(`Unknown tool for specialist ${specialist.id}: ${toolName}`);
    }
    const expansion = isPublished ? [toolName] : alias!;
    // Checked before the availability filter: a reserved ID is never published, so filtering first
    // would quietly drop it and turn a host misconfigured alias into a silent no-grant.
    for (const candidate of expansion) {
      if (reserved.has(candidate)) {
        throw new Error(
          `Reserved host tool cannot be granted to specialist ${specialist.id}: ${candidate} (via ${toolName})`,
        );
      }
    }
    // An alias that resolves to nothing published is a capability the host recognizes but does not
    // grant here, which is a deliberate no-grant rather than an authoring mistake.
    for (const candidate of expansion) {
      if (Object.hasOwn(available, candidate)) selected[candidate] = available[candidate]!;
    }
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

/**
 * Reserved IDs are claimed before any snapshot is merged, so a project workflow still cannot shadow
 * a host tool ID, but the reserved tool itself never becomes publishable.
 */
function mergeToolSnapshots(
  reservedToolIds: readonly string[],
  ...snapshots: readonly Readonly<ToolsInput>[]
): ToolsInput {
  const merged: ToolsInput = {};
  const reserved = new Set(reservedToolIds);
  for (const snapshot of snapshots) {
    for (const [id, tool] of Object.entries(snapshot)) {
      if (reserved.has(id)) {
        throw new Error(`Duplicate published tool ID: ${id} (reserved by the host)`);
      }
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
