import { Mastra } from "@mastra/core/mastra";
import { createToolkitAgents } from "@rlabs/agents-roles";
import { createToolkitFactory, loadFactoryConfig } from "@rlabs/factory-integration";
import { ProxyGateway } from "@rlabs/runtime-config";

export const config = loadFactoryConfig();
const agents = createToolkitAgents({
  workspaceRoot: config.sandbox?.workspaceRoot ?? process.cwd(),
  browser: true,
});
export const factory = await createToolkitFactory(config, agents);
const prepared = await factory.prepare();
export const mastra = new Mastra({
  ...prepared,
  gateways: {
    ...(prepared.gateways ?? {}),
    proxy: new ProxyGateway(config.runtime.proxy),
  },
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

await factory.finalize();
