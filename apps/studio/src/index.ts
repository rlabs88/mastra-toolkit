import { Mastra } from "@mastra/core/mastra";
import { prepareMcodeRuntime } from "@rlabs/mcode";

export const localProject = await prepareMcodeRuntime({ cwd: process.cwd() });
export const agents = localProject.agents;
export const mastra = new Mastra(localProject.mastraArgs);

await localProject.finalize(mastra);
