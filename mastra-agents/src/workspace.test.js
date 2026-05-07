import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");
const bundleDir = path.join(packageRoot, ".cache/workspace-test");
const workspaceBundlePath = path.join(bundleDir, "workspace.mjs");
const dockerConfigBundlePath = path.join(bundleDir, "docker-sandbox-config.mjs");
const esbuildBin = path.resolve(packageRoot, "../node_modules/.bin/esbuild");

function buildBundle(entry, outfile) {
  execFileSync(esbuildBin, [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${outfile}`,
    "--external:@mastra/*",
    "--external:@daytona/*",
    "--external:zod",
  ], { cwd: packageRoot, stdio: "pipe" });
}

function buildWorkspaceBundles() {
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  buildBundle("src/workspace.ts", workspaceBundlePath);
  buildBundle("src/docker-sandbox-config.ts", dockerConfigBundlePath);
}

test("workspace docker sandbox env resolves to DockerSandbox provider", () => {
  buildWorkspaceBundles();
  const script = `
    process.env.MASTRA_WORKSPACE_SANDBOX = "docker";
    process.env.MASTRA_DOCKER_SANDBOX_HOST_WORKSPACE_ROOT = "/host/checkout";
    process.env.MASTRA_WORKSPACE_ROOT = "/app";
    const workspace = await import(${JSON.stringify(workspaceBundlePath)});
    console.log(JSON.stringify({
      workspaceSandboxProvider: workspace.workspaceSandboxProvider,
      codingSandboxProvider: workspace.codingSandbox.provider,
    }));
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = JSON.parse(output);

  assert.equal(state.workspaceSandboxProvider, "docker");
  assert.equal(state.codingSandboxProvider, "docker");
});

test("docker bind mounts prefer host workspace root for container workspace", () => {
  buildWorkspaceBundles();
  const script = `
    process.env.MASTRA_DOCKER_SANDBOX_HOST_WORKSPACE_ROOT = "/host/checkout";
    process.env.MASTRA_WORKSPACE_ROOT = "/app";
    const config = await import(${JSON.stringify(dockerConfigBundlePath)});
    console.log(JSON.stringify(config.resolveDockerBindMounts()));
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mounts = JSON.parse(output);

  assert.equal(mounts["/host/checkout"], "/workspace");
  assert.equal(mounts["/app"], undefined);
});
