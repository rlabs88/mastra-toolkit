#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultScopes = [
  "read",
  "write",
  "comments:create",
  "issues:create",
  "app:mentionable",
  "app:assignable",
];

function env(name) {
  return process.env[name]?.trim();
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== `"` && quote !== `'`) || trimmed.at(-1) !== quote) return trimmed;
  const body = trimmed.slice(1, -1);
  return quote === `"` ? body.replace(/\\n/g, "\n").replace(/\\"/g, `"`) : body;
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = assignment.slice(0, equalsIndex).trim();
    if (process.env[key]) continue;
    process.env[key] = unquote(assignment.slice(equalsIndex + 1));
  }
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "..");
loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(packageRoot, ".env"));

const clientId = env("LINEAR_CLIENT_ID");
const redirectUri = env("LINEAR_REDIRECT_URI");
const scopes = (env("LINEAR_OAUTH_SCOPES") || defaultScopes.join(","))
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

const missing = [
  ...(!clientId ? ["LINEAR_CLIENT_ID"] : []),
  ...(!redirectUri ? ["LINEAR_REDIRECT_URI"] : []),
];

if (missing.length > 0) {
  console.error(`Missing required Linear OAuth env: ${missing.join(", ")}`);
  process.exit(1);
}

const params = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: scopes.join(","),
  actor: "app",
});

console.log(`https://linear.app/oauth/authorize?${params.toString()}`);
