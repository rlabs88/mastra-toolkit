import { mkdir } from "node:fs/promises";
import type { FactoryStorage } from "@mastra/core/storage";
import { MastraFactory, type MastraArgs, type MastraFactoryConfig } from "@mastra/factory";
import { GithubIntegration } from "@mastra/factory/integrations/github/integration";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import { HOST_BACKGROUND_TASK_POLICY, loadModelProfile, prepareHostDataDirectory, ProxyGateway, type RuntimeDefaultsV1 } from "@rlabs/runtime-config";
import {
  createToolkitRuntimeContract,
  type ToolkitRuntimeContract,
} from "@rlabs/mastra-primitives-export";
import {
  createSandboxMachine,
  type CloneableSandboxMachine,
  type SandboxMachineOptions,
} from "@rlabs/sandbox";
import { Mastra } from "@mastra/core/mastra";
import { createFactoryAuth, createFactoryStorage, loadFactoryConfig, prepareLocalA1Provider, type FactoryConfig } from "./config.js";
import {
  createFactoryControllerProjection,
  createFactoryRuntimeBinding,
  ToolkitFactoryIntegration,
  type FactoryControllerProjection,
} from "./integration.js";

interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export async function createToolkitFactory(
  config: FactoryConfig,
  projection: FactoryControllerProjection,
  defaults: RuntimeDefaultsV1,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MastraFactory> {
  config = freezeSnapshot(config);
  defaults = projection.runtime.defaults;
  const provider = {
    baseUrl: config.runtime.proxy.baseUrl,
    models: defaults.gateway.models,
    ...(config.runtime.proxy.apiKey ? { apiKey: config.runtime.proxy.apiKey } : {}),
  } satisfies A1ProviderOptions;
  const hostData = await prepareHostDataDirectory("factory", environment);
  const controlPlaneDirectory = hostData.controlPlaneDirectory!;
  await mkdir(controlPlaneDirectory, { recursive: true, mode: 0o700 });
  const { factoryStorage, vector } = createFactoryStorage(config.databaseUrl, hostData.databasePath);
  const github = config.github ? new GithubIntegration({
    appId: config.github.GITHUB_APP_ID,
    privateKey: config.github.GITHUB_APP_PRIVATE_KEY,
    clientId: config.github.GITHUB_APP_CLIENT_ID,
    clientSecret: config.github.GITHUB_APP_CLIENT_SECRET,
    slug: config.github.GITHUB_APP_SLUG,
    ...(config.github.GITHUB_APP_WEBHOOK_SECRET
      ? { webhookSecret: config.github.GITHUB_APP_WEBHOOK_SECRET }
      : {}),
  }) : undefined;
  const auth = createFactoryAuth(config.workos, environment.NODE_ENV, config.server);
  const stateSecret = config.github?.GITHUB_APP_WEBHOOK_SECRET ?? config.workos?.cookiePassword;
  const factoryConfig: MastraFactoryConfig = {
    auth,
    storage: factoryStorage,
    ...(vector ? { vector } : {}),
    ...(config.redisUrl ? { pubsub: new RedisStreamsPubSub({ url: config.redisUrl }) } : {}),
    integrations: [new ToolkitFactoryIntegration(projection, defaults), ...(github ? [github] : [])],
    ...(config.sandbox ? {
      sandbox: {
        machine: createFactorySandboxMachine(config),
        workdir: config.sandbox.provider === "local"
          ? config.sandbox.workspaceRoot
          : config.sandbox.workdir,
        maxSandboxes: config.sandbox.maxSandboxes,
      },
    } : {}),
    publicUrl: config.server.publicUrl,
    allowedOrigins: [...config.server.allowedOrigins],
    ...(stateSecret ? { stateSecret } : {}),
  };
  return new ToolkitMastraFactory(
    factoryConfig,
    factoryStorage,
    projection.agents,
    config.workos ? undefined : { provider, defaults },
    controlPlaneDirectory,
    config.workos ? undefined : loopbackServerHost(config.server.publicUrl),
  );
}

export function createFactorySandboxMachine(
  config: FactoryConfig,
  machineFactory: (options: SandboxMachineOptions) => CloneableSandboxMachine = createSandboxMachine,
): CloneableSandboxMachine {
  if (!config.sandbox) throw new Error("Factory repository execution has no configured sandbox machine");
  return machineFactory({
    provider: config.sandbox.provider,
    workspaceRoot: config.sandbox.workspaceRoot,
    specification: config.sandbox.specification,
    runtimeProfile: config.projectRuntime.profile,
    ...(config.sandbox.runtimeImage ? { runtimeImage: config.sandbox.runtimeImage } : {}),
    ...(config.sandbox.platform ? { platform: config.sandbox.platform } : {}),
  });
}

class ToolkitMastraFactory extends MastraFactory {
  constructor(
    config: MastraFactoryConfig,
    private readonly factoryStorage: FactoryStorage,
    private readonly toolkitAgents: FactoryControllerProjection["agents"],
    private readonly localA1?: { provider: A1ProviderOptions; defaults: RuntimeDefaultsV1 },
    private readonly controlPlaneDirectory?: string,
    private readonly localServerHost?: string,
  ) {
    super(config);
  }

  override async prepare(): Promise<MastraArgs> {
    const prepared = await withWorkingDirectory(
      this.controlPlaneDirectory ?? process.cwd(),
      () => super.prepare(),
    );
    if (this.localA1) {
      await prepareLocalA1Provider(this.factoryStorage, this.localA1.provider, this.localA1.defaults);
    }
    return {
      ...prepared,
      agents: { ...(prepared.agents ?? {}), ...this.toolkitAgents },
      ...(this.localServerHost
        ? { server: { ...prepared.server, host: this.localServerHost } }
        : {}),
    };
  }
}

function loopbackServerHost(publicUrl: string): string {
  return new URL(publicUrl).hostname.replace(/^\[|\]$/g, "");
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

let workingDirectoryQueue: Promise<void> = Promise.resolve();

function withWorkingDirectory<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const result = workingDirectoryQueue.then(async () => {
    const previous = process.cwd();
    process.chdir(directory);
    try {
      return await operation();
    } finally {
      process.chdir(previous);
    }
  });
  workingDirectoryQueue = result.then(() => undefined, () => undefined);
  return result;
}


export interface FactoryRuntime {
  readonly config: FactoryConfig;
  readonly contract: ToolkitRuntimeContract;
  readonly projection: FactoryControllerProjection;
  readonly factory: MastraFactory;
  readonly mastra: Mastra;
  close(): Promise<void>;
}

export async function createFactoryRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
): Promise<FactoryRuntime> {
  const profile = loadModelProfile();
  const config = loadFactoryConfig(environment, startDirectory, profile);
  const contract = createToolkitRuntimeContract({
    profile,
    providerBaseUrl: config.runtime.proxy.baseUrl,
  });
  const defaults = contract.runtime.defaults;
  const projection = createFactoryControllerProjection(
    contract,
    createFactoryRuntimeBinding(),
    { browser: false },
  );
  const factory = await createToolkitFactory(config, projection, defaults, environment);
  let mastra: Mastra | undefined;
  try {
    const prepared = await factory.prepare();
    mastra = new Mastra({
      ...prepared,
      gateways: {
        ...(prepared.gateways ?? {}),
        proxy: new ProxyGateway({ ...config.runtime.proxy, models: defaults.gateway.models }),
      },
      backgroundTasks: HOST_BACKGROUND_TASK_POLICY,
    });
    await factory.finalize();
  } catch (error) {
    const cleanup = await settleFactoryRuntime(factory, mastra);
    if (cleanup.length > 0) {
      throw new AggregateError([error, ...cleanup], "Factory startup and cleanup failed");
    }
    throw error;
  }

  let closing: Promise<void> | undefined;
  const close = async () => {
    closing ??= closeFactoryRuntime(factory, mastra);
    await closing;
  };
  return { config, contract, projection, factory, mastra, close };
}

async function closeFactoryRuntime(factory: MastraFactory, mastra: Mastra): Promise<void> {
  const failures = await settleFactoryRuntime(factory, mastra);
  if (failures.length > 0) throw new AggregateError(failures, "Factory shutdown failed");
}

async function settleFactoryRuntime(factory: MastraFactory, mastra?: Mastra): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await factory.shutdown();
  } catch (error) {
    failures.push(error);
  }
  if (mastra) {
    try {
      await mastra.shutdown();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
