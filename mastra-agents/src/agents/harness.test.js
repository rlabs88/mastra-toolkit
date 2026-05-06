import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const bundleDir = path.join(packageRoot, ".cache/harness-test");
const bundlePath = path.join(bundleDir, "harness.mjs");
const esbuildBin = path.resolve(packageRoot, "../node_modules/.bin/esbuild");

function buildHarnessBundle() {
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  execFileSync(esbuildBin, [
    "src/agents/harness-modes.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
    "--external:@mastra/*",
    "--external:@chat-adapter/*",
    "--external:zod",
  ], { cwd: packageRoot, stdio: "pipe" });
}

function readHarnessState() {
  const script = `
    import { pathToFileURL } from "node:url";
    const harness = await import(pathToFileURL(${JSON.stringify(bundlePath)}));
    const resolve = (input) => {
      const mode = harness.resolveMastraAgentHarnessMode(input);
      return {
        activeAgentId: mode.activeAgentId,
        harnessMode: mode.harnessMode,
        harnessModeId: mode.harnessModeId,
        supervisorScope: mode.supervisorScope,
        orchestratorMode: mode.orchestratorMode,
      };
    };
    const rejects = (input) => {
      try {
        harness.resolveMastraAgentHarnessMode(input);
        return false;
      } catch {
        return true;
      }
    };
    console.log(JSON.stringify({
      defaultModeId: harness.defaultMastraAgentHarnessModeId(),
      modeIds: harness.mastraAgentHarnessModeSpecs.map((mode) => mode.id),
      defaultResolved: resolve({}),
      supervisorDefault: resolve({ agentId: "supervisor" }),
      supervisorAliases: {
        balanced: resolve({ agentId: "supervisor", harnessMode: "balanced" }),
        plan: resolve({ agentId: "supervisor", harnessMode: "plan" }),
        build: resolve({ agentId: "supervisor", harnessMode: "build" }),
        verify: resolve({ agentId: "supervisor", harnessMode: "verify" }),
      },
      orchestratorAliases: {
        quick: resolve({ harnessMode: "quick" }),
        precision: resolve({ harnessMode: "precision" }),
        auto: resolve({ harnessMode: "auto" }),
        balanced: resolve({ agentId: "orchestrator", harnessMode: "balanced" }),
        plan: resolve({ agentId: "orchestrator", harnessMode: "plan" }),
      },
      rejects: {
        scoutScope: rejects({ harnessMode: "scout.scope" }),
        scoutAgent: rejects({ agentId: "scout" }),
      },
    }));
    process.exit(0);
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

test("harness exposes only supervisor scopes and orchestrator modes", () => {
  buildHarnessBundle();
  const state = readHarnessState();

  assert.equal(state.defaultModeId, "orchestrator.auto");
  assert.deepEqual(state.modeIds, [
    "orchestrator.quick",
    "orchestrator.precision",
    "orchestrator.auto",
    "supervisor.base",
    "supervisor.scope",
    "supervisor.spec",
    "supervisor.exec",
  ]);
});

test("harness resolves canonical modes and compatibility aliases", () => {
  buildHarnessBundle();
  const state = readHarnessState();

  assert.deepEqual(state.defaultResolved, {
    activeAgentId: "orchestrator",
    harnessMode: "auto",
    harnessModeId: "orchestrator.auto",
    orchestratorMode: "auto",
  });
  assert.deepEqual(state.supervisorDefault, {
    activeAgentId: "supervisor",
    harnessMode: "base",
    harnessModeId: "supervisor.base",
    supervisorScope: "base",
  });

  assert.equal(state.supervisorAliases.balanced.harnessModeId, "supervisor.base");
  assert.equal(state.supervisorAliases.plan.harnessModeId, "supervisor.spec");
  assert.equal(state.supervisorAliases.build.harnessModeId, "supervisor.exec");
  assert.equal(state.supervisorAliases.verify.harnessModeId, "supervisor.exec");

  assert.equal(state.orchestratorAliases.quick.harnessModeId, "orchestrator.quick");
  assert.equal(state.orchestratorAliases.precision.harnessModeId, "orchestrator.precision");
  assert.equal(state.orchestratorAliases.auto.harnessModeId, "orchestrator.auto");
  assert.equal(state.orchestratorAliases.balanced.harnessModeId, "orchestrator.auto");
  assert.equal(state.orchestratorAliases.plan.harnessModeId, "orchestrator.precision");
});

test("harness rejects specialist direct modes", () => {
  buildHarnessBundle();
  const state = readHarnessState();

  assert.equal(state.rejects.scoutScope, true);
  assert.equal(state.rejects.scoutAgent, true);
});
