import { Mastra } from "@mastra/core/mastra";
import {
  createFactoryAgentBundle,
  createToolkitFactory,
  loadFactoryConfig,
} from "@rlabs/factory-integration";
import { loadModelProfile, ProxyGateway, resolveRuntimeDefaultsV1 } from "@rlabs/runtime-config";

const profile = loadModelProfile();
const runtimeDefaults = resolveRuntimeDefaultsV1(profile);
export const config = loadFactoryConfig(process.env, process.cwd(), profile);
const agents = createFactoryAgentBundle({
  profile,
  browser: false,
});
export const factory = await createToolkitFactory(config, agents, runtimeDefaults);
const prepared = await factory.prepare();
export const mastra = new Mastra({
  ...prepared,
  gateways: {
    ...(prepared.gateways ?? {}),
    proxy: new ProxyGateway({ ...config.runtime.proxy, models: runtimeDefaults.gateway.models }),
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

let shutdown: Promise<void> | undefined;
export const stopFactory = async () => {
  shutdown ??= (async () => {
    const failures: unknown[] = [];
    try {
      await factory.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await mastra.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "Factory shutdown failed");
  })();
  await shutdown;
};
const handleStopSignal = () => {
  void stopFactory().catch(error => {
    console.error("Factory shutdown failed", error);
    process.exitCode = 1;
  });
};
process.once("SIGINT", handleStopSignal);
process.once("SIGTERM", handleStopSignal);
