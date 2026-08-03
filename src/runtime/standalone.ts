import { Mastra } from "@mastra/core/mastra";
import { createToolkitAgents } from "../agents/index.js";
import type { ToolkitConfig } from "../config.js";
import { ProxyGateway } from "../models/proxy-gateway.js";
import { createToolkitStorage } from "./storage.js";
import { createToolkitWorkspace } from "./workspace.js";

export function createStandaloneRuntime(config: ToolkitConfig, options: { readonly browser?: boolean } = {}): Mastra {
  const agents = createToolkitAgents({
    workspaceRoot: config.sandbox.workspaceRoot,
    browser: options.browser ?? true,
    ...(config.browser.executablePath ? { browserExecutablePath: config.browser.executablePath } : {}),
    ...(config.browser.userDataDir ? { browserUserDataDir: config.browser.userDataDir } : {}),
  });
  const { storage } = createToolkitStorage(config.databaseUrl);
  return new Mastra({
    agents: { ...agents },
    gateways: { proxy: new ProxyGateway(config.proxy) },
    workspace: createToolkitWorkspace(config),
    storage,
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
}
