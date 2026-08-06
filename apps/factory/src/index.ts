import { Mastra } from "@mastra/core/mastra";
import {
  createFactoryMcodeRecipe,
  createToolkitFactory,
  loadFactoryConfig,
} from "@rlabs/factory-integration";
import { loadModelProfile, ProxyGateway } from "@rlabs/runtime-config";

const profile = loadModelProfile();
export const config = loadFactoryConfig(process.env, process.cwd(), profile);
const recipe = createFactoryMcodeRecipe({
  profile,
  browser: false,
});
export const factory = await createToolkitFactory(config, recipe);
const prepared = await factory.prepare();
export const mastra = new Mastra({
  ...prepared,
  gateways: {
    ...(prepared.gateways ?? {}),
    proxy: new ProxyGateway({ ...config.runtime.proxy, models: profile.aliases }),
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

const stopFactory = () => {
  void factory.shutdown().catch(error => {
    console.error("Factory shutdown failed", error);
  });
};
process.once("SIGINT", stopFactory);
process.once("SIGTERM", stopFactory);
