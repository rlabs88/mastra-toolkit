import { spawn } from "node:child_process";

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("Usage: node scripts/with-infisical.mjs <command> [args...]");
  process.exit(2);
}

const nested = [
  "run", "--env=dev", "--path=/agents", "--",
  "infisical", "run", "--env=dev", "--path=/mastra-toolkit", "--",
  ...command,
];

const child = spawn("infisical", nested, { stdio: "inherit", env: process.env });
child.on("error", error => {
  console.error(`Unable to start Infisical: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
