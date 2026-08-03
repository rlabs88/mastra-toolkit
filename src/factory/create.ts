import { MastraFactory } from "@mastra/factory";
import { GithubIntegration } from "@mastra/factory/integrations/github/integration";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import type { ToolkitAgents } from "../agents/index.js";
import type { ToolkitConfig } from "../config.js";
import { createSandboxMachine } from "../sandbox/index.js";
import { ToolkitFactoryIntegration } from "./toolkit-integration.js";
import { createToolkitStorage } from "../runtime/storage.js";
import { prepareCodeSdkSettings } from "./code-sdk.js";
import { createFactoryAuth } from "./auth.js";

export async function createToolkitFactory(config: ToolkitConfig, agents: ToolkitAgents): Promise<MastraFactory> {
  await prepareCodeSdkSettings({ model: config.proxy.model.replace(/^openai\//, "") });
  const { factoryStorage, vector } = createToolkitStorage(config.databaseUrl);
  const github = config.github ? new GithubIntegration({
    appId: config.github.GITHUB_APP_ID,
    privateKey: config.github.GITHUB_APP_PRIVATE_KEY,
    clientId: config.github.GITHUB_APP_CLIENT_ID,
    clientSecret: config.github.GITHUB_APP_CLIENT_SECRET,
    slug: config.github.GITHUB_APP_SLUG,
    ...(config.github.GITHUB_APP_WEBHOOK_SECRET ? { webhookSecret: config.github.GITHUB_APP_WEBHOOK_SECRET } : {}),
  }) : undefined;
  const auth = createFactoryAuth(config.workos);
  const stateSecret = config.github?.GITHUB_APP_WEBHOOK_SECRET ?? config.workos?.cookiePassword;

  return new MastraFactory({
    auth,
    storage: factoryStorage,
    ...(vector ? { vector } : {}),
    ...(config.redisUrl ? { pubsub: new RedisStreamsPubSub({ url: config.redisUrl }) } : {}),
    integrations: [new ToolkitFactoryIntegration(agents), ...(github ? [github] : [])],
    sandbox: {
      machine: createSandboxMachine({
        provider: config.sandbox.provider,
        workspaceRoot: config.sandbox.workspaceRoot,
        platform: config.platform,
        specification: config.sandbox.specification,
      }),
      workdir: config.sandbox.provider === "local" ? config.sandbox.workspaceRoot : config.sandbox.workdir,
      maxSandboxes: config.sandbox.maxSandboxes,
    },
    publicUrl: "http://localhost:4111",
    allowedOrigins: ["http://localhost:4111"],
    ...(stateSecret ? { stateSecret } : {}),
  });
}
