#!/usr/bin/env node
import { spawn } from "node:child_process";

const userArgs = process.argv.slice(2);

function hasOption(longName, shortName) {
  return userArgs.some((arg) => {
    return (
      arg === longName ||
      (shortName && arg === shortName) ||
      arg.startsWith(`${longName}=`)
    );
  });
}

function addDefault(args, longName, shortName, value) {
  if (!value || hasOption(longName, shortName)) return;
  args.push(longName, String(value));
}

const args = ["studio"];
addDefault(
  args,
  "--port",
  "-p",
  process.env.MASTRA_STUDIO_INTERNAL_PORT ?? process.env.MASTRA_STUDIO_PORT ?? "4111",
);
addDefault(
  args,
  "--server-host",
  "-h",
  process.env.MASTRA_STUDIO_SERVER_HOST ?? "localhost",
);
addDefault(
  args,
  "--server-port",
  "-s",
    process.env.MASTRA_STUDIO_SERVER_PORT ??
    process.env.MASTRA_STUDIO_PROXY_PORT ??
    process.env.MASTRA_SERVER_PORT ??
    process.env.PORT ??
    "4111",
);
addDefault(
  args,
  "--server-protocol",
  "-x",
  process.env.MASTRA_STUDIO_SERVER_PROTOCOL ?? "http",
);
args.push(...userArgs);

const command = process.platform === "win32" ? "mastra.cmd" : "mastra";
const child = spawn(command, args, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start Mastra Studio: ${error.message}`);
  process.exit(1);
});
