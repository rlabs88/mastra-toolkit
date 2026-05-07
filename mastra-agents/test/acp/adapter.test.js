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

function optionValue(configOptions, id) {
  return configOptions.find((option) => option.id === id)?.currentValue;
}

function sseOk() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, statusText: "OK" },
  );
}

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
}

function installForkFetchMock(t, { cloneThreadId, cloneResourceId = "resource-1", failClone = false } = {}) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    requests.push({ url: href, init });

    if (href.includes("/api/agents/")) {
      return jsonOk({ provider: "provider", modelId: "model" });
    }

    if (href.includes("/api/memory/threads/") && href.includes("/clone")) {
      if (failClone) return new Response("clone unavailable", { status: 503, statusText: "Unavailable" });
      const body = JSON.parse(init.body);
      return jsonOk({
        thread: {
          id: cloneThreadId ?? body.newThreadId,
          resourceId: cloneResourceId,
          metadata: body.metadata,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        clonedMessages: [],
      });
    }

    if (href.includes("/api/agents/") && href.includes("/stream")) {
      return sseOk();
    }

    return sseOk();
  };
  return requests;
}

test("ACP initialize advertises fork session capability", async () => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
  });

  const result = await agent.initialize({ protocolVersion: 1 });

  assert.deepEqual(result.agentCapabilities.sessionCapabilities, { fork: {} });
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

test("ACP fork clones parent memory thread and child prompt uses cloned thread", async (t) => {
  const requests = installForkFetchMock(t);
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
    defaultResourceId: "resource-1",
    defaultThreadId: "parent-thread",
  });
  const parent = await agent.newSession({ cwd: "/workspace", mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId: parent.sessionId, configId: "mode", value: "exec" });
  await agent.setSessionConfigOption({ sessionId: parent.sessionId, configId: "thinking", value: "high" });

  const child = await agent.unstable_forkSession({
    sessionId: parent.sessionId,
    cwd: "/workspace",
    mcpServers: [],
  });

  assert.notEqual(child.sessionId, parent.sessionId);
  assert.equal(optionValue(child.configOptions, "mode"), "exec");
  assert.equal(optionValue(child.configOptions, "thinking"), "high");

  const cloneRequest = requests.find((request) => request.url.includes("/api/memory/threads/parent-thread/clone"));
  assert.ok(cloneRequest);
  assert.equal(cloneRequest.url, "http://mastra.test/api/memory/threads/parent-thread/clone?agentId=supervisor-agent");

  const cloneBody = JSON.parse(cloneRequest.init.body);
  assert.equal(cloneBody.resourceId, "resource-1");
  assert.match(cloneBody.newThreadId, /^acp:.+:supervisor-agent$/);
  assert.equal(cloneBody.metadata.acp.fork.parentSessionId, parent.sessionId);
  assert.equal(cloneBody.metadata.acp.fork.childSessionId, child.sessionId);
  assert.equal(cloneBody.metadata.acp.fork.parentThreadId, "parent-thread");
  assert.equal(cloneBody.metadata.acp.fork.agentId, "supervisor-agent");

  let childPromptRequest;
  let parentPromptRequest;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/api/agents/") && href.includes("/stream")) {
      const body = JSON.parse(init.body);
      if (body.requestContext.acp.sessionId === child.sessionId) childPromptRequest = body;
      if (body.requestContext.acp.sessionId === parent.sessionId) parentPromptRequest = body;
      return sseOk();
    }
    return jsonOk({ provider: "provider", modelId: "model" });
  };

  await agent.prompt({ sessionId: child.sessionId, prompt: [{ type: "text", text: "child" }] });
  await agent.prompt({ sessionId: parent.sessionId, prompt: [{ type: "text", text: "parent" }] });

  assert.equal(childPromptRequest.memory.thread, cloneBody.newThreadId);
  assert.equal(childPromptRequest.memory.resource, "resource-1");
  assert.equal(parentPromptRequest.memory.thread, "parent-thread");
  assert.equal(parentPromptRequest.memory.resource, "resource-1");
});

test("ACP fork rejects unknown parent session", async () => {
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
  });

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: "missing", cwd: "/workspace", mcpServers: [] }),
    /Unknown session: missing/,
  );
});

test("ACP fork rejects cwd mismatch before cloning", async (t) => {
  const requests = installForkFetchMock(t);
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const parent = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: parent.sessionId, cwd: "/other", mcpServers: [] }),
    /cwd mismatch/,
  );
  assert.equal(requests.some((request) => request.url.includes("/clone")), false);
});

test("ACP fork rejects clone response thread mismatch", async (t) => {
  installForkFetchMock(t, { cloneThreadId: "wrong-thread" });
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const parent = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: parent.sessionId, cwd: "/workspace", mcpServers: [] }),
    /unexpected thread id: wrong-thread/,
  );
});

test("ACP fork rejects clone response resource mismatch", async (t) => {
  installForkFetchMock(t, { cloneResourceId: "wrong-resource" });
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
    defaultResourceId: "resource-1",
  });
  const parent = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: parent.sessionId, cwd: "/workspace", mcpServers: [] }),
    /unexpected resource id: wrong-resource/,
  );
});

test("ACP fork surfaces clone endpoint failures", async (t) => {
  installForkFetchMock(t, { failClone: true });
  const conn = new FakeConnection();
  const agent = createMastraAcpAgentHandler(conn, {
    agentId: "supervisor-agent",
    cwd: "/workspace",
    mastraBaseUrl: "http://mastra.test",
  });
  const parent = await agent.newSession({ cwd: "/workspace", mcpServers: [] });

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: parent.sessionId, cwd: "/workspace", mcpServers: [] }),
    /Mastra memory clone failed.*503 Unavailable/,
  );
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
  assert.equal(config.models.includes("openai/gpt-5.5"), false);
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
