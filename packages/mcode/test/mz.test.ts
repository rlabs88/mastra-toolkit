import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  MastraProjectHostRegistry,
  MzRuntimeManager,
  ProjectWorkflowRestartRequiredError,
  resolveMzCurrentBinding,
  stopMzRuntime,
  writeMzBinding,
  type McodeRuntimeDescriptor,
  type MzRuntimeBinding,
} from "../src/index.js";

const descriptor = (projectRoot: string): McodeRuntimeDescriptor => ({
  schemaVersion: 1,
  remoteTuiProtocolVersion: 1,
  remoteTuiCapabilities: {
    chat: true, threads: true, modes: true, models: true, goals: true, permissions: true, approvals: true, skills: true,
  },
  remoteTuiSubagents: [
    { id: "cortex", name: "Cortex", description: "Implementation" },
    { id: "flux", name: "Flux", description: "Discovery" },
    { id: "zen", name: "Zen", description: "Knowledge" },
  ],
  runtimeId: "runtime-one",
  projectRoot,
  controllerId: "mastra-code",
  resourceId: "project-resource",
  contractDigest: "sha256:abc",
  mounting: { ready: true, generation: 1 },
  observability: { enabled: true, export: "local-only" },
});

describe("MzRuntimeManager", () => {
  test("reuses only a ready runtime mounted for the current project", async () => {
    const launch = vi.fn();
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async url => url.endsWith(":4111") ? descriptor("/repo/one") : undefined),
      findAvailablePort: vi.fn(),
      launch,
    });

    const runtime = await manager.ensureRuntime();

    expect(runtime.url).toBe("http://127.0.0.1:4111");
    expect(runtime.managed).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test("leaves another project's server alone and launches on the next free port", async () => {
    let runtimeId = "";
    const launch = vi.fn(async ({ url, runtimeId: launchedRuntimeId }: { url: string; runtimeId: string }) => {
      runtimeId = launchedRuntimeId;
      return { pid: 42, logPath: "/tmp/mz.log", url };
    });
    const probe = vi.fn(async (url: string) => {
      if (url.endsWith(":4111")) return descriptor("/repo/other");
      if (url.endsWith(":4112") && launch.mock.calls.length > 0) return { ...descriptor("/repo/one"), runtimeId };
      return undefined;
    });
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe,
      findAvailablePort: vi.fn(async () => 4112),
      launch,
      persistBinding: vi.fn(async () => {}),
    });

    const runtime = await manager.ensureRuntime();

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ port: 4112, url: "http://127.0.0.1:4112" }));
    expect(runtime).toMatchObject({ url: "http://127.0.0.1:4112", pid: 42, managed: true });
  });

  test("ignores a stale recorded binding for another project", async () => {
    let runtimeId = "";
    const launch = vi.fn(async ({ url, runtimeId: launchedRuntimeId }: { url: string; runtimeId: string }) => {
      runtimeId = launchedRuntimeId;
      return { pid: 42, logPath: "/tmp/mz.log", url };
    });
    const probe = vi.fn(async (url: string) => {
      if (url.endsWith(":4999")) return descriptor("/repo/other");
      if (url.endsWith(":4112") && launch.mock.calls.length > 0) return { ...descriptor("/repo/one"), runtimeId };
      return undefined;
    });
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe,
      readBinding: vi.fn(async () => ({
        schemaVersion: 1 as const,
        runtimeId: "stale-runtime",
        projectRoot: "/repo/one",
        url: "http://127.0.0.1:4999",
        controllerId: "stale-controller",
        resourceId: "stale-resource",
        contractDigest: "sha256:stale" as const,
        remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
        remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
        managed: true,
        pid: 41,
      })),
      findAvailablePort: vi.fn(async () => 4112),
      launch,
      persistBinding: vi.fn(async () => {}),
    });

    const runtime = await manager.ensureRuntime();

    expect(runtime.url).toBe("http://127.0.0.1:4112");
    expect(runtime.controllerId).toBe("mastra-code");
  });

  test("uses the live descriptor as authority over recorded metadata", async () => {
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => descriptor("/repo/one")),
      launch: vi.fn(),
      readBinding: vi.fn(async () => ({
        schemaVersion: 1 as const,
        runtimeId: "runtime-one",
        projectRoot: "/repo/one",
        url: "http://127.0.0.1:4111",
        controllerId: "stale-controller",
        resourceId: "stale-resource",
        contractDigest: "sha256:stale" as const,
        remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
        remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
        managed: true,
        pid: 42,
      })),
    });

    const runtime = await manager.ensureRuntime();

    expect(runtime).toMatchObject({
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc",
      managed: true,
      pid: 42,
    });
  });

  test("drops managed process metadata when the runtime instance changed", async () => {
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => descriptor("/repo/one")),
      launch: vi.fn(),
      readBinding: vi.fn(async () => ({
        schemaVersion: 1 as const,
        runtimeId: "old-runtime",
        projectRoot: "/repo/one",
        url: "http://127.0.0.1:4111",
        controllerId: "mastra-code",
        resourceId: "project-resource",
        contractDigest: "sha256:abc" as const,
        remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
        remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
        managed: true,
        pid: 42,
      })),
    });

    const runtime = await manager.ensureRuntime();

    expect(runtime).toMatchObject({ runtimeId: "runtime-one", managed: false });
    expect(runtime.pid).toBeUndefined();
  });

  test("does not attach before local observability is ready", async () => {
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => ({
        ...descriptor("/repo/one"),
        observability: { enabled: false, export: "disabled" as const },
      })),
      launch: vi.fn(),
      readinessAttempts: 1,
      readinessDelayMs: 0,
    });

    await expect(manager.ensureRuntime("http://127.0.0.1:4111")).rejects.toThrow(/did not become ready/);
  });

  test("does not attach to a same-project runtime without the remote TUI protocol", async () => {
    let runtimeId = "";
    const { remoteTuiProtocolVersion: _remoteTuiProtocolVersion, ...oldDescriptor } = descriptor("/repo/one");
    const launch = vi.fn(async ({ url, runtimeId: nextRuntimeId }: { url: string; runtimeId: string }) => {
      runtimeId = nextRuntimeId;
      return { pid: 42, logPath: "/tmp/mz.log", url };
    });
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async url => url.endsWith(":4111")
        ? oldDescriptor as McodeRuntimeDescriptor
        : { ...descriptor("/repo/one"), runtimeId }),
      findAvailablePort: vi.fn(async () => 4112),
      launch,
      persistBinding: vi.fn(async () => {}),
    });

    const runtime = await manager.ensureRuntime();

    expect(runtime.url).toBe("http://127.0.0.1:4112");
    expect(launch).toHaveBeenCalledOnce();
  });

  test("terminates a managed launch that never becomes ready", async () => {
    const terminate = vi.fn();
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => undefined),
      findAvailablePort: vi.fn(async () => 4111),
      launch: vi.fn(async ({ url }) => ({ pid: 42, logPath: "/tmp/mz.log", url })),
      terminate,
      readinessAttempts: 1,
      readinessDelayMs: 0,
    });

    await expect(manager.ensureRuntime()).rejects.toThrow(/did not become ready/);
    expect(terminate).toHaveBeenCalledWith(42);
  });

  test("fails closed when an explicit URL belongs to another project", async () => {
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => descriptor("/repo/other")),
      findAvailablePort: vi.fn(),
      launch: vi.fn(),
    });

    await expect(manager.ensureRuntime("http://127.0.0.1:5000")).rejects.toThrow(/mounted for \/repo\/other/);
  });

  test("records a validated explicit attachment for subsequent status commands", async () => {
    let recorded: MzRuntimeBinding | undefined;
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => descriptor("/repo/one")),
      launch: vi.fn(),
      readBinding: vi.fn(async () => recorded),
      persistBinding: vi.fn(async binding => { recorded = binding; }),
    });

    const attached = await manager.ensureRuntime("http://127.0.0.1:4999");

    expect(attached).toMatchObject({ url: "http://127.0.0.1:4999", managed: false });
    expect(recorded).toEqual(attached);
  });

  test("preserves managed ownership when explicit attach uses an equivalent loopback URL", async () => {
    const existing = {
      schemaVersion: 1 as const,
      runtimeId: "runtime-one",
      projectRoot: "/repo/one",
      url: "http://127.0.0.1:4111",
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc" as const,
      remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
      remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
      managed: true,
      pid: 42,
      logPath: "/tmp/mz.log",
      stopPath: "/tmp/mz.stop",
    };
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => descriptor("/repo/one")),
      launch: vi.fn(),
      readBinding: vi.fn(async () => existing),
      persistBinding: vi.fn(async () => {}),
    });

    const attached = await manager.ensureRuntime("http://localhost:4111/");

    expect(attached).toMatchObject({ managed: true, pid: 42, logPath: "/tmp/mz.log", stopPath: "/tmp/mz.stop" });
  });

  test("waits through a managed workflow restart gap instead of launching a duplicate", async () => {
    let probes = 0;
    const launch = vi.fn();
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe: vi.fn(async () => ++probes === 1 ? undefined : descriptor("/repo/one")),
      launch,
      readBinding: vi.fn(async () => ({
        schemaVersion: 1 as const,
        runtimeId: "runtime-one",
        projectRoot: "/repo/one",
        url: "http://127.0.0.1:4111",
        controllerId: "mastra-code",
        resourceId: "project-resource",
        contractDigest: "sha256:abc" as const,
        remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
        remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
        managed: true,
        pid: 42,
      })),
      persistBinding: vi.fn(async () => {}),
      readinessAttempts: 3,
      readinessDelayMs: 0,
    });

    await expect(manager.ensureRuntime()).resolves.toMatchObject({ runtimeId: "runtime-one", managed: true, pid: 42 });
    expect(launch).not.toHaveBeenCalled();
  });

  test("does not send project identity to a non-loopback explicit URL", async () => {
    const probe = vi.fn();
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe,
      launch: vi.fn(),
    });

    await expect(manager.ensureRuntime("https://studio.example.com"))
      .rejects.toThrow(/local loopback/);
    expect(probe).not.toHaveBeenCalled();
  });

  test.each([
    "http://token@127.0.0.1:4111",
    "http://127.0.0.1:4111/studio",
    "http://127.0.0.1:4111/?token=secret",
    "http://127.0.0.1:4111/#fragment",
  ])("rejects non-origin explicit runtime URL %s", async url => {
    const probe = vi.fn();
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe,
      launch: vi.fn(),
    });

    await expect(manager.ensureRuntime(url)).rejects.toThrow(/local loopback/);
    expect(probe).not.toHaveBeenCalled();
  });

  test("never probes or attaches a tampered recorded non-loopback URL", async () => {
    const probe = vi.fn(async (url: string) => url === "http://127.0.0.1:4111" ? descriptor("/repo/one") : undefined);
    const manager = new MzRuntimeManager({
      projectRoot: "/repo/one",
      registryDirectory: "/tmp/unused",
      probe,
      launch: vi.fn(),
      readBinding: vi.fn(async () => ({
        schemaVersion: 1 as const, runtimeId: "stolen", projectRoot: "/repo/one",
        url: "http://attacker.example:4111", controllerId: "mastra-code", resourceId: "project-resource",
        contractDigest: "sha256:abc" as const,
        remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
        remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
        managed: true,
      })),
    });

    await expect(manager.ensureRuntime()).resolves.toMatchObject({ url: "http://127.0.0.1:4111" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalledWith("http://attacker.example:4111");
  });

  test("creates a private binding file below a fresh registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-binding-"));
    const path = join(root, "runtimes", "project.json");
    const binding = {
      schemaVersion: 1 as const,
      runtimeId: "runtime-one",
      projectRoot: "/repo/one",
      url: "http://127.0.0.1:4111",
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc" as const,
      remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
      remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
      managed: true,
      pid: 42,
    };

    await writeMzBinding(path, binding);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(binding);
  });

  test("treats a truncated binding as stale local state", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-corrupt-binding-"));
    const bindingPath = join(root, "runtime.json");
    await writeFile(bindingPath, '{"schemaVersion":1,', "utf8");
    const context = {
      projectRoot: "/repo/one",
      registryDirectory: root,
      bindingPath,
      manager: {} as MzRuntimeManager,
    };

    await expect(resolveMzCurrentBinding(context, async () => undefined)).resolves.toBeUndefined();
  });

  test("does not expose managed metadata from a dead or replaced recorded runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-current-binding-"));
    const bindingPath = join(root, "runtime.json");
    await writeMzBinding(bindingPath, {
      schemaVersion: 1,
      runtimeId: "old-runtime",
      projectRoot: "/repo/one",
      url: "http://127.0.0.1:4999",
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc",
      remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
      remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
      managed: true,
      pid: 42,
      logPath: "/tmp/stale.log",
    });
    const context = {
      projectRoot: "/repo/one",
      registryDirectory: root,
      bindingPath,
      manager: {} as MzRuntimeManager,
    };

    await expect(resolveMzCurrentBinding(context, async () => undefined)).resolves.toBeUndefined();
    await expect(resolveMzCurrentBinding(context, async url => url.endsWith(":4999")
      ? { ...descriptor("/repo/one"), runtimeId: "new-runtime" }
      : undefined)).resolves.toBeUndefined();
  });

  test("stops through the private control marker without signalling a recorded PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-stop-control-"));
    const bindingPath = join(root, "runtime.json");
    const stopPath = join(root, "control", "runtime.stop");
    await writeMzBinding(bindingPath, {
      schemaVersion: 1,
      runtimeId: "runtime-one",
      projectRoot: "/repo/one",
      url: "http://127.0.0.1:4999",
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc",
      remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
      remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
      managed: true,
      pid: 42,
      stopPath,
    });
    let calls = 0;
    const probe = vi.fn(async () => calls++ === 0 ? descriptor("/repo/one") : undefined);
    const kill = vi.spyOn(process, "kill");
    const context = {
      projectRoot: "/repo/one",
      registryDirectory: root,
      bindingPath,
      manager: {} as MzRuntimeManager,
    };

    await expect(stopMzRuntime(context, { probe, attempts: 1, delayMs: 0 })).resolves.toBe(true);

    expect(await readFile(stopPath, "utf8")).toBe("runtime-one\n");
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  test("stops a managed supervisor while its Studio listener is in a restart gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-stop-restart-gap-"));
    const bindingPath = join(root, "runtime.json");
    const stopPath = join(root, "control", "runtime.stop");
    await writeMzBinding(bindingPath, {
      schemaVersion: 1,
      runtimeId: "runtime-one",
      projectRoot: "/repo/one",
      url: "http://127.0.0.1:4999",
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc",
      remoteTuiCapabilities: descriptor("/repo/one").remoteTuiCapabilities,
      remoteTuiSubagents: descriptor("/repo/one").remoteTuiSubagents,
      managed: true,
      pid: 42,
      stopPath,
    });
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return undefined;
      if (calls === 2) return descriptor("/repo/one");
      return undefined;
    });
    const context = {
      projectRoot: "/repo/one",
      registryDirectory: root,
      bindingPath,
      manager: {} as MzRuntimeManager,
    };

    await expect(stopMzRuntime(context, { probe, attempts: 3, delayMs: 0 })).resolves.toBe(true);
    expect(await readFile(stopPath, "utf8")).toBe("runtime-one\n");
  });
});

describe("Studio workflow reload", () => {
  test("raises a typed restart signal while retaining the mounted generation", async () => {
    const mastra = { addAgent: vi.fn(), removeAgent: vi.fn(), addWorkflow: vi.fn() };
    const registry = new MastraProjectHostRegistry(mastra as never);
    const generation = (id: number, workflowGeneration: string) => ({
      generation: {
        id,
        specialists: new Map(),
        specialistAgents: new Map(),
        workflows: new Map([["flow", { id: "flow", generation: workflowGeneration, workflow: {} }]]),
        tools: {},
      },
    });
    const initial = await registry.prepare(generation(1, "sha256:a") as never);
    await initial.commit();

    await expect(registry.prepare(generation(2, "sha256:b") as never))
      .rejects.toBeInstanceOf(ProjectWorkflowRestartRequiredError);
    expect(mastra.addWorkflow).toHaveBeenCalledTimes(1);
  });

  test("requires restart when the first workflow is added after an empty initial mount", async () => {
    const mastra = { addAgent: vi.fn(), removeAgent: vi.fn(), addWorkflow: vi.fn() };
    const registry = new MastraProjectHostRegistry(mastra as never);
    const empty = {
      generation: {
        id: 1,
        specialists: new Map(),
        specialistAgents: new Map(),
        workflows: new Map(),
        tools: {},
      },
    };
    const withWorkflow = {
      generation: {
        ...empty.generation,
        id: 2,
        workflows: new Map([["flow", { id: "flow", generation: "sha256:a", workflow: {} }]]),
      },
    };
    const initial = await registry.prepare(empty as never);
    await initial.commit();

    await expect(registry.prepare(withWorkflow as never))
      .rejects.toBeInstanceOf(ProjectWorkflowRestartRequiredError);
    expect(mastra.addWorkflow).not.toHaveBeenCalled();
  });
});
