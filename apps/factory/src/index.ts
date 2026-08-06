import { createFactoryRuntime } from "@rlabs/factory-integration";

export const runtime = await createFactoryRuntime();
export const { config, factory, mastra } = runtime;
export const stopFactory = () => runtime.close();
const handleStopSignal = () => {
  void stopFactory().catch(error => {
    console.error("Factory shutdown failed", error);
    process.exitCode = 1;
  });
};
process.once("SIGINT", handleStopSignal);
process.once("SIGTERM", handleStopSignal);
