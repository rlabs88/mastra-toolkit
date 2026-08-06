import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryStorage } from "@mastra/core/storage";
import { MastraFactory, type MastraArgs, type MastraFactoryConfig } from "@mastra/factory";
import { GithubIntegration } from "@mastra/factory/integrations/github/integration";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import {
  prepareCodeSdkSettings,
  type A1ProviderOptions,
  type McodeRecipeV1,
} from "@rlabs/mcode";
import {
  createSandboxMachine,
  type CloneableSandboxMachine,
  type SandboxMachineOptions,
} from "@rlabs/sandbox";
import { createFactoryAuth } from "./auth.js";
import type { FactoryConfig } from "./config.js";
import { prepareLocalA1Provider } from "./local-provider.js";
import { createFactoryStorage } from "./storage.js";
import { ToolkitFactoryIntegration } from "./toolkit-integration.js";

export async function createToolkitFactory(config: FactoryConfig, recipe: McodeRecipeV1): Promise<MastraFactory> {
  const profile = recipe.settings.profile;
  const provider = {
    baseUrl: config.runtime.proxy.baseUrl,
    models: profile.aliases,
    ...(config.runtime.proxy.apiKey ? { apiKey: config.runtime.proxy.apiKey } : {}),
  } satisfies A1ProviderOptions;
  const dataDirectory = await prepareCodeSdkSettings({ profile });
  const controlPlaneDirectory = join(dataDirectory, "factory-control-plane");
  await mkdir(controlPlaneDirectory, { recursive: true, mode: 0o700 });
  const { factoryStorage, vector } = createFactoryStorage(config.databaseUrl);
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
    integrations: [new ToolkitFactoryIntegration(recipe), ...(github ? [github] : [])],
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
    config.workos ? undefined : provider,
    controlPlaneDirectory,
    !config.workos,
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
    private readonly localA1Provider?: A1ProviderOptions,
    private readonly controlPlaneDirectory?: string,
    private readonly loopbackOnly = false,
  ) {
    super(config);
  }

  override async prepare(): Promise<MastraArgs> {
    const prepared = await withWorkingDirectory(
      this.controlPlaneDirectory ?? process.cwd(),
      () => super.prepare(),
    );
    if (this.localA1Provider) {
      await prepareLocalA1Provider(this.factoryStorage, this.localA1Provider);
    }
    return this.loopbackOnly
      ? { ...prepared, server: { ...prepared.server, host: "127.0.0.1" } }
      : prepared;
  }
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
