#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "..");

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== `"` && quote !== `'`) || trimmed.at(-1) !== quote) return trimmed;
  const body = trimmed.slice(1, -1);
  return quote === `"` ? body.replace(/\\n/g, "\n").replace(/\\"/g, `"`) : body;
}

function parseEnvFile(filePath) {
  const values = {};
  if (!existsSync(filePath)) return values;

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquote(assignment.slice(equalsIndex + 1));
  }

  return values;
}

const [, , command, ...args] = process.argv;
if (!command) {
  console.error("Usage: node scripts/with-env.mjs <command> [...args]");
  process.exit(1);
}

function mergeNonEmpty(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === "" && merged[key]) continue;
      merged[key] = value;
    }
  }
  return merged;
}

const fileEnv = mergeNonEmpty(
  parseEnvFile(path.join(repoRoot, ".env")),
  parseEnvFile(path.join(packageRoot, ".env")),
);
const env = { ...fileEnv, ...process.env };
if (!env.MINIMAX_API_KEY && env.MASTRA_MINIMAX_API_KEY) {
  env.MINIMAX_API_KEY = env.MASTRA_MINIMAX_API_KEY;
}

const child = spawn(command, args, {
  cwd: packageRoot,
  env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start ${command}: ${error.message}`);
  process.exit(1);
});
