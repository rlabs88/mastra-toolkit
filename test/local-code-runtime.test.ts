import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CODE_MODE_IDS } from "@rlabs/mcode";
import {
  createLocalMcodeRuntime,
  type LocalMcodeRuntime,
} from "@rlabs/mcode";
import { loadModelProfile } from "@rlabs/runtime-config";
import { startDynamicWorkflowBackgroundTaskObserver } from "../packages/mcode/src/background-task-observer.js";

const execFileAsync = promisify(execFile);
const openRuntimes: LocalMcodeRuntime[] = [];

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map(runtime => runtime.close()));
});

describe("local Mastra Code runtime", () => {
  test("boots the canonical agents and modes at the containing Git checkout", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mastra-code-project-"));
    const nestedCwd = join(projectRoot, "packages", "app");
    const dataDirectory = await mkdtemp(join(tmpdir(), "mastra-code-data-"));
    await execFileAsync("git", ["init", "--quiet", projectRoot]);
    await mkdir(nestedCwd, { recursive: true });

    const runtime = await createLocalMcodeRuntime({
      cwd: nestedCwd,
      dataDirectory,
      browser: false,
      disableMcp: true,
      watch: false,
      environment: {
        ...process.env,
        CLI_PROXY_API_KEY: "test-only-key",
      },
    });
    openRuntimes.push(runtime);

    expect(runtime.project.rootPath).toBe(await realpath(projectRoot));
    expect(runtime.controller.getMastra()).toBe(runtime.mastra);
    expect(runtime.controller.listModes().map(mode => mode.id)).toEqual(CODE_MODE_IDS);
    expect(runtime.session.mode.get()).toBe("cortex/build");
    expect(runtime.session.state.get()).toMatchObject({
      // Retuned to 180k in #174; upstream reads this as
      // `observation.messageTokens`. reflectionThreshold is a separate
      // upstream setting (`reflection.observationTokens`) and is unchanged.
      observationThreshold: 180_000,
      reflectionThreshold: 60_000,
    });
    expect(runtime.mastra.getAgent("cortex").id).toBe(runtime.agents.cortex.id);
    expect(runtime.mastra.getAgent("flux").id).toBe(runtime.agents.flux.id);
    expect(runtime.mastra.getAgent("zen").id).toBe(runtime.agents.zen.id);
    expect(runtime.controller.getCurrentAgent(runtime.session)).toBe(runtime.agents.cortex);
    expect(runtime.resources.snapshot().id).toBe(1);
  });

  test("uses one caller-supplied profile for CLI configuration and mounting", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mastra-code-profile-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "mastra-code-profile-data-"));
    await execFileAsync("git", ["init", "--quiet", projectRoot]);
    const profile = structuredClone(loadModelProfile());
    profile.aliases.push("startup-only");

    const runtime = await createLocalMcodeRuntime({
      cwd: projectRoot,
      dataDirectory,
      profile,
      browser: false,
      disableMcp: true,
      watch: false,
      environment: {
        ...process.env,
        PROXY_MODEL: "startup-only",
        CLI_PROXY_API_KEY: "test-only-key",
      },
    });
    openRuntimes.push(runtime);

    expect(runtime.config.runtime.proxy.model).toBe("startup-only");
  });

  test("projects manager output onto the human session bus without persisting it", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mastra-code-observer-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "mastra-code-observer-data-"));
    await execFileAsync("git", ["init", "--quiet", projectRoot]);
    const runtime = await createLocalMcodeRuntime({
      cwd: projectRoot,
      dataDirectory,
      browser: false,
      disableMcp: true,
      watch: false,
      environment: {
        ...process.env,
        CLI_PROXY_API_KEY: "test-only-key",
      },
    });
    openRuntimes.push(runtime);
    await runtime.session.thread.create({ id: "observer-thread" });
    const messagesBefore = await runtime.session.thread.listActiveMessages();
    const info: string[] = [];
    const unsubscribe = runtime.session.subscribe(event => {
      if (event.type === "info") info.push(event.message);
    });
    const manager = runtime.mastra.backgroundTaskManager;
    if (!manager) throw new Error("Expected the local background task manager");
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager,
      resourceId: runtime.session.identity.getResourceId(),
      emit: event => runtime.session.emit(event),
    });
    const base = {
      id: "task-1",
      status: "running",
      toolCallId: "call-1",
      args: { action: "run" },
      agentId: "cortex",
      threadId: "thread-1",
      resourceId: runtime.project.resourceId,
      runId: "run-1",
      createdAt: new Date(),
      startedAt: new Date(),
      retryCount: 0,
      maxRetries: 0,
      timeoutMs: 30_000,
    } as const;

    await manager.publishLifecycleEvent("task.output", {
      ...base,
      toolName: "another_tool",
      chunk: { type: "tool-output", payload: { ignored: true } } as never,
    });
    await manager.publishLifecycleEvent("task.output", {
      ...base,
      toolName: "dynamic_workflow",
      chunk: {
        type: "tool-output",
        payload: {
          type: "workflow-step-output",
          payload: { stepName: "research", output: { text: "visible to the human" } },
        },
      } as never,
    });

    await vi.waitFor(() => expect(info).toHaveLength(1));
    expect(info[0]).toContain("background-task-output");
    expect(info[0]).toContain("workflow-step-output");
    expect(info[0]).toContain("visible to the human");
    expect(info[0]).not.toContain("ignored");
    expect(await runtime.session.thread.listActiveMessages()).toEqual(messagesBefore);
    expect(JSON.stringify(await runtime.session.thread.listActiveMessages())).not.toContain("visible to the human");
    await observer.close();
    unsubscribe();
  });
});
