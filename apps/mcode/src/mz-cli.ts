import { spawn } from "node:child_process";
import {
  createMzProjectContext,
  ensureMzRuntime,
  probeMcodeRuntime,
  resolveMzCurrentBinding,
  runRemoteMzTui,
  stopMzRuntime,
  type MzRuntimeBinding,
} from "@rlabs/mcode";

function parseArguments(argv: string[]): { command: "run" | "status" | "logs" | "stop"; url?: string } {
  const args = [...argv];
  const first = args[0];
  const command = first === "status" || first === "logs" || first === "stop" ? args.shift() as "status" | "logs" | "stop" : "run";
  const urlIndex = args.indexOf("--url");
  if (urlIndex === -1) return { command };
  const url = args[urlIndex + 1];
  if (!url) throw new Error("--url requires a Studio URL");
  return { command, url };
}

async function currentBinding(): Promise<MzRuntimeBinding | undefined> {
  const context = await createMzProjectContext();
  return resolveMzCurrentBinding(context);
}

async function followLogs(path: string): Promise<void> {
  const child = spawn("tail", ["-n", "100", "-f", path], { stdio: "inherit" });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", code => code === 0 || code === null ? resolveExit() : rejectExit(new Error(`tail exited with ${code}`)));
  });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "run") {
    const { binding } = await ensureMzRuntime({ ...(args.url ? { url: args.url } : {}) });
    console.error(`Mastra Studio: ${binding.url}`);
    await runRemoteMzTui(binding);
    return;
  }

  const context = await createMzProjectContext();
  if (args.command === "stop") {
    console.log(await stopMzRuntime(context) ? "Stopped mz Studio runtime." : "No managed mz runtime is running.");
    return;
  }
  const binding = await currentBinding();
  if (!binding) {
    console.log("No matching Studio runtime is running for this project.");
    return;
  }
  if (args.command === "logs") {
    if (!binding.logPath) throw new Error("The matching Studio runtime is not managed by mz and has no managed log.");
    await followLogs(binding.logPath);
    return;
  }
  const descriptor = await probeMcodeRuntime(binding.url);
  console.log(JSON.stringify({
    projectRoot: context.projectRoot,
    url: binding.url,
    managed: binding.managed,
    pid: binding.pid,
    ready: descriptor?.mounting.ready === true,
    generation: descriptor?.mounting.generation ?? 0,
    observability: descriptor?.observability ?? { enabled: false, export: "disabled" },
  }, null, 2));
}

await main();
