import { createMcpManager, type McpManager, type McpServerConfig } from "@mastra/code-sdk/mcp/index";
import type { Agent, ToolsInput } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import type { CurrentToolSnapshotPort, HostGenerationRegistration, McpLifecyclePort, ModelAliasResolverPort, PreparedHostRegistration, PreparedMcpGeneration, StagedHostRegistrationPort } from "@rlabs/project-mounting-manager";
import { type ModelProfile, resolveAliasModelId } from "@rlabs/runtime-config";
import { createSandboxMachine, type SandboxConfig } from "@rlabs/sandbox";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export class CodeMcpAdapter implements McpLifecyclePort {
  readonly #createCandidate: () => McpManager;
  #current: McpManager | undefined;

  constructor(createCandidate: () => McpManager) {
    this.#createCandidate = createCandidate;
  }

  async prepare(): Promise<PreparedMcpGeneration> {
    const candidate = this.#createCandidate();
    const result = await candidate.initInBackground();
    if (result.failed.length > 0) {
      await candidate.disconnect();
      throw new Error(`MCP candidate failed to connect: ${result.failed.map(server => server.name).join(", ")}`);
    }
    const previous = this.#current;
    let committed = false;
    let rolledBack = false;
    return {
      snapshot: () => candidate.getTools(),
      commit: async () => {
        if (committed || rolledBack) return;
        this.#current = candidate;
        committed = true;
      },
      rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        if (committed) {
          this.#current = previous;
        }
        await candidate.disconnect();
      },
      retirePrevious: async () => {
        if (committed && !rolledBack && previous) await previous.disconnect();
      },
    };
  }

  getTools(): Record<string, unknown> {
    return this.#current?.getTools() ?? {};
  }

  async close(): Promise<void> {
    const managers = this.#current ? [this.#current] : [];
    this.#current = undefined;
    await Promise.all(managers.map(manager => manager.disconnect()));
  }
}

export function createCodeMcpAdapter(
  projectRoot: string,
  programmaticServers?: Record<string, McpServerConfig>,
): CodeMcpAdapter {
  return new CodeMcpAdapter(() => createMcpManager(projectRoot, ".mastracode", programmaticServers));
}

export class ProfileModelAliasResolver implements ModelAliasResolverPort {
  readonly #profile: ModelProfile;

  constructor(profile: ModelProfile) {
    this.#profile = profile;
  }

  resolveSpecialistModel(alias: string | undefined): string {
    return `proxy/${resolveAliasModelId(this.#profile, alias ?? this.#profile.roles.specialist)}`;
  }
}

export class StaticToolSnapshot implements CurrentToolSnapshotPort {
  constructor(private readonly tools: Readonly<ToolsInput>) {}

  snapshot(): Readonly<ToolsInput> {
    return this.tools;
  }
}

export class MastraProjectHostRegistry implements StagedHostRegistrationPort {
  readonly #mastra: Mastra;
  #agents = new Map<string, Agent>();
  #workflowGenerations = new Map<string, string>();

  constructor(mastra: Mastra) {
    this.#mastra = mastra;
  }

  async prepare(registration: HostGenerationRegistration): Promise<PreparedHostRegistration> {
    const agentKeys = [...registration.generation.specialistAgents].map(([id]) =>
      `project-specialist-${id}@${registration.generation.id}`
    );
    const candidateAgents = new Map<string, Agent>();
    for (const [[, agent], key] of zip(registration.generation.specialistAgents, agentKeys)) {
      candidateAgents.set(key, agent);
    }
    const previousAgents = new Map(this.#agents);
    const candidateWorkflows = new Map([...registration.generation.workflows].map(
      ([id, workflow]) => [id, workflow.generation],
    ));
    if (this.#workflowGenerations.size > 0 && !sameEntries(this.#workflowGenerations, candidateWorkflows)) {
      throw new Error("Project workflow hot reload requires an upstream Mastra workflow removal API");
    }
    const addedAgentKeys: string[] = [];
    let committed = false;
    return {
      commit: async () => {
        if (committed) return;
        for (const [key, agent] of candidateAgents) {
          this.#mastra.addAgent(agent, key);
          addedAgentKeys.push(key);
        }
        if (this.#workflowGenerations.size === 0) {
          for (const workflow of registration.generation.workflows.values()) {
            this.#mastra.addWorkflow(workflow.workflow, `project-workflow-${workflow.id}`);
          }
        }
        for (const key of this.#agents.keys()) this.#mastra.removeAgent(key);
        this.#agents = candidateAgents;
        this.#workflowGenerations = candidateWorkflows;
        committed = true;
      },
      rollback: async () => {
        for (const key of addedAgentKeys) this.#mastra.removeAgent(key);
        if (committed) {
          for (const [key, agent] of previousAgents) this.#mastra.addAgent(agent, key);
          this.#agents = previousAgents;
        }
      },
    };
  }
}

function sameEntries(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every(([key, value]) => right.get(key) === value);
}

function zip<T, U>(left: Iterable<T>, right: Iterable<U>): Array<[T, U]> {
  const rightValues = [...right];
  return [...left].map((value, index) => [value, rightValues[index]!] as [T, U]);
}

export function createMcodeWorkspace(
  config: SandboxConfig,
  options: { readonly projectRoot?: string; readonly hotReloadSkills?: boolean } = {},
): Workspace {
  const workspaceRoot = resolve(options.projectRoot ?? config.workspaceRoot);
  const sandbox = createSandboxMachine({
    provider: config.provider,
    workspaceRoot,
    specification: config.specification,
    ...(config.platform ? { platform: config.platform } : {}),
  });
  return new Workspace({
    id: "mastra-toolkit-workspace",
    name: "Mastra Toolkit Workspace",
    filesystem: new LocalFilesystem({
      basePath: workspaceRoot,
      contained: true,
      allowedPaths: ["~/.agents/skills", "~/.mastracode/skills"],
    }),
    sandbox,
    skills: [
      join(workspaceRoot, ".agents", "skills"),
      join(workspaceRoot, ".claude", "skills"),
      join(workspaceRoot, ".mastracode", "skills"),
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".mastracode", "skills"),
    ],
    checkSkillFileMtime: options.hotReloadSkills ?? false,
    tools: {
      mastra_workspace_execute_command: { requireApproval: true },
      mastra_workspace_write_file: { requireApproval: true },
      mastra_workspace_edit_file: { requireApproval: true },
      mastra_workspace_delete: { requireApproval: true },
    },
  });
}
