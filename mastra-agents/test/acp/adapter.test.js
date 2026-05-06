import assert from "node:assert/strict";
import test from "node:test";

import { createMastraAcpAgentHandler } from "../../../compiled/mastra-agents/acp/adapter.js";
import { loadAcpRuntimeConfig } from "../../../compiled/mastra-agents/acp/config-options.js";

class FakeConnection {
  updates = [];

  async sessionUpdate(update) {
    this.updates.push(update);
  }
}

class FakeMemoryStore {
  threads = new Map();

  constructor(threads = []) {
    for (const thread of threads) this.threads.set(thread.id, thread);
  }

  async getThreadById({ threadId }) {
    return this.threads.get(threadId) ?? null;
  }

  async saveThread({ thread }) {
    this.threads.set(thread.id, thread);
    return thread;
  }
}

function optionValue(configOptions, id) {
  return configOptions.find((option) => option.id === id)?.currentValue;
}

test("ACP initialize advertises load and close session recovery primitives", async () => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
  });

  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

  assert.equal(response.agentCapabilities.loadSession, true);
  assert.deepEqual(response.agentCapabilities.sessionCapabilities, { close: {} });
});

test("ACP session config exposes complete canonical mode and model defaults", async () => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
  });

  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  assert.equal(session.modes.currentModeId, "base");
  assert.equal(optionValue(session.configOptions, "mode"), "base");
  assert.equal(optionValue(session.configOptions, "model"), session.models.currentModelId);
  assert.deepEqual(session.configOptions.map((option) => option.id), ["mode", "model", "thinking"]);
});

test("ACP new sessions bind request cwd to fallback resource and opaque session thread", async (t) => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/default-cwd",
    mastraBaseUrl: "http://mastra.test",
  });
  const session = await agent.newSession({ cwd: "/request-workspace", mcpServers: [] });

  let capturedRequest;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, statusText: "OK" },
    );
  };

  await agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Do the work." }],
  });

  assert.equal(capturedRequest.memory.thread, session.sessionId);
  assert.match(capturedRequest.memory.resource, /^acp:workspace:[a-f0-9]{12}$/);
  assert.equal(capturedRequest.requestContext.acp.cwd, "/request-workspace");
});

test("ACP new sessions use configured WSL cwd when Windows clients send Windows cwd", async () => {
  const conn = new FakeConnection();
  const memoryStore = new FakeMemoryStore();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/container/shared/workspace/projects/mastra-system",
    mastraBaseUrl: "http://mastra.test",
    memoryStore,
  });

  const session = await agent.newSession({ cwd: "C:\\Users\\eugen", mcpServers: [] });
  const thread = memoryStore.threads.get(session.sessionId);

  assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(thread.metadata.acp.localCwd, "/container/shared/workspace/projects/mastra-system");
});

test("ACP loadSession restores durable Mastra memory thread binding", async (t) => {
  const conn = new FakeConnection();
  const memoryStore = new FakeMemoryStore([
    {
      id: "existing-session",
      resourceId: "linear:workspace:root-comment",
      metadata: {
        acp: {
          sessionId: "existing-session",
          agentId: "supervisor-agent",
          localCwd: "/workspace-a",
          threadId: "existing-session",
          resourceId: "linear:workspace:root-comment",
          resourceIdSource: "provided",
          modeId: "exec",
          modelId: "provider/custom-model",
          thinkingOptionId: "high",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]);
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace-a",
    mastraBaseUrl: "http://mastra.test",
    memoryStore,
  });

  await agent.loadSession({ sessionId: "existing-session", cwd: "/workspace-a", mcpServers: [] });

  let capturedRequest;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, statusText: "OK" },
    );
  };

  await agent.prompt({
    sessionId: "existing-session",
    prompt: [{ type: "text", text: "Continue." }],
  });

  assert.equal(capturedRequest.memory.thread, "existing-session");
  assert.equal(capturedRequest.memory.resource, "linear:workspace:root-comment");
  assert.equal(capturedRequest.requestContext.acp.cwd, "/workspace-a");
});

test("ACP loadSession creates a durable fallback thread when recovery target is missing", async () => {
  const conn = new FakeConnection();
  const memoryStore = new FakeMemoryStore();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace-a",
    memoryStore,
  });

  await agent.loadSession({ sessionId: "missing-session", cwd: "/workspace-a", mcpServers: [] });

  const thread = memoryStore.threads.get("missing-session");
  assert.equal(thread.id, "missing-session");
  assert.match(thread.resourceId, /^acp:workspace:[a-f0-9]{12}$/);
  assert.equal(thread.metadata.acp.localCwd, "/workspace-a");
  assert.equal(thread.metadata.acp.recoveredFromFallback, true);
});

test("ACP loadSession rejects durable thread cwd mismatches", async () => {
  const conn = new FakeConnection();
  const memoryStore = new FakeMemoryStore([
    {
      id: "existing-session",
      resourceId: "acp:workspace:stored",
      metadata: { acp: { sessionId: "existing-session", localCwd: "/workspace-a", threadId: "existing-session" } },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]);
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace-a",
    memoryStore,
  });

  await assert.rejects(
    agent.loadSession({ sessionId: "existing-session", cwd: "/workspace-b", mcpServers: [] }),
    /cwd mismatch/,
  );
});

test("ACP loadSession rejects durable thread resource mismatches", async () => {
  const conn = new FakeConnection();
  const memoryStore = new FakeMemoryStore([
    {
      id: "existing-session",
      resourceId: "acp:workspace:stored",
      metadata: { acp: { sessionId: "existing-session", localCwd: "/workspace", threadId: "existing-session" } },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]);
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    defaultResourceId: "acp:workspace:requested",
    memoryStore,
  });

  await assert.rejects(
    agent.loadSession({ sessionId: "existing-session", cwd: "/workspace", mcpServers: [] }),
    /resourceId mismatch/,
  );
});

test("ACP closeSession archives local session metadata without deleting durable memory", async () => {
  const conn = new FakeConnection();
  const memoryStore = new FakeMemoryStore();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    memoryStore,
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  await agent.closeSession({ sessionId: session.sessionId });

  const thread = memoryStore.threads.get(session.sessionId);
  assert.equal(thread.id, session.sessionId);
  assert.equal(thread.metadata.acp.status, "closed");
});

test("ACP mode config mutation returns full state and keeps legacy mode surface in sync", async () => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  const result = await agent.setSessionConfigOption({
    sessionId: session.sessionId,
    configId: "mode",
    value: "plan",
  });

  assert.deepEqual(result.configOptions.map((option) => option.id), ["mode", "model", "thinking"]);
  assert.equal(optionValue(result.configOptions, "mode"), "spec");

  const modeUpdate = conn.updates.find((entry) => entry.update.sessionUpdate === "current_mode_update");
  const configUpdate = conn.updates.findLast((entry) => entry.update.sessionUpdate === "config_option_update");
  assert.equal(modeUpdate.update.currentModeId, "spec");
  assert.equal(optionValue(configUpdate.update.configOptions, "mode"), "spec");
});

test("ACP prompt sends selected mode and model as live execution inputs", async (t) => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "mode", value: "exec" });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "provider/custom-model" });

  let capturedRequest;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, statusText: "OK" },
    );
  };

  await agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Do the work." }],
  });

  assert.equal(capturedRequest.model, "provider/custom-model");
  assert.equal(capturedRequest.requestContext.modelId, "provider/custom-model");
  assert.equal(capturedRequest.requestContext.harnessMode, "exec");
  assert.equal(capturedRequest.requestContext.harnessModeId, "supervisor.exec");
  assert.match(capturedRequest.messages[0].content, /Supervisor Lead Exec/);
});

test("ACP runtime config prefers explicit env model over API metadata fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalModel = process.env.MASTRA_SUPERVISOR_MODEL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalModel === undefined) {
      delete process.env.MASTRA_SUPERVISOR_MODEL;
    } else {
      process.env.MASTRA_SUPERVISOR_MODEL = originalModel;
    }
  });

  process.env.MASTRA_SUPERVISOR_MODEL = "proxy/openai/gpt-5.5";
  globalThis.fetch = async () => Response.json({ provider: "openai", modelId: "gpt-5.5" });

  const config = await loadAcpRuntimeConfig("supervisor-agent", "http://model-precedence.test");

  assert.equal(config.defaultModelId, "proxy/openai/gpt-5.5");
  assert.equal(config.models[0], "proxy/openai/gpt-5.5");
  assert.ok(config.models.includes("openai/gpt-5.5"));
});

test("ACP model config migrates legacy rl model ids to the configured default", async (t) => {
  const originalModel = process.env.MASTRA_SUPERVISOR_MODEL;
  t.after(() => {
    if (originalModel === undefined) {
      delete process.env.MASTRA_SUPERVISOR_MODEL;
    } else {
      process.env.MASTRA_SUPERVISOR_MODEL = originalModel;
    }
  });
  process.env.MASTRA_SUPERVISOR_MODEL = "proxy/openai/gpt-5.5";
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://legacy-model.test",
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  const result = await agent.setSessionConfigOption({
    sessionId: session.sessionId,
    configId: "model",
    value: "rl/gpt-5.5",
  });

  assert.equal(optionValue(result.configOptions, "model"), "proxy/openai/gpt-5.5");
});

test("ACP prompt surfaces Mastra stream error chunks", async (t) => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"error","payload":{"error":{"message":"Could not find API key process.env.OPENAI_API_KEY"}}}\n\n',
        ));
        controller.close();
      },
    }),
    { status: 200, statusText: "OK" },
  );

  await assert.rejects(
    agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Do the work." }],
    }),
    /Mastra stream error: Could not find API key process\.env\.OPENAI_API_KEY/,
  );
});

test("ACP prompt reports applied thinking metadata for OpenAI reasoning models", async (t) => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "openai/gpt-5.2" });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "thinking", value: "high" });

  let capturedRequest;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, statusText: "OK" },
    );
  };

  await agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Use deeper reasoning." }],
  });

  assert.deepEqual(capturedRequest.providerOptions, {
    openai: {
      reasoningEffort: "high",
    },
  });
  assert.deepEqual(capturedRequest.requestContext.acp.thinking, {
    requestedLevel: "high",
    status: "applied",
    provider: "openai",
    strategy: "provider_options",
    providerOptionPath: "providerOptions.openai.reasoningEffort",
    providerOptionValue: "high",
  });
});

test("ACP prompt maps proxy gateway thinking to CLIProxy model suffix", async (t) => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "proxy/openai/gpt-5.5" });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "thinking", value: "high" });

  let capturedRequest;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, statusText: "OK" },
    );
  };

  await agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Use proxy reasoning." }],
  });

  assert.equal(capturedRequest.model, "proxy/openai/gpt-5.5(high)");
  assert.equal(capturedRequest.providerOptions, undefined);
  assert.equal(capturedRequest.requestContext.modelId, "proxy/openai/gpt-5.5(high)");
  assert.equal(capturedRequest.requestContext.acp.selectedModelId, "proxy/openai/gpt-5.5");
  assert.deepEqual(capturedRequest.requestContext.acp.thinking, {
    requestedLevel: "high",
    status: "applied",
    provider: "proxy",
    strategy: "model_name_suffix",
    providerOptionPath: "model",
    providerOptionValue: "proxy/openai/gpt-5.5(high)",
  });
});

test("ACP prompt omits thinking providerOptions and reports unsupported provider", async (t) => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const session = await agent.newSession({ cwd: "/workspace", mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "minimax-coding-plan/MiniMax-M2.7" });
  await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "thinking", value: "high" });

  let capturedRequest;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, statusText: "OK" },
    );
  };

  await agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Use deeper reasoning." }],
  });

  assert.equal(capturedRequest.providerOptions, undefined);
  assert.deepEqual(capturedRequest.requestContext.acp.thinking, {
    requestedLevel: "high",
    status: "unsupported_provider",
    provider: "minimax-coding-plan",
    reason: "No ACP thinking mapping is defined for provider minimax-coding-plan",
  });
});
