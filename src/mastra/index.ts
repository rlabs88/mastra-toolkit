import { Mastra } from "@mastra/core/mastra";
import { createToolkitAgents } from "../agents/index.js";
import { loadToolkitConfig } from "../config.js";
import { createToolkitFactory } from "../factory/create.js";
import { registerA1CodeSdkProvider } from "../factory/code-sdk.js";
import { ProxyGateway } from "../models/proxy-gateway.js";
import { createToolkitStorage } from "../runtime/storage.js";
import { createToolkitWorkspace } from "../runtime/workspace.js";

export const config = loadToolkitConfig();
export const agents = createToolkitAgents({
  workspaceRoot: config.sandbox.workspaceRoot,
  browser: true,
  ...(config.browser.executablePath ? { browserExecutablePath: config.browser.executablePath } : {}),
  ...(config.browser.userDataDir ? { browserUserDataDir: config.browser.userDataDir } : {}),
});
export const factory = config.mode === "factory" ? await createToolkitFactory(config, agents) : undefined;
const standalone = factory ? undefined : createToolkitStorage(config.databaseUrl);
const prepared = factory ? await factory.prepare() : {};
if (factory) {
  registerA1CodeSdkProvider({
    baseUrl: config.proxy.baseUrl,
    model: config.proxy.model.replace(/^openai\//, ""),
    ...(config.proxy.apiKey ? { apiKey: config.proxy.apiKey } : {}),
  });
}

export const mastra = new Mastra({
  ...prepared,
  agents: { ...(prepared.agents ?? {}), ...agents },
  gateways: { ...(prepared.gateways ?? {}), proxy: new ProxyGateway(config.proxy) },
  workspace: createToolkitWorkspace(config),
  ...(standalone ? { storage: standalone.storage } : {}),
  backgroundTasks: {
    enabled: true,
    mode: "full",
    globalConcurrency: 10,
    perAgentConcurrency: 4,
    backpressure: "queue",
    defaultTimeoutMs: 300_000,
    waitTimeoutMs: 30_000,
  },
});

await factory?.finalize();
