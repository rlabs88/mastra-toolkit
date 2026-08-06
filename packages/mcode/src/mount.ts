import { join, resolve } from "node:path";
import {
  prepareAgentControllerMount,
  type MastraCodeAgentController,
} from "@mastra/code-sdk";
import { setCustomProvidersSource } from "@mastra/code-sdk/agents/custom-provider-source";
import { createDynamicTools, type ToolLike } from "@mastra/code-sdk/agents/tools";
import { detectProject, type ProjectInfo } from "@mastra/code-sdk/utils/project";
import type { AgentControllerConfig } from "@mastra/core/agent-controller";
import { Mastra } from "@mastra/core/mastra";
import type { ToolkitAdditionalTools, ToolkitAgents } from "@rlabs/agents-roles";
import {
  ProjectMountingManager,
  type McpLifecyclePort,
  type PreparedMcpGeneration,
  type ProjectMountingDiagnostic,
} from "@rlabs/project-mounting-manager";
import {
  loadModelProfile,
  ProxyGateway,
  resolveRuntimeDefaultsV1,
  type ModelProfile,
} from "@rlabs/runtime-config";
import { createSandboxCommandRunTool } from "@rlabs/sandbox";
import type { McodeConfig } from "./config.js";
import { loadMcodeConfig } from "./config.js";
import { createCodeMcpAdapter } from "./mcp-adapter.js";
import { MastraProjectHostRegistry, ProfileModelAliasResolver, StaticToolSnapshot } from "./project-adapters.js";
import { createMcodeRecipe } from "./recipe.js";
import { createA1CodeProvider, prepareCodeSdkSettings } from "./settings.js";
import { fillMissingSubagentModelId } from "./subagents.js";
import { createMcodeWorkspace } from "./workspace.js";

export interface McodeRuntimeOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly config?: McodeConfig;
  readonly profile?: ModelProfile;
  readonly dataDirectory?: string;
  readonly browser?: boolean;
  readonly watch?: boolean;
  readonly mcp?: McpLifecyclePort;
  readonly disableMcp?: boolean;
  readonly disableHooks?: boolean;
  readonly disablePlugins?: boolean;
  readonly disableGithubSignals?: boolean;
  readonly memory?: AgentControllerConfig["memory"] | false;
  readonly onDiagnostic?: (diagnostic: ProjectMountingDiagnostic) => void;
}

export interface PreparedMcodeRuntime {
  readonly project: ProjectInfo;
  readonly config: McodeConfig;
  readonly agents: ToolkitAgents;
  readonly mastraArgs: NonNullable<ConstructorParameters<typeof Mastra>[0]>;
  finalize(mastra: Mastra): Promise<MountedMcodeRuntime>;
}

export interface MountedMcodeRuntime {
  readonly project: ProjectInfo;
  readonly config: McodeConfig;
  readonly agents: ToolkitAgents;
  readonly mastra: Mastra;
  readonly controller: MastraCodeAgentController["controller"];
  readonly code: MastraCodeAgentController;
  readonly resources: ProjectMountingManager;
  close(): Promise<void>;
}

export async function prepareMcodeRuntime(
  options: McodeRuntimeOptions = {},
): Promise<PreparedMcodeRuntime> {
  const project = detectProject(resolve(options.cwd ?? process.cwd()));
  const environment = { ...(options.environment ?? process.env), WORKSPACE_ROOT: project.rootPath };
  const profile = options.profile ?? loadModelProfile();
  const runtimeDefaults = resolveRuntimeDefaultsV1(profile);
  const config = options.config ?? loadMcodeConfig(environment, project.rootPath, profile);
  const workspace = createMcodeWorkspace(config.sandbox, {
    projectRoot: project.rootPath,
    hotReloadSkills: true,
  });
  const commandRun = createSandboxCommandRunTool();
  let resources: ProjectMountingManager | undefined;
  const dynamicTools = createDynamicTools(undefined, () =>
    (resources?.getTools() ?? {}) as Record<string, ToolLike>,
  ) as ToolkitAdditionalTools;
  const recipe = createMcodeRecipe({
    browser: options.browser ?? true,
    commandRun,
    additionalTools: dynamicTools,
    hooks: { beforeToolCall: ({ input }) => fillMissingSubagentModelId(profile, input) },
    profile,
    ...(config.browser.executablePath ? { browserExecutablePath: config.browser.executablePath } : {}),
    ...(config.browser.userDataDir ? { browserUserDataDir: config.browser.userDataDir } : {}),
  });
  const agents = recipe.agents;
  const dataDirectory = await prepareCodeSdkSettings({
    ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
    defaults: runtimeDefaults,
    provider: { baseUrl: config.runtime.proxy.baseUrl, models: runtimeDefaults.gateway.models },
  });
  setCustomProvidersSource(() => [createA1CodeProvider({
    baseUrl: config.runtime.proxy.baseUrl,
    ...(config.runtime.proxy.apiKey ? { apiKey: config.runtime.proxy.apiKey } : {}),
    models: runtimeDefaults.gateway.models,
  })]);

  let controllerMount: Awaited<ReturnType<typeof prepareAgentControllerMount>>;
  try {
    controllerMount = await prepareAgentControllerMount({
      cwd: project.rootPath,
      settingsPath: join(dataDirectory, "settings.json"),
      modes: recipe.controller.modes,
      subagents: recipe.controller.subagents,
      workspace,
      disableMcp: true,
      disableHooks: options.disableHooks ?? false,
      disablePlugins: options.disablePlugins ?? false,
      disableGithubSignals: options.disableGithubSignals ?? true,
      ...(options.memory === false ? { memory: false } : options.memory ? { memory: options.memory } : {}),
      intervalHandlers: [],
    });
  } catch (error) {
    setCustomProvidersSource(undefined);
    throw error;
  }

  const mastraArgs: NonNullable<ConstructorParameters<typeof Mastra>[0]> = {
    ...controllerMount.mastraArgs,
    agents: { ...(controllerMount.mastraArgs.agents ?? {}), ...agents },
    gateways: {
      ...(controllerMount.mastraArgs.gateways ?? {}),
      proxy: new ProxyGateway({ ...config.runtime.proxy, models: runtimeDefaults.gateway.models }),
    },
    workspace,
    backgroundTasks: {
      enabled: true,
      mode: "full",
      globalConcurrency: 10,
      perAgentConcurrency: 4,
      backpressure: "queue",
      defaultTimeoutMs: 300_000,
      waitTimeoutMs: 30_000,
    },
  };

  return {
    project,
    config,
    agents,
    mastraArgs,
    async finalize(mastra: Mastra): Promise<MountedMcodeRuntime> {
      const mcp = options.mcp
        ?? (options.disableMcp ? new EmptyMcpLifecycle() : createCodeMcpAdapter(project.rootPath));
      try {
        resources = await ProjectMountingManager.create({
          projectRoot: project.rootPath,
          modelAliases: new ProfileModelAliasResolver(profile),
          mcp,
          currentTools: new StaticToolSnapshot({ command_run: commandRun }),
          requiredSpecialistTools: ["command_run"],
          host: new MastraProjectHostRegistry(mastra),
          workspace,
          ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
        });
        await controllerMount.finalize();
        if (options.watch ?? true) resources.startWatching();
      } catch (error) {
        await resources?.close().catch(() => undefined);
        if (!resources) await mcp.close().catch(() => undefined);
        setCustomProvidersSource(undefined);
        throw error;
      }

      return {
        project,
        config,
        agents,
        mastra,
        controller: controllerMount.base.controller,
        code: controllerMount.base,
        resources,
        async close(): Promise<void> {
          await resources!.close();
          await controllerMount.base.controller.getMastra()?.stopWorkers();
          await controllerMount.base.controller.stopIntervals();
          await closePubSub(controllerMount.base.signalsPubSub);
          await controllerMount.base.storageMaintenance.closeStorage?.();
          setCustomProvidersSource(undefined);
        },
      };
    },
  };
}

export async function mountMcodeRuntime(options: McodeRuntimeOptions = {}): Promise<MountedMcodeRuntime> {
  const prepared = await prepareMcodeRuntime(options);
  return prepared.finalize(new Mastra(prepared.mastraArgs));
}

class EmptyMcpLifecycle implements McpLifecyclePort {
  async prepare(): Promise<PreparedMcpGeneration> {
    return { snapshot: () => ({}), async commit() {}, async rollback() {} };
  }

  async close(): Promise<void> {}
}

async function closePubSub(pubsub: MastraCodeAgentController["signalsPubSub"]): Promise<void> {
  const close = (pubsub as { close?: () => void | Promise<void> } | undefined)?.close;
  await close?.call(pubsub);
}
