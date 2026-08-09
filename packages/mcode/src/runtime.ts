import { createCodeMcpAdapter, createMcodeWorkspace, MastraProjectHostRegistry, ProfileModelAliasResolver, StaticToolSnapshot } from "./project.js";
import {
  createBackgroundTaskTelemetryTerminal,
  startDynamicWorkflowBackgroundTaskObserver,
} from "./background-task-observer.js";
import { startForegroundToolFeedbackObserver } from "./tool-feedback-observer.js";
import {
  CANONICAL_AGENT_IDS,
  CODE_MODE_IDS,
  createMcodeControllerProjection,
  createStudioControllerProjection,
  fillMissingSubagentModelId,
  RESERVED_HOST_TOOL_IDS,
  SPECIALIST_TOOL_ALIASES,
  type McodeControllerProjection,
} from "./recipe.js";
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
import { RequestContext } from "@mastra/core/request-context";
import type { ToolkitAdditionalTools, ToolkitAgents } from "@rlabs/agents-roles";
import {
  createToolkitRuntimeContract,
  type ToolkitRuntimeBinding,
  type ToolkitRuntimeContract,
} from "@rlabs/mastra-primitives-export";
import { type McpLifecyclePort, type PreparedMcpGeneration, type ProjectMountingDiagnostic, ProjectMountingManager } from "@rlabs/project-mounting-manager";
import { A1_PROXY_PROVIDER_ID, A1_PROXY_PROVIDER_NAME, getA1ProxyModelId, HOST_BACKGROUND_TASK_POLICY, loadModelProfile, loadRuntimeConfig, type ModelProfile, prepareHostDataDirectory, ProxyGateway, type RuntimeConfig, type RuntimeDefaultsV1, type ToolkitHostId } from "@rlabs/runtime-config";
import { loadSandboxConfig, type SandboxConfig } from "@rlabs/sandbox";
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
        preserveExplicitModelId(existingModels.subagentModels?.[id])
          ?? options.defaults.models.roles[id].gatewayModelId,
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

function preserveExplicitModelId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
  readonly contract: ToolkitRuntimeContract;
  readonly projection: McodeControllerProjection;
  readonly mastraArgs: NonNullable<ConstructorParameters<typeof Mastra>[0]>;
  abort(): Promise<void>;
  finalize(mastra: Mastra): Promise<MountedMcodeRuntime>;
}

export interface MountedMcodeRuntime {
  readonly project: ProjectInfo;
  readonly config: McodeConfig;
  readonly agents: ToolkitAgents;
  readonly contract: ToolkitRuntimeContract;
  readonly projection: McodeControllerProjection;
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
  const config = freezeSnapshot(
    options.config ?? loadMcodeConfig(environment, project.rootPath, profile),
  );
  const workspace = createMcodeWorkspace(config.sandbox, {
    projectRoot: project.rootPath,
    hotReloadSkills: true,
  });
  const contract = createToolkitRuntimeContract({
    profile,
    providerBaseUrl: config.runtime.proxy.baseUrl,
  });
  const contractProfile = contract.runtime.profile;
  const runtimeDefaults = contract.runtime.defaults;
  const binding = {
    identity: {
      projectId: project.rootPath,
      userId: "local-user",
      sessionId: `${options.host ?? "mcode"}-runtime`,
    },
    workspace: { resolve: () => workspace },
    sandbox: { resolve: () => workspace.resolveSandbox({ requestContext: new RequestContext() }) },
    approval: { context: { host: options.host ?? "mcode" } },
  } satisfies ToolkitRuntimeBinding<typeof workspace, Awaited<ReturnType<typeof workspace.resolveSandbox>>>;
  let resources: ProjectMountingManager | undefined;
  // No reserved-id filter here on purpose: `reservedToolIds` keeps those ids
  // out of the published map at the manager's merge, upstream of both this
  // bridge and the project specialists. A second filter here would only be
  // reachable if that reservation were dropped, and it would then hide the
  // regression from role agents while specialists stayed exposed — the exact
  // asymmetry that produced the original leak.
  const dynamicTools = createDynamicTools(undefined, () =>
    (resources?.getTools() ?? {}) as Record<string, ToolLike>,
  ) as ToolkitAdditionalTools;
  const createProjection = options.host === "studio"
    ? createStudioControllerProjection
    : createMcodeControllerProjection;
  const projection = createProjection(contract, binding, {
    browser: options.browser ?? true,
    additionalTools: dynamicTools,
    hooks: { beforeToolCall: ({ input }) => fillMissingSubagentModelId(contractProfile, input) },
    ...(config.browser.executablePath ? { browserExecutablePath: config.browser.executablePath } : {}),
    ...(config.browser.userDataDir ? { browserUserDataDir: config.browser.userDataDir } : {}),
  });
  const agents = projection.agents;
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
      modes: projection.controller.modes,
      subagents: projection.controller.subagents,
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
    backgroundTasks: HOST_BACKGROUND_TASK_POLICY,
  };
  let claimed = false;

  return {
    project,
    config,
    agents,
    contract,
    projection,
    mastraArgs,
    async abort(): Promise<void> {
      if (claimed) return;
      claimed = true;
      const failures = await cleanupPreparedMcodeStartup(controllerMount.base);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Prepared MCode runtime cleanup failed");
      }
    },
    async finalize(mastra: Mastra): Promise<MountedMcodeRuntime> {
      if (claimed) throw new Error("Prepared MCode runtime has already been consumed");
      claimed = true;
      const mcp = options.mcp
        ?? (options.disableMcp ? new EmptyMcpLifecycle() : createCodeMcpAdapter(project.rootPath));
      try {
        // A crash between the create and archive writes can leave a
        // model-authored definition active, and only active rows load at
        // startWorkers(). Archive them before anything can mount them.
        await contract.tools.reconcileDynamicWorkflowDefinitions(mastra);
        resources = await ProjectMountingManager.create({
          projectRoot: project.rootPath,
          modelAliases: new ProfileModelAliasResolver(contractProfile),
          mcp,
          // Reported, not published. The manager claims these ids into its
          // collision set before merging any snapshot, so a project workflow or
          // MCP server that would shadow a host tool is still rejected, while
          // the reserved tool itself never becomes publishable. Passing the
          // live tool through `currentTools` as well would collide with this
          // reservation and fail the mount.
          reservedToolIds: RESERVED_HOST_TOOL_IDS,
          specialistToolAliases: SPECIALIST_TOOL_ALIASES,
          currentTools: new StaticToolSnapshot({}),
          host: new MastraProjectHostRegistry(mastra),
          workspace,
          ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
        });
        await controllerMount.finalize();
        if (options.watch ?? true) resources.startWatching();
      } catch (error) {
        const cleanupFailures = await cleanupFailedMcodeStartup(
          mastra,
          resources,
          mcp,
          controllerMount.base,
        );
        if (cleanupFailures.length > 0) {
          throw new AggregateError([error, ...cleanupFailures], "MCode runtime initialization and cleanup failed");
        }
        throw error;
      }

      let closePromise: Promise<void> | undefined;
      return {
        project,
        config,
        agents,
        contract,
        projection,
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
  let mastra: Mastra;
  try {
    mastra = new Mastra(prepared.mastraArgs);
  } catch (error) {
    try {
      await prepared.abort();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MCode construction and cleanup failed");
    }
    throw error;
  }
  return prepared.finalize(mastra);
}

async function cleanupPreparedMcodeStartup(code: MastraCodeAgentController): Promise<unknown[]> {
  const results = await Promise.allSettled([
    code.controller.stopIntervals(),
    closePubSub(code.signalsPubSub),
  ]);
  setCustomProvidersSource(undefined);
  return results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
}

async function cleanupFailedMcodeStartup(
  mastra: Mastra,
  resources: ProjectMountingManager | undefined,
  mcp: McpLifecyclePort,
  code: MastraCodeAgentController,
): Promise<unknown[]> {
  const tasks = [
    resources ? resources.close() : mcp.close(),
    code.controller.stopIntervals(),
    closePubSub(code.signalsPubSub),
    mastra.shutdown(),
  ];
  const results = await Promise.allSettled(tasks);
  setCustomProvidersSource(undefined);
  return results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
}

function freezeSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== "object" || Object.isFrozen(current)) return;
    for (const nested of Object.values(current as Record<string, unknown>)) freeze(nested);
    Object.freeze(current);
  };
  freeze(snapshot);
  return snapshot;
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
  let session: Session<MastraCodeState>;
  try {
    session = await mounted.controller.createSession({
      id: localSessionId(mounted.project.rootPath),
      ownerId: mounted.code.ownerId,
      resourceId: mounted.project.resourceId,
      scope: mounted.project.rootPath,
      tags: { projectPath: mounted.project.rootPath },
    });
    await wireSessionConcerns(mounted.code, session);
    restrictSessionModelSelection(session, mounted.contract.runtime.profile);
  } catch (error) {
    try {
      await mounted.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MCode session startup and cleanup failed");
    }
    throw error;
  }

  const backgroundTaskObserver = startDynamicWorkflowBackgroundTaskObserver({
    manager: mounted.mastra.backgroundTaskManager,
    resourceId: session.identity.getResourceId(),
    waitForActivation: true,
    emit: event => session.emit(event),
  });
  const toolFeedbackObserver = startForegroundToolFeedbackObserver({
    session,
    emit: event => session.emit(event),
  });
  const observedController = new Proxy(mounted.controller, {
    get(target, property) {
      if (property === "listAvailableModels") {
        return async () => (await target.listAvailableModels())
          .filter(model => isDeclaredGatewayModelId(model.id, mounted.contract.runtime.profile))
          .map(model => ({ ...model, id: model.id.slice("mastracode/".length) }));
      }
      if (property === "setResourceId") {
        return async (
          targetSession: Session<MastraCodeState>,
          input: { resourceId: string },
        ): Promise<void> => {
          if (targetSession !== session) {
            await target.setResourceId(targetSession, input);
            return;
          }
          await backgroundTaskObserver.rebind(
            input.resourceId,
            () => target.setResourceId(targetSession, input),
          );
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  let tui: MastraTUI | undefined;
  let localClosePromise: Promise<void> | undefined;
  const closeRuntime = async () => {
    localClosePromise ??= (async () => {
      await toolFeedbackObserver.close();
      await backgroundTaskObserver.close();
      tui?.stop();
      releaseAllThreadLocks();
      await mounted.close();
    })();
    await localClosePromise;
  };
  return {
    ...mounted,
    controller: observedController,
    session,
    async runTui(): Promise<void> {
      tui ??= new MastraTUI({
        controller: observedController,
        session,
        ...(mounted.code.hookManager ? { hookManager: mounted.code.hookManager } : {}),
        ...(mounted.code.authStorage ? { authStorage: mounted.code.authStorage } : {}),
        ...(mounted.code.mcpManager ? { mcpManager: mounted.code.mcpManager } : {}),
        ...(mounted.code.pluginManager ? { pluginManager: mounted.code.pluginManager } : {}),
        ...(mounted.code.storageMaintenance ? { storageMaintenance: mounted.code.storageMaintenance } : {}),
        ...(mounted.code.githubSignals ? { githubSignals: mounted.code.githubSignals } : {}),
        appName: "RLabs MCode",
        inlineQuestions: true,
        terminal: createBackgroundTaskTelemetryTerminal(() => backgroundTaskObserver.activate()),
      });
      const originalExit = process.exit;
      let exitStarted = false;
      const interceptedExit = ((code?: string | number | null) => {
        if (!exitStarted) {
          exitStarted = true;
          void closeRuntime().then(
            () => originalExit.call(process, code),
            error => {
              console.error(error);
              originalExit.call(process, 1);
            },
          );
        }
        return undefined as never;
      }) as typeof process.exit;
      process.exit = interceptedExit;
      try {
        await tui.run();
      } finally {
        if (process.exit === interceptedExit) process.exit = originalExit;
      }
    },
    async close(): Promise<void> {
      await closeRuntime();
    },
  };
}

function restrictSessionModelSelection(session: Session<MastraCodeState>, profile: ModelProfile): void {
  const model = session.model as unknown as {
    switch(input: { modelId: string; scope?: "global" | "thread"; modeId?: string }): Promise<void>;
  };
  const switchModel = model.switch.bind(model);
  model.switch = async input => {
    if (!isDeclaredA1ModelId(input.modelId, profile)) {
      throw new Error(`Selected model must use a declared A1 model alias: ${input.modelId}`);
    }
    await switchModel(input);
  };
}

function isDeclaredA1ModelId(modelId: string, profile: ModelProfile): boolean {
  const prefix = `${A1_CODE_PROVIDER_ID}/`;
  return modelId.startsWith(prefix) && profile.aliases.includes(modelId.slice(prefix.length));
}

function isDeclaredGatewayModelId(modelId: string, profile: ModelProfile): boolean {
  return modelId.startsWith("mastracode/") && isDeclaredA1ModelId(
    modelId.slice("mastracode/".length),
    profile,
  );
}

function localSessionId(projectRoot: string): string {
  const rootHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return `mcode-local-${rootHash}`;
}
