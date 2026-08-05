import { join, resolve } from "node:path";
import {
  prepareAgentControllerMount,
  type MastraCodeAgentController,
} from "@mastra/code-sdk";
import { setCustomProvidersSource } from "@mastra/code-sdk/agents/custom-provider-source";
import { createDynamicTools, type ToolLike } from "@mastra/code-sdk/agents/tools";
import { detectProject, type ProjectInfo } from "@mastra/code-sdk/utils/project";
import { Mastra } from "@mastra/core/mastra";
import type { ToolsInput } from "@mastra/core/agent";
import type { AgentControllerConfig } from "@mastra/core/agent-controller";
import type { ToolkitAgents } from "../agents/index.js";
import { createToolkitAgents } from "../agents/index.js";
import { createCodeModes } from "../agents/modes/index.js";
import type { ToolkitConfig } from "../config.js";
import { loadToolkitConfig } from "../config.js";
import { createA1CodeProvider, prepareCodeSdkSettings } from "../factory/code-sdk.js";
import { loadModelProfile } from "../models/profile.js";
import { ProxyGateway } from "../models/proxy-gateway.js";
import { createProjectMcpRuntime } from "../project/mcp.js";
import {
  ProjectResourceRuntime,
  type ProjectMcpRuntime,
  type ProjectResourceDiagnostic,
} from "../project/runtime.js";
import { watchProjectResources, type ProjectResourceWatcher } from "../project/watcher.js";
import { createToolkitWorkspace } from "./workspace.js";

export interface LocalProjectRuntimeOptions {
  readonly cwd?: string;
  readonly config?: ToolkitConfig;
  readonly dataDirectory?: string;
  readonly browser?: boolean;
  readonly watch?: boolean;
  readonly mcp?: ProjectMcpRuntime;
  readonly disableMcp?: boolean;
  readonly disableHooks?: boolean;
  readonly disablePlugins?: boolean;
  readonly disableGithubSignals?: boolean;
  readonly memory?: AgentControllerConfig["memory"] | false;
  readonly onDiagnostic?: (diagnostic: ProjectResourceDiagnostic) => void;
}

export interface PreparedLocalProjectRuntime {
  readonly project: ProjectInfo;
  readonly config: ToolkitConfig;
  readonly agents: ToolkitAgents;
  readonly mastraArgs: NonNullable<ConstructorParameters<typeof Mastra>[0]>;
  finalize(mastra: Mastra): Promise<MountedLocalProjectRuntime>;
}

export interface MountedLocalProjectRuntime {
  readonly project: ProjectInfo;
  readonly config: ToolkitConfig;
  readonly agents: ToolkitAgents;
  readonly mastra: Mastra;
  readonly controller: MastraCodeAgentController["controller"];
  readonly code: MastraCodeAgentController;
  readonly resources: ProjectResourceRuntime;
  close(): Promise<void>;
}

export async function prepareLocalProjectRuntime(
  options: LocalProjectRuntimeOptions = {},
): Promise<PreparedLocalProjectRuntime> {
  const project = detectProject(resolve(options.cwd ?? process.cwd()));
  const config = options.config ?? loadToolkitConfig({ ...process.env, WORKSPACE_ROOT: project.rootPath });
  const proxyApiKey = config.proxy.apiKey;
  const profile = loadModelProfile();
  const workspace = createToolkitWorkspace(config, { projectRoot: project.rootPath, hotReloadSkills: true });
  const agents = createToolkitAgents({
    workspaceRoot: project.rootPath,
    browser: options.browser ?? true,
    ...(config.browser.executablePath ? { browserExecutablePath: config.browser.executablePath } : {}),
    ...(config.browser.userDataDir ? { browserUserDataDir: config.browser.userDataDir } : {}),
  });
  let resources: ProjectResourceRuntime | undefined;
  const dynamicTools = createDynamicTools(undefined, () =>
    (resources?.getTools() ?? {}) as Record<string, ToolLike>,
  ) as unknown as ToolsInput;
  const dataDirectory = await prepareCodeSdkSettings({
    ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
    profile,
    provider: { baseUrl: config.proxy.baseUrl, models: profile.aliases },
  });
  setCustomProvidersSource(() => [createA1CodeProvider({
    baseUrl: config.proxy.baseUrl,
    ...(proxyApiKey ? { apiKey: proxyApiKey } : {}),
    models: profile.aliases,
  })]);
  let controllerMount: Awaited<ReturnType<typeof prepareAgentControllerMount>>;
  try {
    controllerMount = await prepareAgentControllerMount({
      cwd: project.rootPath,
      settingsPath: join(dataDirectory, "settings.json"),
      modes: createCodeModes(agents, dynamicTools),
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
      proxy: new ProxyGateway(config.proxy),
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
    async finalize(mastra: Mastra): Promise<MountedLocalProjectRuntime> {
      const mcp = options.mcp
        ?? (options.disableMcp ? emptyMcpRuntime() : createProjectMcpRuntime(project.rootPath));
      let watcher: ProjectResourceWatcher | undefined;
      try {
        resources = await ProjectResourceRuntime.create({
          projectRoot: project.rootPath,
          profile,
          mastra,
          mcp,
          workspace,
          ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
        });
        await controllerMount.finalize();
        if (options.watch ?? true) {
          watcher = watchProjectResources({
            projectRoot: project.rootPath,
            reload: () => resources!.reload().then(() => undefined),
          });
        }
      } catch (error) {
        watcher?.close();
        await resources?.close().catch(() => undefined);
        if (!resources) await mcp.close().catch(() => undefined);
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
          watcher?.close();
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

async function closePubSub(pubsub: MastraCodeAgentController["signalsPubSub"]): Promise<void> {
  const close = (pubsub as { close?: () => void | Promise<void> } | undefined)?.close;
  await close?.call(pubsub);
}

function emptyMcpRuntime(): ProjectMcpRuntime {
  return {
    async reload() {},
    getTools: () => ({}),
    async close() {},
  };
}

export async function mountLocalProjectRuntime(
  options: LocalProjectRuntimeOptions = {},
): Promise<MountedLocalProjectRuntime> {
  const prepared = await prepareLocalProjectRuntime(options);
  const mastra = new Mastra(prepared.mastraArgs);
  return prepared.finalize(mastra);
}
