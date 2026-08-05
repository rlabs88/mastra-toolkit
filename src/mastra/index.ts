import { Mastra } from "@mastra/core/mastra";
import { createToolkitAgents } from "../agents/index.js";
import { loadToolkitConfig } from "../config.js";
import { createToolkitFactory } from "../factory/create.js";
import { ProxyGateway } from "../models/proxy-gateway.js";
import { prepareLocalProjectRuntime } from "../runtime/project.js";
import { createToolkitWorkspace } from "../runtime/workspace.js";

export const config = loadToolkitConfig();
const factoryAgents = config.mode === "factory" ? createToolkitAgents({
  workspaceRoot: config.sandbox.workspaceRoot,
  browser: true,
  ...(config.browser.executablePath ? { browserExecutablePath: config.browser.executablePath } : {}),
  ...(config.browser.userDataDir ? { browserUserDataDir: config.browser.userDataDir } : {}),
}) : undefined;
export const factory = factoryAgents ? await createToolkitFactory(config, factoryAgents) : undefined;
export const localProject = factory ? undefined : await prepareLocalProjectRuntime({ config, cwd: process.cwd() });
export const agents = factoryAgents ?? localProject!.agents;
const prepared = factory ? await factory.prepare() : localProject!.mastraArgs;

export const mastra = new Mastra({
  ...prepared,
  ...(factory ? {
    agents: { ...(prepared.agents ?? {}), ...agents },
    gateways: { ...(prepared.gateways ?? {}), proxy: new ProxyGateway(config.proxy) },
    workspace: createToolkitWorkspace(config),
  } : {}),
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

if (factory) await factory.finalize();
else await localProject!.finalize(mastra);
