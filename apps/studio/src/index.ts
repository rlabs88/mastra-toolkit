import { Mastra } from "@mastra/core/mastra";
import { prepareMcodeRuntime } from "@rlabs/mcode";

export const localProject = await prepareMcodeRuntime({ cwd: process.cwd(), host: "studio" });
export const agents = localProject.agents;
export const mastra = new Mastra(localProject.mastraArgs);

export const runtime = await localProject.finalize(mastra);
export const shutdown = () => runtime.close();
