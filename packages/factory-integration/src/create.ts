import type { FactoryStorage } from "@mastra/core/storage";
import { MastraFactory, type MastraArgs, type MastraFactoryConfig } from "@mastra/factory";
import { GithubIntegration } from "@mastra/factory/integrations/github/integration";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import type { ToolkitAgents } from "@rlabs/agents-roles";
import { prepareCodeSdkSettings, type A1ProviderOptions } from "@rlabs/mcode";
import { loadModelProfile } from "@rlabs/runtime-config";
import { createSandboxMachine } from "@rlabs/sandbox";
import { createFactoryAuth } from "./auth.js";
import type { FactoryConfig } from "./config.js";
import { prepareLocalA1Provider } from "./local-provider.js";
import { createFactoryStorage } from "./storage.js";
import { ToolkitFactoryIntegration } from "./toolkit-integration.js";

export async function createToolkitFactory(config: FactoryConfig, agents: ToolkitAgents): Promise<MastraFactory> {
  const profile = loadModelProfile();
  const provider = {
    baseUrl: config.runtime.proxy.baseUrl,
    models: profile.aliases,
    ...(config.runtime.proxy.apiKey ? { apiKey: config.runtime.proxy.apiKey } : {}),
  } satisfies A1ProviderOptions;
  await prepareCodeSdkSettings({ profile });
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
    integrations: [new ToolkitFactoryIntegration(agents), ...(github ? [github] : [])],
    ...(config.sandbox ? {
      sandbox: {
        machine: createSandboxMachine({
          provider: config.sandbox.provider,
          workspaceRoot: config.sandbox.workspaceRoot,
          specification: config.sandbox.specification,
          ...(config.sandbox.platform ? { platform: config.sandbox.platform } : {}),
        }),
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
  );
}

class ToolkitMastraFactory extends MastraFactory {
  constructor(
    config: MastraFactoryConfig,
    private readonly factoryStorage: FactoryStorage,
    private readonly localA1Provider?: A1ProviderOptions,
  ) {
    super(config);
  }

  override async prepare(): Promise<MastraArgs> {
    const prepared = await super.prepare();
    if (this.localA1Provider) {
      await prepareLocalA1Provider(this.factoryStorage, this.localA1Provider);
    }
    return prepared;
  }
}
