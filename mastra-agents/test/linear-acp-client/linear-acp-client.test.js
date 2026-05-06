import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const bundleDir = path.join(packageRoot, ".cache/linear-acp-client-test");
const bundlePath = path.join(bundleDir, "linear-acp-client.mjs");
const esbuildBin = path.resolve(packageRoot, "../node_modules/.bin/esbuild");
let importCounter = 0;

async function importFresh() {
  importCounter += 1;
  return import(`${pathToFileURL(bundlePath).href}?v=${importCounter}`);
}

function buildLinearAcpClientBundle() {
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  execFileSync(esbuildBin, [
    "src/adapters/linear-acp-client/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
    "--external:@agentclientprotocol/sdk",
    "--external:@linear/sdk",
    "--external:@linear/sdk/webhooks",
    "--external:@mastra/core/*",
  ], { cwd: packageRoot, stdio: "pipe" });
}

test("linear-acp-client normalizes ACP message and tool updates into runtime events", async () => {
  buildLinearAcpClientBundle();
  const { normalizeAcpSessionUpdate } = await importFresh();

  const message = normalizeAcpSessionUpdate({
    linearAgentSessionId: "linear-session-1",
    acpSessionId: "acp-1",
    turnId: "turn-1",
    sequence: 1,
    notification: {
      sessionId: "acp-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    },
  });
  const tool = normalizeAcpSessionUpdate({
    linearAgentSessionId: "linear-session-1",
    acpSessionId: "acp-1",
    turnId: "turn-1",
    sequence: 2,
    notification: {
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "workspace.list-files",
        status: "completed",
        rawInput: { path: "." },
        rawOutput: ["README.md"],
      },
    },
  });

  assert.equal(message[0].type, "agent.response.delta");
  assert.equal(message[0].payload.text, "hello");
  assert.equal(tool[0].type, "tool.completed");
  assert.deepEqual(tool[0].payload.rawInput, { path: "." });
  assert.deepEqual(tool[0].payload.rawOutput, ["README.md"]);
});

test("linear-acp-client renders tool and response events to Linear activities and issue observability comment", async () => {
  buildLinearAcpClientBundle();
  const { MemoryLinearAcpClientStateStore, LinearAcpClientBridge } = await importFresh();
  const state = new MemoryLinearAcpClientStateStore();
  const linear = new FakeLinearClient();
  const acp = new FakeAcpClient();
  const bridge = new LinearAcpClientBridge({
    state,
    linear,
    acp,
    config: {
      externalUrls: [{ label: "Runtime", url: "https://runtime.example/session/1" }],
      linearCreateAsUser: "linear-acp-client",
    },
  });

  const result = await bridge.handleAgentSessionEvent({
    action: "created",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    promptContext: "List files and summarize.",
    agentSession: {
      id: "linear-session-1",
      issueId: "RT88-90",
      commentId: "comment-root",
      sourceCommentId: "comment-source",
      url: "https://linear.app/session/linear-session-1",
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(acp.calls.length, 1);
  assert.equal(acp.calls[0].prompt, "List files and summarize.");
  assert.equal(linear.sessionUpdates.length, 1);
  assert.deepEqual(linear.sessionUpdates[0].input.addedExternalUrls, [
    { label: "Runtime", url: "https://runtime.example/session/1" },
  ]);
  assert.equal(linear.activities.some((activity) => activity.content.type === "action"), true);
  assert.equal(linear.activities.some((activity) => activity.content.type === "response"), true);
  assert.equal(linear.comments.length, 1);
  assert.match(linear.commentUpdates.at(-1).input.body, /workspace.list-files/);
  assert.match(linear.commentUpdates.at(-1).input.body, /Final answer/);

  const duplicate = await bridge.handleAgentSessionEvent({
    action: "created",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    promptContext: "List files and summarize.",
    agentSession: { id: "linear-session-1", issueId: "RT88-90" },
  });
  assert.equal(duplicate.reason, "duplicate_webhook");
  assert.equal(acp.calls.length, 1);
});

test("linear-acp-client derives prompts from prompted Agent Activity payloads", async () => {
  buildLinearAcpClientBundle();
  const { MemoryLinearAcpClientStateStore, LinearAcpClientBridge } = await importFresh();
  const acp = new FakeAcpClient();
  const bridge = new LinearAcpClientBridge({
    state: new MemoryLinearAcpClientStateStore(),
    linear: new FakeLinearClient(),
    acp,
    config: { externalUrls: [], linearCreateAsUser: "linear-acp-client" },
  });

  await bridge.handleAgentSessionEvent({
    action: "prompted",
    webhookId: "webhook-2",
    webhookTimestamp: Date.now(),
    agentActivity: {
      id: "activity-1",
      content: { type: "prompt", body: "Continue this session." },
    },
    agentSession: { id: "linear-session-2", issueId: "RT88-90" },
  });

  assert.equal(acp.calls[0].prompt, "Continue this session.");
});

class FakeAcpClient {
  calls = [];

  async runPrompt(params) {
    this.calls.push({ linearAgentSessionId: params.linearAgentSessionId, prompt: params.prompt });
    await params.onSessionId("acp-1");
    await params.onUpdate({
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "workspace.list-files",
        status: "in_progress",
        rawInput: { path: "." },
      },
    });
    await params.onUpdate({
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "workspace.list-files",
        status: "completed",
        rawInput: { path: "." },
        rawOutput: ["README.md"],
      },
    });
    await params.onUpdate({
      sessionId: "acp-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Final answer" },
      },
    });
    return { acpSessionId: "acp-1", stopReason: "end_turn" };
  }
}

class FakeLinearClient {
  activities = [];
  comments = [];
  commentUpdates = [];
  sessionUpdates = [];

  async createAgentActivity(input) {
    this.activities.push(input);
    return { agentActivity: { id: `activity-${this.activities.length}` } };
  }

  async updateAgentSession(id, input) {
    this.sessionUpdates.push({ id, input });
    return { success: true };
  }

  async createComment(input) {
    this.comments.push(input);
    return { comment: { id: "observability-comment-1" } };
  }

  async updateComment(id, input) {
    this.commentUpdates.push({ id, input });
    return { success: true };
  }
}
