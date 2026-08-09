import { spawn } from "node:child_process";
import { access, unlink } from "node:fs/promises";
import { join } from "node:path";

import { terminateChildProcessTree, waitForChildExit } from "./process-supervision.js";
import { prepareManagedStudioDevRoot } from "./studio-dev-root.js";

const RESTART_EXIT_CODE = 75;
const toolkitRoot = process.env.MZ_TOOLKIT_ROOT;
if (!toolkitRoot) throw new Error("MZ_TOOLKIT_ROOT is required");
const devRoot = process.env.MZ_DEV_ROOT;
if (!devRoot) throw new Error("MZ_DEV_ROOT is required");
const restartFile = process.env.MZ_RESTART_FILE;
if (!restartFile) throw new Error("MZ_RESTART_FILE is required");
const stopFile = process.env.MZ_STOP_FILE;
if (!stopFile) throw new Error("MZ_STOP_FILE is required");

let stopping = false;
let child: ReturnType<typeof spawn> | undefined;
let resolveExternalStop: (() => void) | undefined;
const externalStop = new Promise<void>(resolveStop => { resolveExternalStop = resolveStop; });

const forwardStop = (): void => {
  stopping = true;
  resolveExternalStop?.();
};
process.once("SIGTERM", forwardStop);
process.once("SIGINT", forwardStop);

await unlink(stopFile).catch(error => {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
});
await prepareManagedStudioDevRoot(toolkitRoot, devRoot);

while (!stopping) {
  await unlink(restartFile).catch(error => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
  child = spawn(process.execPath, [
    join(toolkitRoot, "node_modules", "mastra", "dist", "index.js"),
    "dev",
    "--dir",
    join(toolkitRoot, "apps", "studio", "src"),
    "--root",
    devRoot,
  ], { cwd: toolkitRoot, env: process.env, stdio: "inherit", detached: true });
  const childExit = waitForChildExit(child);
  const exit = childExit.then(({ code }) => ({ kind: "exit" as const, code }));
  const markerWait = new AbortController();
  const restart = waitForRestartMarker(restartFile, markerWait.signal).then(() => ({ kind: "restart" as const }));
  const stop = waitForRestartMarker(stopFile, markerWait.signal).then(() => ({ kind: "stop" as const }));
  const outcome = await Promise.race([
    exit,
    restart,
    stop,
    externalStop.then(() => ({ kind: "stop" as const })),
  ]);
  markerWait.abort();
  if (outcome.kind === "stop" || await markerExists(stopFile)) stopping = true;
  if (outcome.kind === "restart" || outcome.kind === "stop") {
    await terminateChildProcessTree(child, childExit);
  }
  child = undefined;
  if (stopping) break;
  if (outcome.kind === "exit" && outcome.code !== RESTART_EXIT_CODE) process.exit(outcome.code ?? 1);
}
await unlink(stopFile).catch(error => {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
});

async function waitForRestartMarker(path: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
