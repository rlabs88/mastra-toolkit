import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AgentChannels } from "@mastra/core/channels";

const packageRoot = path.resolve(import.meta.dirname, "../../..");
const bundleDir = path.join(packageRoot, ".cache/channels-test");
const bundlePath = path.join(bundleDir, "channels.mjs");
const linearBundlePath = path.join(bundleDir, "linear.mjs");
const streamBridgeBundlePath = path.join(bundleDir, "stream-bridge.mjs");
const esbuildBin = path.resolve(packageRoot, "../node_modules/.bin/esbuild");
const publicChannelAgentId = "supervisor-agent";
let importCounter = 0;

async function importFresh(filePath) {
  importCounter += 1;
  return import(`${pathToFileURL(filePath).href}?v=${importCounter}`);
}

function buildChannelsBundle() {
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  execFileSync(esbuildBin, [
    "src/adapters/channels/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
    "--external:@chat-adapter/*",
    "--external:@mastra/core/*",
    "--external:chat",
  ], { cwd: packageRoot, stdio: "pipe" });
  execFileSync(esbuildBin, [
    "src/adapters/channels/linear/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${linearBundlePath}`,
    "--external:@chat-adapter/*",
    "--external:@mastra/core/*",
    "--external:chat",
  ], { cwd: packageRoot, stdio: "pipe" });
  execFileSync(esbuildBin, [
    "src/adapters/channels/stream-bridge.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${streamBridgeBundlePath}`,
  ], { cwd: packageRoot, stdio: "pipe" });
}

function readChannelState(env) {
  const script = `
    import { Agent } from "@mastra/core/agent";
    import { pathToFileURL } from "node:url";

    const channels = await import(pathToFileURL(${JSON.stringify(bundlePath)}));
    const channelConfig = channels.initChannels();
    const agent = new Agent({
      id: ${JSON.stringify(publicChannelAgentId)},
      name: "Supervisor",
      instructions: "test",
      model: () => {
        throw new Error("model should not be resolved during route inspection");
      },
      channels: channelConfig,
    });
    const orchestratorAgent = new Agent({
      id: "orchestrator-agent",
      name: "Orchestrator",
      instructions: "test",
      model: () => {
        throw new Error("model should not be resolved during route inspection");
      },
    });
    const routes = agent.getChannels()?.getWebhookRoutes().map((route) => ({
      method: route.method,
      path: route.path,
    })) ?? [];
    const orchestratorRoutes = orchestratorAgent.getChannels?.()?.getWebhookRoutes?.() ?? [];
    const apiRoutes = channels.channelWebhookApiRoutesForAgents({ supervisorAgent: agent, orchestratorAgent }).map((route) => ({
      method: route.method,
      path: route.path,
      internal: route._mastraInternal,
    }));
    const linearConfig = channelConfig?.adapters?.linear;
    const linearAdapter = linearConfig?.adapter ?? linearConfig;
    const sampleToolMessage = linearConfig?.formatToolCall?.({
      toolName: "read_file",
      args: { path: "src/example.ts" },
      result: "export const value = 1;",
    });
    const sampleErrorMessage = linearConfig?.formatError?.(new Error("boom"));
    console.log(JSON.stringify({
      enabled: channels.listEnabledChannelPlatforms(),
      expected: channels.expectedChannelWebhookRoutes(${JSON.stringify(publicChannelAgentId)}).map(({ method, path }) => ({ method, path })),
      supervisorExpected: channels.expectedChannelWebhookRoutes("supervisor-agent").map(({ method, path }) => ({ method, path })),
      apiRoutes,
      orchestratorRoutes,
      routes,
      status: channels.resolveAgentChannelStatus(),
      hasHandlers: Boolean(channelConfig?.handlers?.onMention),
      linearAdapter: linearConfig ? {
        mode: linearAdapter?.mode,
        cards: linearConfig.cards,
        hasFormatToolCall: typeof linearConfig.formatToolCall === "function",
        hasFormatError: typeof linearConfig.formatError === "function",
        sampleToolMessage,
        sampleErrorMessage,
        hasDefaultClient: Boolean(linearAdapter?.defaultClient),
        hasClientCredentials: Boolean(linearAdapter?.clientCredentials),
        hasOAuthClient: Boolean(linearAdapter?.oauthClientId),
      } : null,
    }));
    process.exit(0);
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

test("channel status requires webhook secrets and auth before enabling adapters", () => {
  buildChannelsBundle();
  const state = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    ENABLE_GITHUB_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "",
    SLACK_BOT_TOKEN: "",
    SLACK_CLIENT_ID: "",
    SLACK_CLIENT_SECRET: "",
    GITHUB_WEBHOOK_SECRET: "",
    GITHUB_TOKEN: "",
    GITHUB_APP_ID: "",
    GITHUB_PRIVATE_KEY: "",
    LINEAR_WEBHOOK_SECRET: "",
    LINEAR_API_KEY: "",
    LINEAR_ACCESS_TOKEN: "",
    LINEAR_CLIENT_ID: "",
    LINEAR_CLIENT_SECRET: "",
    LINEAR_CLIENT_CREDENTIALS_CLIENT_ID: "",
    LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET: "",
  });

  assert.deepEqual(state.enabled, []);
  assert.equal(state.status.slack.enabled, false);
  assert.equal(state.status.github.enabled, false);
  assert.equal(state.status.linear.enabled, false);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.orchestratorRoutes, []);
});

test("enabled channels generate supervisor webhook routes", () => {
  buildChannelsBundle();
  const state = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    ENABLE_GITHUB_CHANNEL: "true",
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITHUB_TOKEN: "github-token",
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    LINEAR_API_KEY: "linear-api-key",
    LINEAR_CHANNEL_MODE: "comments",
  });

  assert.deepEqual(state.enabled, ["slack", "github", "linear"]);
  assert.deepEqual(state.expected, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/linear/webhook" },
  ]);
  assert.deepEqual(state.routes, state.expected);
  assert.deepEqual(state.apiRoutes, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook", internal: true },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook", internal: true },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/linear/webhook", internal: true },
  ]);
  assert.deepEqual(state.supervisorExpected, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/linear/webhook" },
  ]);
  assert.equal(state.status.linear.mode, "comments");
  assert.equal(state.hasHandlers, true);
  assert.equal(state.linearAdapter.cards, true);
  assert.equal(state.linearAdapter.hasFormatToolCall, true);
  assert.equal(state.linearAdapter.hasFormatError, true);
  assert.match(state.linearAdapter.sampleToolMessage, /Tool completed: Read file/);
  assert.match(state.linearAdapter.sampleToolMessage, /src\/example\.ts/);
  assert.match(state.linearAdapter.sampleErrorMessage, /Error/);
  assert.deepEqual(state.orchestratorRoutes, []);
});

test("Slack and GitHub channel connectors are gated independently", () => {
  buildChannelsBundle();
  const slackOnly = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    ENABLE_GITHUB_CHANNEL: "true",
    GITHUB_WEBHOOK_SECRET: "",
    GITHUB_TOKEN: "github-token",
    LINEAR_WEBHOOK_SECRET: "",
    LINEAR_API_KEY: "",
  });
  const githubOnly = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "",
    SLACK_BOT_TOKEN: "xoxb-test",
    ENABLE_GITHUB_CHANNEL: "true",
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITHUB_TOKEN: "github-token",
    LINEAR_WEBHOOK_SECRET: "",
    LINEAR_API_KEY: "",
  });

  assert.deepEqual(slackOnly.enabled, ["slack"]);
  assert.deepEqual(slackOnly.routes, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook" },
  ]);
  assert.deepEqual(githubOnly.enabled, ["github"]);
  assert.deepEqual(githubOnly.routes, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook" },
  ]);
});

test("Linear multi-tenant OAuth credentials take precedence over API key fallback", () => {
  buildChannelsBundle();
  const state = readChannelState({
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    LINEAR_API_KEY: "stale-local-api-key",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    LINEAR_CHANNEL_MODE: "agent-sessions",
  });

  assert.deepEqual(state.enabled, ["linear"]);
  assert.equal(state.status.linear.mode, "agent-sessions");
  assert.deepEqual(state.linearAdapter, {
    mode: "agent-sessions",
    cards: true,
    hasFormatToolCall: true,
    hasFormatError: true,
    sampleToolMessage: state.linearAdapter.sampleToolMessage,
    sampleErrorMessage: state.linearAdapter.sampleErrorMessage,
    hasDefaultClient: false,
    hasClientCredentials: false,
    hasOAuthClient: true,
  });
  assert.match(state.linearAdapter.sampleToolMessage, /Tool completed: Read file/);
  assert.match(state.linearAdapter.sampleErrorMessage, /boom/);
});

test("adapter-agnostic stream bridge maps Mastra runtime events to Chat SDK chunks", async () => {
  buildChannelsBundle();
  const streamBridge = await import(pathToFileURL(streamBridgeBundlePath));
  const linear = await import(pathToFileURL(linearBundlePath));

  const toolCall = {
    type: "tool-call",
    payload: {
      toolCallId: "call-1",
      toolName: "git_snapshot_query",
      args: { query: "changed files" },
    },
  };

  assert.deepEqual(streamBridge.mastraChunkToChatStreamChunk(toolCall), {
    type: "task_update",
    id: "call-1",
    title: "git snapshot query",
    details: "{ \"query\": \"changed files\" }",
    status: "in_progress",
  });
  assert.deepEqual(linear.mastraChunkToLinearStreamChunk(toolCall), streamBridge.mastraChunkToChatStreamChunk(toolCall));

  assert.deepEqual(streamBridge.mastraChunkToChatStreamChunk({
    type: "tool-result",
    payload: {
      toolCallId: "call-1",
      toolName: "git_snapshot_query",
      result: { files: ["src/a.ts"] },
    },
  }), {
    type: "task_update",
    id: "call-1",
    title: "git snapshot query",
    output: "{\n  \"files\": [\n    \"src/a.ts\"\n  ]\n}",
    status: "complete",
  });

  assert.deepEqual(streamBridge.mastraChunkToChatStreamChunk({
    type: "text-delta",
    payload: { text: "linear deployed smoke ok with spaces" },
  }), {
    type: "markdown_text",
    text: "linear deployed smoke ok with spaces",
  });

  assert.deepEqual(streamBridge.mastraChunkToChatStreamChunk({
    type: "reasoning-delta",
    payload: { text: "checking workspace context" },
  }), {
    type: "markdown_text",
    text: "checking workspace context",
  });

  assert.equal(streamBridge.mastraChunkToChatStreamChunk({ type: "finish", payload: {} }), null);
});

test("Linear message text sanitizer removes Linear mention XML artifacts", async () => {
  buildChannelsBundle();
  const linear = await importFresh(linearBundlePath);

  assert.equal(
    linear.sanitizeLinearMessageText('<user id="ba4ef845-b543-4af7-a534-ebc8abb7d741">palmer</user> reply with spaces'),
    "@palmer reply with spaces",
  );
  assert.equal(
    linear.sanitizeLinearMessageText("before <custom>artifact</custom> after"),
    "before artifact after",
  );
});

test("Linear agent-session streams are posted through Chat SDK rich streaming", async () => {
  buildChannelsBundle();
  const originalConsume = AgentChannels.prototype.consumeAgentStream;
  const originalMarker = AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];
  const fallbackCalls = [];

  AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = false;
  AgentChannels.prototype.consumeAgentStream = async (...args) => {
    fallbackCalls.push(args);
    return "fallback";
  };

  try {
    const channels = await importFresh(bundlePath);
    channels.installLinearRichStreaming();

    const posted = [];
    const result = await AgentChannels.prototype.consumeAgentStream(
      {
        fullStream: (async function* () {
          yield {
            type: "step-start",
            payload: {},
          };
          yield {
            type: "reasoning-delta",
            payload: { text: "checking context" },
          };
          yield {
            type: "tool-call",
            payload: {
              toolCallId: "call-1",
              toolName: "git_snapshot_query",
              args: { query: "changed files" },
            },
          };
          yield {
            type: "tool-result",
            payload: {
              toolCallId: "call-1",
              toolName: "git_snapshot_query",
              result: { files: ["src/a.ts"] },
            },
          };
          yield {
            type: "text-delta",
            payload: { text: "linear deployed smoke ok " },
          };
          yield {
            type: "text-delta",
            payload: { text: "with preserved spaces" },
          };
        })(),
      },
      {
        id: "linear:issue-1:c:comment-1:s:session-1",
        post: async (message) => {
          posted.push(message);
          return { id: "activity-1" };
        },
      },
      "linear",
    );

    assert.deepEqual(result, { id: "activity-1" });
    assert.equal(fallbackCalls.length, 0);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].kind, "stream");

    const chunks = [];
    for await (const chunk of posted[0].stream) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, [
      { type: "plan_update", title: "Working" },
      { type: "markdown_text", text: "checking context" },
      {
        type: "task_update",
        id: "call-1",
        title: "git snapshot query",
        details: "{ \"query\": \"changed files\" }",
        status: "in_progress",
      },
      {
        type: "task_update",
        id: "call-1",
        title: "git snapshot query",
        output: "{\n  \"files\": [\n    \"src/a.ts\"\n  ]\n}",
        status: "complete",
      },
      { type: "markdown_text", text: "linear deployed smoke ok " },
      { type: "markdown_text", text: "with preserved spaces" },
    ]);
  } finally {
    AgentChannels.prototype.consumeAgentStream = originalConsume;
    if (originalMarker === undefined) {
      delete AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];
    } else {
      AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = originalMarker;
    }
  }
});

test("Linear rich streaming wrapper logs stream and tool timing", async () => {
  buildChannelsBundle();
  const originalConsume = AgentChannels.prototype.consumeAgentStream;
  const originalMarker = AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];
  const logs = [];

  AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = false;
  AgentChannels.prototype.consumeAgentStream = async () => {
    throw new Error("fallback should not run");
  };

  try {
    const channels = await importFresh(bundlePath);
    channels.installLinearRichStreaming();

    await AgentChannels.prototype.consumeAgentStream.call(
      {
        logger: {
          info: (message, args) => logs.push({ level: "info", message, args }),
          error: (message, args) => logs.push({ level: "error", message, args }),
        },
      },
      {
        fullStream: (async function* () {
          yield { type: "tool-call", payload: { toolCallId: "call-1", toolName: "read_file", args: {} } };
          yield { type: "tool-result", payload: { toolCallId: "call-1", toolName: "read_file", result: "ok" } };
          yield { type: "text-delta", payload: { text: "done" } };
        })(),
      },
      {
        id: "linear:issue-1:s:session-1",
        post: async (message) => {
          for await (const _chunk of message.stream) {
            // Drain the stream so observability hooks run.
          }
          return { id: "activity-1" };
        },
      },
      "linear",
    );

    assert.deepEqual(logs.map((log) => log.message), [
      "[linear-rich-stream] start",
      "[linear-rich-stream] tool call start",
      "[linear-rich-stream] tool call finish",
      "[linear-rich-stream] first response text",
      "[linear-rich-stream] complete",
    ]);
    assert.equal(logs[1].args.toolCallId, "call-1");
    assert.equal(logs[2].args.status, "complete");
    assert.equal(typeof logs[4].args.durationMs, "number");
  } finally {
    AgentChannels.prototype.consumeAgentStream = originalConsume;
    if (originalMarker === undefined) {
      delete AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];
    } else {
      AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = originalMarker;
    }
  }
});

test("Linear rich streaming wrapper delegates non-agent-session and approval paths", async () => {
  buildChannelsBundle();
  const originalConsume = AgentChannels.prototype.consumeAgentStream;
  const originalMarker = AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];
  const fallbackCalls = [];

  AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = false;
  AgentChannels.prototype.consumeAgentStream = async (...args) => {
    fallbackCalls.push(args);
    return "fallback";
  };

  try {
    const channels = await importFresh(bundlePath);
    channels.installLinearRichStreaming();
    const stream = { fullStream: (async function* () {})() };
    const thread = {
      id: "linear:issue-1:c:comment-1",
      post: async () => {
        throw new Error("rich stream should not post for comments mode");
      },
    };

    assert.equal(await AgentChannels.prototype.consumeAgentStream(stream, thread, "linear"), "fallback");
    assert.equal(await AgentChannels.prototype.consumeAgentStream(stream, {
      id: "linear:issue-1:s:session-1",
      post: async () => {
        throw new Error("rich stream should not post for approval resume");
      },
    }, "linear", { toolCallId: "call-1" }), "fallback");
    assert.equal(await AgentChannels.prototype.consumeAgentStream(stream, {
      id: "slack:C123:1",
      post: async () => {
        throw new Error("rich stream should not post for Slack");
      },
    }, "slack"), "fallback");

    assert.equal(fallbackCalls.length, 3);
  } finally {
    AgentChannels.prototype.consumeAgentStream = originalConsume;
    if (originalMarker === undefined) {
      delete AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];
    } else {
      AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = originalMarker;
    }
  }
});

test("Linear rich streaming wrapper tolerates final activity source-comment parse failure", async () => {
  buildChannelsBundle();
  const originalConsume = AgentChannels.prototype.consumeAgentStream;
  const originalMarker = AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];

  AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = false;
  AgentChannels.prototype.consumeAgentStream = async () => {
    throw new Error("fallback should not run");
  };

  try {
    const channels = await importFresh(bundlePath);
    channels.installLinearRichStreaming();

    await assert.doesNotReject(() => AgentChannels.prototype.consumeAgentStream(
      { fullStream: (async function* () {})() },
      {
        id: "linear:issue-1:s:session-1",
        post: async () => {
          throw new Error("Failed to resolve source comment for Linear agent activity activity-1");
        },
      },
      "linear",
    ));
  } finally {
    AgentChannels.prototype.consumeAgentStream = originalConsume;
    if (originalMarker === undefined) {
      delete AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")];
    } else {
      AgentChannels.prototype[Symbol.for("mastra-system.linear-rich-streaming-installed")] = originalMarker;
    }
  }
});
