import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxFleet, type SandboxBindingStore } from "@mastra/factory/sandbox/fleet";
import { createSandboxMachine, loadSandboxConfig } from "@rlabs/sandbox";
import { afterEach, describe, expect, test } from "vitest";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("single-project sandbox binding", () => {
  test("pins fleet reattachment, task environment rotation, and binding cleanup", async () => {
    root = await mkdtemp(join(tmpdir(), "rlabs-factory-project-"));
    const workdir = join(root, "session");
    await mkdir(workdir);
    const config = loadSandboxConfig({
      SANDBOX_PROVIDER: "local",
      WORKSPACE_ROOT: root,
    }, process.cwd());
    const machine = createSandboxMachine({
      provider: config.provider,
      workspaceRoot: config.workspaceRoot,
      specification: config.specification,
    });
    const binding = new MemoryBinding("mastra-toolkit-single-project");
    const firstFleet = new SandboxFleet({ machine, workdirBase: root, maxSandboxes: 1 });
    const first = await firstFleet.ensureSandbox(
      binding,
      { FACTORY_TASK_TOKEN: "session-one" },
      undefined,
      { workingDirectory: workdir },
    );

    const scopedCredential = await first.executeCommand("node", [
      "-e",
      "process.stdout.write(process.env.FACTORY_TASK_TOKEN ?? '')",
    ]);
    expect(scopedCredential.exitCode, scopedCredential.stderr).toBe(0);
    expect(scopedCredential.stdout).toBe("session-one");
    expect(process.env.FACTORY_TASK_TOKEN).toBeUndefined();
    const write = await first.executeCommand("node", [
      "-e",
      "require('node:fs').writeFileSync('binding.txt', 'persisted')",
    ]);
    expect(write.exitCode, write.stderr).toBe(0);
    expect(binding.sandboxId).toBeTruthy();

    const restartedFleet = new SandboxFleet({ machine, workdirBase: root, maxSandboxes: 1 });
    const resumed = await restartedFleet.ensureSandbox(
      binding,
      { FACTORY_TASK_TOKEN: "session-two" },
      undefined,
      { workingDirectory: workdir },
    );
    const rotatedCredential = await resumed.executeCommand("node", [
      "-e",
      "process.stdout.write(process.env.FACTORY_TASK_TOKEN ?? '')",
    ]);
    const read = await resumed.executeCommand("node", [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('binding.txt', 'utf8'))",
    ]);

    expect(rotatedCredential.exitCode, rotatedCredential.stderr).toBe(0);
    expect(rotatedCredential.stdout).toBe("session-two");
    expect(read.exitCode, read.stderr).toBe(0);
    expect(read.stdout).toBe("persisted");
    expect(resumed.id).toBe(first.id);

    await restartedFleet.teardownSandbox(binding, resumed);
    expect(binding.sandboxId).toBeNull();
    expect(binding.cleared).toBe(true);

    const replacement = await restartedFleet.ensureSandbox(
      binding,
      {},
      undefined,
      { workingDirectory: workdir },
    );
    const absentCredential = await replacement.executeCommand("node", [
      "-e",
      "process.stdout.write(process.env.FACTORY_TASK_TOKEN ?? '')",
    ]);
    expect(absentCredential.exitCode, absentCredential.stderr).toBe(0);
    expect(absentCredential.stdout).toBe("");
    await restartedFleet.teardownSandbox(binding, replacement);
  });
});

class MemoryBinding implements SandboxBindingStore {
  sandboxId: string | null = null;
  cleared = false;

  constructor(readonly checkpointName: string) {}

  async setSandboxId(id: string | null): Promise<void> {
    this.sandboxId = id;
  }

  async clear(): Promise<void> {
    this.sandboxId = null;
    this.cleared = true;
  }
}
