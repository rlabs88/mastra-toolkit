import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
const openProxyServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(openProxyServers.splice(0).map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()),
  )));
});

async function startOpenAiCompatibleProxy(): Promise<{
  readonly baseUrl: string;
  readonly requestedModels: string[];
}> {
  const requestedModels: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
    if (typeof body.model === "string") requestedModels.push(body.model);

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: "test-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "test-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  openProxyServers.push(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local proxy TCP address");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requestedModels };
}

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
      observationThreshold: 90_000,
      reflectionThreshold: 60_000,
    });
    expect(runtime.mastra.getAgent("cortex").id).toBe(runtime.agents.cortex.id);
    expect(runtime.mastra.getAgent("flux").id).toBe(runtime.agents.flux.id);
    expect(runtime.mastra.getAgent("zen").id).toBe(runtime.agents.zen.id);
    expect(runtime.controller.getCurrentAgent(runtime.session)).toBe(runtime.agents.cortex);
    expect(runtime.resources.snapshot().id).toBe(1);

    const info: string[] = [];
    const unsubscribe = runtime.session.subscribe(event => {
      if (event.type === "info") info.push(event.message);
    });
    runtime.session.emit({
      type: "tool_start",
      toolCallId: "acceptance-search",
      toolName: "search_content",
      args: { query: "DEFAULT_OBSERVER_ALIAS" },
    });
    runtime.session.emit({
      type: "tool_end",
      toolCallId: "acceptance-search",
      result: { matches: [] },
      isError: false,
    });
    await vi.waitFor(() => expect(info).toHaveLength(1));
    expect(info[0]).toMatch(/^Tool · search_content completed in \d+ ms · waiting for model continuation…$/);
    unsubscribe();
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

  test("dispatches the active selected A1 alias to the local proxy", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mastra-code-model-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "mastra-code-model-data-"));
    const proxy = await startOpenAiCompatibleProxy();
    await execFileAsync("git", ["init", "--quiet", projectRoot]);
    const profile = structuredClone(loadModelProfile());
    profile.provider.baseUrl = proxy.baseUrl;

    const runtime = await createLocalMcodeRuntime({
      cwd: projectRoot,
      dataDirectory,
      profile,
      browser: false,
      disableMcp: true,
      watch: false,
      memory: false,
      environment: {
        ...process.env,
        PROXY_BASE_URL: proxy.baseUrl,
        CLI_PROXY_API_KEY: "test-only-key",
      },
    });
    openRuntimes.push(runtime);

    await runtime.session.model.switch({ modelId: "a1-proxy/code-economic" });
    expect(runtime.session.model.get()).toBe("a1-proxy/code-economic");
    await runtime.session.sendMessage({ content: "Reply with ok." });
    expect(proxy.requestedModels).toEqual(["code-economic"]);

    await runtime.session.model.switch({ modelId: "a1-proxy/code-frontier-high" });
    expect(runtime.session.model.get()).toBe("a1-proxy/code-frontier-high");
    await runtime.session.sendMessage({ content: "Reply with ok again." });
    expect(proxy.requestedModels).toEqual(["code-economic", "code-frontier-high"]);

    const availableModelIds = (await runtime.controller.listAvailableModels()).map(model => model.id);
    expect(availableModelIds).toContain("a1-proxy/code-economic");
    expect(availableModelIds).toContain("a1-proxy/code-frontier-high");
    expect(availableModelIds).not.toContain("openai/gpt-5.6-sol");
    await expect(runtime.session.model.switch({ modelId: "openai/gpt-5.6-sol" }))
      .rejects.toThrow(/declared A1 model alias/i);
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
