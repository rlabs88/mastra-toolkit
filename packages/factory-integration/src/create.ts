import { mkdir } from "node:fs/promises";
import type { FactoryStorage } from "@mastra/core/storage";
import { MastraFactory, type MastraArgs, type MastraFactoryConfig } from "@mastra/factory";
import { GithubIntegration } from "@mastra/factory/integrations/github/integration";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import { prepareHostDataDirectory, type RuntimeDefaultsV1 } from "@rlabs/runtime-config";
import {
  createSandboxMachine,
  type CloneableSandboxMachine,
  type SandboxMachineOptions,
} from "@rlabs/sandbox";
import { createFactoryAuth } from "./auth.js";
import type { FactoryConfig } from "./config.js";
import { prepareLocalA1Provider } from "./local-provider.js";
import { createFactoryStorage } from "./storage.js";
import { ToolkitFactoryIntegration, type FactoryAgentBundle } from "./toolkit-integration.js";

interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export async function createToolkitFactory(
  config: FactoryConfig,
  bundle: FactoryAgentBundle,
  defaults: RuntimeDefaultsV1,
): Promise<MastraFactory> {
  const provider = {
    baseUrl: config.runtime.proxy.baseUrl,
    models: defaults.gateway.models,
    ...(config.runtime.proxy.apiKey ? { apiKey: config.runtime.proxy.apiKey } : {}),
  } satisfies A1ProviderOptions;
  const hostData = await prepareHostDataDirectory("factory");
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
  const auth = createFactoryAuth(config.workos, process.env.NODE_ENV, config.server);
  const stateSecret = config.github?.GITHUB_APP_WEBHOOK_SECRET ?? config.workos?.cookiePassword;
  const factoryConfig: MastraFactoryConfig = {
    auth,
    storage: factoryStorage,
    ...(vector ? { vector } : {}),
    ...(config.redisUrl ? { pubsub: new RedisStreamsPubSub({ url: config.redisUrl }) } : {}),
    integrations: [new ToolkitFactoryIntegration(bundle, defaults), ...(github ? [github] : [])],
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
    bundle.agents,
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
    private readonly toolkitAgents: FactoryAgentBundle["agents"],
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
