#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageRoot = path.join(repoRoot, "mastra-agents");
const compiledAcpRoot = path.join(repoRoot, "compiled", "mastra-agents", "acp");
const packageDir = path.join(repoRoot, "compiled", "mastra-agents", "npm-package");
const tarballDir = path.join(repoRoot, "compiled", "mastra-agents", "tarballs");
const sourcePackage = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));

rmSync(packageDir, { recursive: true, force: true });
mkdirSync(path.join(packageDir, "acp"), { recursive: true });
mkdirSync(tarballDir, { recursive: true });
cpSync(compiledAcpRoot, path.join(packageDir, "acp"), { recursive: true });
chmodSync(path.join(packageDir, "acp", "stdio.js"), 0o755);

writeFileSync(
  path.join(packageDir, "package.json"),
  `${JSON.stringify({
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: "module",
    engines: sourcePackage.engines,
    bin: {
      "mastra-agents-acp": "acp/stdio.js",
    },
    dependencies: {
      "@agentclientprotocol/sdk": sourcePackage.dependencies["@agentclientprotocol/sdk"],
    },
  }, null, 2)}\n`,
);

writeFileSync(
  path.join(packageDir, "README.md"),
  [
    "# Mastra Agents ACP",
    "",
    "Install this tarball globally with a user-local npm prefix:",
    "",
    "```bash",
    'npm install -g --prefix "$HOME/.local" ./mastrasystem-agents-*.tgz',
    "```",
    "",
    "The installed `mastra-agents-acp` binary speaks Agent Client Protocol over stdio.",
    "",
  ].join("\n"),
);

const result = spawnSync("npm", ["pack", packageDir, "--pack-destination", tarballDir], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Packed ACP tarball into ${tarballDir}`);
