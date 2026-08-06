import { createCodeMcpAdapter, createMcodeWorkspace, MastraProjectHostRegistry, ProfileModelAliasResolver, StaticToolSnapshot } from "./project.js";
import { CANONICAL_AGENT_IDS, CODE_MODE_IDS, createMcodeRecipe, fillMissingSubagentModelId } from "./recipe.js";
import { type MastraCodeAgentController, prepareAgentControllerMount, wireSessionConcerns } from "@mastra/code-sdk";
import { setCustomProvidersSource } from "@mastra/code-sdk/agents/custom-provider-source";
import { createMastraCodeGateway, type MastraCodeCustomProvider } from "@mastra/code-sdk/agents/model";
import { createDynamicTools, type ToolLike } from "@mastra/code-sdk/agents/tools";
import { ONBOARDING_VERSION } from "@mastra/code-sdk/onboarding/index";
import type { MastraCodeState } from "@mastra/code-sdk/schema";
import { detectProject, type ProjectInfo } from "@mastra/code-sdk/utils/project";
import { releaseAllThreadLocks } from "@mastra/code-sdk/utils/thread-lock";
import type { AgentControllerConfig, Session } from "@mastra/core/agent-controller";
import { Mastra } from "@mastra/core/mastra";
import type { ToolkitAdditionalTools, ToolkitAgents } from "@rlabs/agents-roles";
import { type McpLifecyclePort, type PreparedMcpGeneration, type ProjectMountingDiagnostic, ProjectMountingManager } from "@rlabs/project-mounting-manager";
import { A1_PROXY_PROVIDER_ID, A1_PROXY_PROVIDER_NAME, getA1ProxyModelId, loadModelProfile, loadRuntimeConfig, type ModelProfile, prepareHostDataDirectory, ProxyGateway, resolveRuntimeDefaultsV1, type RuntimeConfig, type RuntimeDefaultsV1, type ToolkitHostId } from "@rlabs/runtime-config";
import { createSandboxCommandRunTool, loadSandboxConfig, type SandboxConfig } from "@rlabs/sandbox";
import { MastraTUI } from "mastracode/tui";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const browserEnvironmentSchema = z.object({
  BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
  BROWSER_USER_DATA_DIR: z.string().min(1).optional(),
});

export interface McodeConfig {
  readonly runtime: RuntimeConfig;
  readonly sandbox: SandboxConfig;
  readonly browser: {
    readonly executablePath?: string;
    readonly userDataDir?: string;
  };
}

export function loadMcodeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
  profile?: ModelProfile,
): McodeConfig {
  const browser = browserEnvironmentSchema.parse(environment);
  return {
    runtime: loadRuntimeConfig(environment, profile),
    sandbox: loadSandboxConfig(environment, startDirectory),
    browser: {
      ...(browser.BROWSER_EXECUTABLE_PATH ? { executablePath: browser.BROWSER_EXECUTABLE_PATH } : {}),
      ...(browser.BROWSER_USER_DATA_DIR ? { userDataDir: browser.BROWSER_USER_DATA_DIR } : {}),
    },
  };
}

export const A1_CODE_PROVIDER_ID = A1_PROXY_PROVIDER_ID;
export const A1_CODE_PROVIDER_NAME = A1_PROXY_PROVIDER_NAME;

interface SettingsDocument {
  onboarding?: Record<string, unknown>;
  models?: Record<string, unknown> & {
    modeDefaults?: Record<string, string>;
    subagentModels?: Record<string, string>;
    observerModelOverride?: string | null;
    reflectorModelOverride?: string | null;
    omObservationThreshold?: number | null;
    omReflectionThreshold?: number | null;
  };
  preferences?: Record<string, unknown>;
  customProviders?: Array<{ name: string; url: string; models: string[] }>;
  [key: string]: unknown;
}

export interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export function getA1CodeModelId(model: string): string {
  return getA1ProxyModelId(model);
}

export async function prepareCodeSdkSettings(options: {
  readonly dataDirectory?: string;
  readonly host?: Extract<ToolkitHostId, "mcode" | "studio">;
  readonly environment?: NodeJS.ProcessEnv;
  readonly defaults: RuntimeDefaultsV1;
  readonly provider?: Omit<A1ProviderOptions, "apiKey">;
}): Promise<string> {
  const environment = options.environment ?? process.env;
  const directory = options.dataDirectory
    ?? (await prepareHostDataDirectory(options.host ?? "mcode", environment)).directory;
  process.env.MASTRA_APP_DATA_DIR = directory;
  await mkdir(directory, { recursive: true });
  const settingsPath = join(directory, "settings.json");
  const existing = await readSettings(settingsPath);
  const defaults = options.defaults.codeSdk;
  const existingModels = existing.models ?? {};
  const existingPreferences = existing.preferences ?? {};
  const settings: SettingsDocument = {
    ...existing,
    onboarding: {
      ...(existing.onboarding ?? {}),
      version: ONBOARDING_VERSION,
      completedAt: new Date(0).toISOString(),
      quietModePreferenceSelected: true,
    },
    models: {
      ...existingModels,
      modeDefaults: Object.fromEntries(CODE_MODE_IDS.map(id => [
        id,
        resolvePersistedModelId(existingModels.modeDefaults?.[id], options.defaults) ?? defaults.activeModelId,
      ])),
      subagentModels: Object.fromEntries(CANONICAL_AGENT_IDS.map(id => [
        id,
        options.defaults.models.roles[id].gatewayModelId,
      ])),
      observerModelOverride: resolvePersistedModelId(existingModels.observerModelOverride, options.defaults) ?? defaults.observerModelId,
      reflectorModelOverride: resolvePersistedModelId(existingModels.reflectorModelOverride, options.defaults) ?? defaults.reflectorModelId,
      omObservationThreshold: existingModels.omObservationThreshold ?? defaults.observationThreshold,
      omReflectionThreshold: existingModels.omReflectionThreshold ?? defaults.reflectionThreshold,
    },
    preferences: {
      ...existingPreferences,
      ...(!Object.hasOwn(existingPreferences, "yolo") ? { yolo: false } : {}),
      ...(!Object.hasOwn(existingPreferences, "thinkingLevel") ? { thinkingLevel: "off" } : {}),
    },
    ...(options.provider ? {
      customProviders: [
        ...(existing.customProviders ?? []).filter(provider => provider.name !== A1_CODE_PROVIDER_NAME),
        {
          name: A1_CODE_PROVIDER_NAME,
          url: options.provider.baseUrl,
          models: [...options.provider.models],
        },
      ],
    } : {}),
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

export function createA1CodeProvider(options: A1ProviderOptions): MastraCodeCustomProvider {
  return {
    // The matching name keeps the Code gateway catalog on the resolvable
    // `a1-proxy/<alias>` namespace instead of adding a MastraCode prefix.
    name: A1_CODE_PROVIDER_NAME,
    url: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    models: [...options.models],
  };
}

export function createA1MastraCodeGateway(options: A1ProviderOptions) {
  return createMastraCodeGateway({
    mastraGatewayBaseUrl: options.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""),
    routeThroughMastraGateway: false,
    customProviders: [createA1CodeProvider(options)],
  });
}

function resolvePersistedModelId(
  modelId: string | null | undefined,
  defaults: RuntimeDefaultsV1,
): string | undefined {
  if (!modelId) return undefined;
  const prefix = `${A1_CODE_PROVIDER_ID}/`;
  if (!modelId.startsWith(prefix)) {
    throw new Error(`Persisted model must use a stable A1 model alias: ${modelId}`);
  }
  const alias = modelId.slice(prefix.length);
  if (!defaults.models.aliases.includes(alias)) {
    throw new Error(`Persisted model must use a stable A1 model alias: ${modelId}`);
  }
  return modelId;
}

async function readSettings(settingsPath: string): Promise<SettingsDocument> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as SettingsDocument;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Mastra Code SDK settings: ${settingsPath}`, { cause: error });
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export interface McodeRuntimeOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly config?: McodeConfig;
  readonly profile?: ModelProfile;
  readonly dataDirectory?: string;
  readonly host?: "mcode" | "studio";
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
    host: options.host ?? "mcode",
    environment,
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
        let cleanupError: unknown;
        try {
          if (resources) await resources.close();
          else await mcp.close();
        } catch (caught) {
          cleanupError = caught;
        }
        setCustomProvidersSource(undefined);
        if (cleanupError !== undefined) {
          throw new AggregateError([error, cleanupError], "MCode runtime initialization and cleanup failed");
        }
        throw error;
      }

      let closePromise: Promise<void> | undefined;
      return {
        project,
        config,
        agents,
        mastra,
        controller: controllerMount.base.controller,
        code: controllerMount.base,
        resources,
        async close(): Promise<void> {
          closePromise ??= closeMountedRuntime(
            mastra,
            resources!,
            controllerMount.base,
          );
          await closePromise;
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

async function closeMountedRuntime(
  mastra: Mastra,
  resources: ProjectMountingManager,
  code: MastraCodeAgentController,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await resources.close();
  } catch (error) {
    failures.push(error);
  }
  const results = await Promise.allSettled([
    code.controller.stopIntervals(),
    closePubSub(code.signalsPubSub),
    mastra.shutdown(),
  ]);
  setCustomProvidersSource(undefined);
  for (const result of results) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0) throw new AggregateError(failures, "MCode runtime shutdown failed");
}

export interface LocalMcodeRuntime extends MountedMcodeRuntime {
  readonly session: Session<MastraCodeState>;
  runTui(): Promise<void>;
}

export async function createLocalMcodeRuntime(
  options: McodeRuntimeOptions = {},
): Promise<LocalMcodeRuntime> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const project = detectProject(cwd);
  const profile = options.profile ?? loadModelProfile();
  const config = options.config ?? loadMcodeConfig(
    { ...(options.environment ?? process.env), WORKSPACE_ROOT: project.rootPath },
    project.rootPath,
    profile,
  );
  const mounted = await mountMcodeRuntime({ ...options, cwd, profile, config });
  const session = await mounted.controller.createSession({
    id: localSessionId(mounted.project.rootPath),
    ownerId: mounted.code.ownerId,
    resourceId: mounted.project.resourceId,
    scope: mounted.project.rootPath,
    tags: { projectPath: mounted.project.rootPath },
  });
  await wireSessionConcerns(mounted.code, session);

  let tui: MastraTUI | undefined;
  let closed = false;
  return {
    ...mounted,
    session,
    async runTui(): Promise<void> {
      tui ??= new MastraTUI({
        controller: mounted.controller,
        session,
        ...(mounted.code.hookManager ? { hookManager: mounted.code.hookManager } : {}),
        ...(mounted.code.authStorage ? { authStorage: mounted.code.authStorage } : {}),
        ...(mounted.code.mcpManager ? { mcpManager: mounted.code.mcpManager } : {}),
        ...(mounted.code.pluginManager ? { pluginManager: mounted.code.pluginManager } : {}),
        ...(mounted.code.storageMaintenance ? { storageMaintenance: mounted.code.storageMaintenance } : {}),
        ...(mounted.code.githubSignals ? { githubSignals: mounted.code.githubSignals } : {}),
        appName: "RLabs MCode",
        inlineQuestions: true,
      });
      await tui.run();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      tui?.stop();
      releaseAllThreadLocks();
      await mounted.close();
    },
  };
}

function localSessionId(projectRoot: string): string {
  const rootHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return `mcode-local-${rootHash}`;
}
