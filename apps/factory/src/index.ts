import { Mastra } from "@mastra/core/mastra";
import { createToolkitFactory, loadFactoryConfig } from "@rlabs/factory-integration";
import { createMcodeRecipe } from "@rlabs/mcode";
import { loadModelProfile, ProxyGateway } from "@rlabs/runtime-config";
import { createSandboxCommandRunTool } from "@rlabs/sandbox";

const profile = loadModelProfile();
export const config = loadFactoryConfig(process.env, process.cwd(), profile);
const recipe = createMcodeRecipe({
  profile,
  commandRun: createSandboxCommandRunTool(),
  browser: false,
});
export const factory = await createToolkitFactory(config, recipe);
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
