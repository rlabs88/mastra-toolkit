import { Mastra } from "@mastra/core/mastra";
import { prepareMcodeRuntime } from "@rlabs/mcode";
import { writeFile } from "node:fs/promises";

export const MZ_WORKFLOW_RESTART_EXIT_CODE = 75;
let mountedRuntime: Awaited<ReturnType<typeof localProject.finalize>> | undefined;
let restartRequested = false;

const requestRestart = (): void => {
  if (restartRequested) return;
  restartRequested = true;
  setImmediate(() => {
    void (async () => {
      await mountedRuntime?.close();
      const marker = process.env.MZ_RESTART_FILE;
      if (marker) await writeFile(marker, `${Date.now()}\n`, { mode: 0o600 });
    })().finally(() => process.exit(MZ_WORKFLOW_RESTART_EXIT_CODE));
  });
};

export const localProject = await prepareMcodeRuntime({
  cwd: process.env.MASTRA_TOOLKIT_PROJECT_ROOT ?? process.cwd(),
  host: "studio",
  ...(process.env.MASTRA_APP_DATA_DIR ? { dataDirectory: process.env.MASTRA_APP_DATA_DIR } : {}),
  onRestartRequired: requestRestart,
});
export const agents = localProject.agents;
export const contract = localProject.contract;
export const projection = localProject.projection;
export const mastra = new Mastra(localProject.mastraArgs);

export const runtime = await localProject.finalize(mastra);
mountedRuntime = runtime;
export const shutdown = () => runtime.close();
