import type { ChildProcess } from "node:child_process";

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

export async function terminateChildProcessTree(
  child: ChildProcess,
  exit: Promise<ChildExit> = waitForChildExit(child),
  options: { readonly termGraceMs?: number; readonly killGraceMs?: number } = {},
): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) return exit;
  signalChildTree(child, "SIGTERM");
  const terminated = await raceExit(exit, options.termGraceMs ?? 5_000);
  if (terminated) return terminated;
  signalChildTree(child, "SIGKILL");
  const killed = await raceExit(exit, options.killGraceMs ?? 2_000);
  if (killed) return killed;
  throw new Error(`Child process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function raceExit(exit: Promise<ChildExit>, timeoutMs: number): Promise<ChildExit | undefined> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<undefined>(resolveTimeout => { timer = globalThis.setTimeout(resolveTimeout, timeoutMs); }),
    ]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}
