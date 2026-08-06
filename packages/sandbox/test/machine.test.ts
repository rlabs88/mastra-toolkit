import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SANDBOX_SPEC_PATH,
  createDockerSandboxMachine,
  createLocalSandboxMachine,
  createSandboxMachine,
  enforceSandboxRuntimeProfile,
  loadSandboxSpec,
  type SandboxMachineBaseOptions,
} from "../src/index.js";
import type { CloneableSandboxMachine } from "../src/index.js";

const specification = loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH);

describe("sandbox machine adapters", () => {
  test.each(["local", "docker", "platform"] as const)("creates a cloneable %s machine", provider => {
    const machine = createSandboxMachine({
      provider,
      workspaceRoot: process.cwd(),
      specification,
      platform: provider === "platform"
        ? { environmentId: "env", projectId: "project", secretKey: "secret" }
        : undefined,
    });

    expect(machine.provider).toBe(provider);
    expect(machine.clone({ id: "clone" }).provider).toBe(provider);
  });

  test("requires complete Platform identity instead of falling back", () => {
    expect(() => createSandboxMachine({
      provider: "platform",
      workspaceRoot: process.cwd(),
      specification,
    })).toThrow(/platform/i);
  });

  test("maps immutable entrypoint policy into Docker", async () => {
    const machine = createDockerSandboxMachine({
      workspaceRoot: process.cwd(),
      specification,
    });

    await expect(machine.getInfo!()).resolves.toMatchObject({
      metadata: {
        image: specification.spec.entrypointProfile.image,
        workingDir: specification.spec.workdir,
      },
    });
  });

  test("maps the deployment-selected runtime image into Docker", async () => {
    const runtimeImage = "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const options: SandboxMachineBaseOptions & { runtimeImage: string } = {
      workspaceRoot: process.cwd(),
      specification,
      runtimeImage,
    };
    const machine = createDockerSandboxMachine(options);

    await expect(machine.getInfo!()).resolves.toMatchObject({
      metadata: {
        image: runtimeImage,
        labels: { "ai.mastra.runtime-image": runtimeImage },
      },
    });
  });

  test("rejects a mutable runtime image at the Docker construction boundary", () => {
    expect(() => createDockerSandboxMachine({
      workspaceRoot: process.cwd(),
      specification,
      runtimeImage: "ghcr.io/rlabs88/toolkit/mcode-sandbox:latest",
    })).toThrow(/immutable.*digest/i);
  });

  test("admits a cloned remote sandbox only after its runtime profile probe passes", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const clone = runtimeProbeFixture(commands, 0);
    const machine = enforceSandboxRuntimeProfile(clone, "persistent-operations");

    await machine.clone({ id: "session" }).start!();

    expect(commands).toEqual([{
      command: "/usr/local/bin/mastra-toolkit-runtime-probe",
      args: ["persistent-operations"],
    }]);
  });

  test("admits before direct command execution and preserves the selected image identity", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const cloneEnvironments: Array<Record<string, string> | undefined> = [];
    const runtimeImage = "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fixture = runtimeProbeFixture(commands, 0, cloneEnvironments);
    const machine = enforceSandboxRuntimeProfile(fixture, "ephemeral-development", runtimeImage)
      .clone({ id: "session", env: { GITHUB_TOKEN: "task-only" } });

    await machine.executeCommand!("node", ["--version"]);

    expect(commands).toEqual([
      { command: "/usr/local/bin/mastra-toolkit-runtime-probe", args: ["ephemeral-development", runtimeImage] },
      { command: "node", args: ["--version"] },
    ]);
    expect(cloneEnvironments).toEqual([{
      GITHUB_TOKEN: "task-only",
      MASTRA_TOOLKIT_RUNTIME_IMAGE: runtimeImage,
    }]);
  });

  test("wires createSandboxMachine through clone admission with the selected image", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runtimeImage = "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fixture = runtimeProbeFixture(commands, 0);
    const machine = createSandboxMachine({
      provider: "platform",
      workspaceRoot: process.cwd(),
      specification,
      platform: { environmentId: "env", projectId: "project", secretKey: "secret" },
      runtimeProfile: "ephemeral-development",
      runtimeImage,
    }, () => fixture);

    await machine.clone({ id: "session" }).executeCommand!("node", ["--version"]);

    expect(commands).toEqual([
      { command: "/usr/local/bin/mastra-toolkit-runtime-probe", args: ["ephemeral-development", runtimeImage] },
      { command: "node", args: ["--version"] },
    ]);
  });

  test("destroys a sandbox whose profile probe returns a mismatch", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    let destroyed = false;
    const fixture = runtimeProbeFixture(commands, 66, [], () => { destroyed = true; });
    const machine = enforceSandboxRuntimeProfile(fixture, "ephemeral-development");

    await expect(machine.executeCommand!("node", ["--version"])).rejects.toThrow(/missing layer/);
    expect(commands).toEqual([{
      command: "/usr/local/bin/mastra-toolkit-runtime-probe",
      args: ["ephemeral-development"],
    }]);
    expect(destroyed).toBe(true);
  });

  test("preserves managed lifecycle status and coalesces concurrent admission", async () => {
    const events: string[] = [];
    const fixture = managedRuntimeProbeFixture(events);
    const machine = enforceSandboxRuntimeProfile(fixture, "ephemeral-development");

    await Promise.all([machine.start!(), machine.start!()]);
    expect(machine.status).toBe("running");
    expect(events).toEqual(["_start", "probe"]);

    await (machine as CloneableSandboxMachine & { _stop?: () => Promise<void> })._stop!();
    expect(machine.status).toBe("stopped");
    expect(events).toEqual(["_start", "probe", "_stop"]);
  });

  test("destroys a remote sandbox when runtime profile admission cannot run", async () => {
    let destroyed = false;
    const fixture = runtimeProbeThrowingFixture(() => { destroyed = true; });
    const machine = enforceSandboxRuntimeProfile(fixture, "ephemeral-development");

    await expect(machine.clone({ id: "session" }).start!()).rejects.toThrow(/runtime admission/i);
    expect(destroyed).toBe(true);
  });

  test("destroys a remote sandbox when provider startup fails before admission", async () => {
    let destroyed = false;
    const fixture = runtimeProbeStartFailureFixture(() => { destroyed = true; });
    const machine = enforceSandboxRuntimeProfile(fixture, "ephemeral-development");

    await expect(machine.start!()).rejects.toThrow(/runtime admission.*startup unavailable/i);
    expect(destroyed).toBe(true);
  });

  test("reports failed destruction after stopping a rejected sandbox as fallback", async () => {
    const events: string[] = [];
    const fixture = runtimeProbeCleanupFailureFixture(events);
    const machine = enforceSandboxRuntimeProfile(fixture, "ephemeral-development");

    await expect(machine.start!()).rejects.toThrow(/cleanup: destroy failed: remove denied; stop fallback succeeded/i);
    expect(events).toEqual(["start", "probe", "destroy", "stop"]);
  });

  test("does not commit admission after a concurrent lifecycle shutdown", async () => {
    const events: string[] = [];
    let releaseProbe: (() => void) | undefined;
    const probeBlocked = new Promise<void>(resolve => { releaseProbe = resolve; });
    let probeEntered: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { probeEntered = resolve; });
    const fixture = concurrentAdmissionFixture(events, entered, probeEntered, probeBlocked);
    const machine = enforceSandboxRuntimeProfile(fixture, "ephemeral-development");

    const admission = machine.start!();
    await entered;
    await machine.stop!();
    releaseProbe!();

    await expect(admission).rejects.toThrow(/interrupted by lifecycle shutdown/i);
    await expect(machine.executeCommand!("node", ["--version"])).resolves.toMatchObject({ exitCode: 0 });
    expect(events).toEqual(["_start", "probe-enter", "_stop", "probe-pass", "_start", "probe-enter", "probe-pass", "command"]);
  });

  test("makes git available through the configured Local adapter", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "rlabs-local-sandbox-"));
    const machine = createLocalSandboxMachine({ workspaceRoot, specification });

    try {
      await machine.start!();
      const result = await machine.executeCommand!("git", ["--version"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^git version /);
    } finally {
      await machine.destroy!();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function runtimeProbeFixture(
  commands: Array<{ command: string; args: string[] }>,
  exitCode: number,
  cloneEnvironments: Array<Record<string, string> | undefined> = [],
  onDestroy: () => void = () => undefined,
): CloneableSandboxMachine {
  const sandbox = {
    id: "fixture",
    name: "FixtureSandbox",
    provider: "platform" as const,
    status: "pending" as const,
    clone: (options?: { env?: Record<string, string> }) => {
      cloneEnvironments.push(options?.env);
      return runtimeProbeFixture(commands, exitCode, cloneEnvironments, onDestroy);
    },
    start: async () => undefined,
    destroy: async () => { onDestroy(); },
    executeCommand: async (command: string, args: string[] = []) => {
      commands.push({ command, args });
      return {
        success: exitCode === 0,
        exitCode,
        stdout: "",
        stderr: exitCode === 0 ? "" : "missing layer",
        executionTimeMs: 1,
      };
    },
  };
  return sandbox;
}

function managedRuntimeProbeFixture(events: string[]): CloneableSandboxMachine {
  const fixture = {
    id: "managed-fixture",
    name: "ManagedFixtureSandbox",
    provider: "platform" as const,
    status: "pending" as "pending" | "running" | "stopped",
    clone: () => managedRuntimeProbeFixture(events),
    start: async () => { events.push("raw-start"); },
    stop: async () => { events.push("raw-stop"); },
    _start: async () => {
      events.push("_start");
      fixture.status = "running";
    },
    _stop: async () => {
      events.push("_stop");
      fixture.status = "stopped";
    },
    executeCommand: async (command: string) => {
      events.push(command === "/usr/local/bin/mastra-toolkit-runtime-probe" ? "probe" : command);
      return { success: true, exitCode: 0, stdout: "", stderr: "", executionTimeMs: 1 };
    },
  };
  return fixture as CloneableSandboxMachine;
}

function runtimeProbeThrowingFixture(onDestroy: () => void): CloneableSandboxMachine {
  return {
    id: "fixture",
    name: "FixtureSandbox",
    provider: "platform",
    status: "pending",
    clone: () => runtimeProbeThrowingFixture(onDestroy),
    start: async () => undefined,
    destroy: async () => { onDestroy(); },
    executeCommand: async () => { throw new Error("transport unavailable"); },
  };
}

function runtimeProbeStartFailureFixture(onDestroy: () => void): CloneableSandboxMachine {
  return {
    id: "fixture",
    name: "FixtureSandbox",
    provider: "platform",
    status: "pending",
    clone: () => runtimeProbeStartFailureFixture(onDestroy),
    start: async () => { throw new Error("startup unavailable"); },
    destroy: async () => { onDestroy(); },
    executeCommand: async () => { throw new Error("must not execute"); },
  };
}

function runtimeProbeCleanupFailureFixture(events: string[]): CloneableSandboxMachine {
  return {
    id: "fixture",
    name: "FixtureSandbox",
    provider: "platform",
    status: "pending",
    clone: () => runtimeProbeCleanupFailureFixture(events),
    start: async () => { events.push("start"); },
    stop: async () => { events.push("stop"); },
    destroy: async () => { events.push("destroy"); throw new Error("remove denied"); },
    executeCommand: async () => {
      events.push("probe");
      return { success: false, exitCode: 66, stdout: "", stderr: "profile mismatch", executionTimeMs: 1 };
    },
  };
}

function concurrentAdmissionFixture(
  events: string[],
  entered: Promise<void>,
  enterProbe: (() => void) | undefined,
  probeBlocked: Promise<void>,
): CloneableSandboxMachine {
  const fixture = {
    id: "concurrent-fixture",
    name: "ConcurrentFixtureSandbox",
    provider: "platform" as const,
    status: "pending" as "pending" | "running" | "stopped",
    clone: () => concurrentAdmissionFixture(events, entered, enterProbe, probeBlocked),
    _start: async () => { events.push("_start"); fixture.status = "running"; },
    _stop: async () => { events.push("_stop"); fixture.status = "stopped"; },
    executeCommand: async (command: string) => {
      if (command === "/usr/local/bin/mastra-toolkit-runtime-probe") {
        events.push("probe-enter");
        enterProbe?.();
        await probeBlocked;
        events.push("probe-pass");
      } else {
        events.push("command");
      }
      return { success: true, exitCode: 0, stdout: "", stderr: "", executionTimeMs: 1 };
    },
  };
  return fixture as CloneableSandboxMachine;
}
