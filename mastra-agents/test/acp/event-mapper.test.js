import assert from "node:assert/strict";
import test from "node:test";

import { createMastraChunkMapper, inferToolKind, mapMastraChunkToUpdates } from "../../../compiled/mastra-agents/acp/event-mapper.js";

test("ACP event mapper creates tool_call events for Mastra tool starts", () => {
  const [update] = mapMastraChunkToUpdates({
    type: "tool-call",
    payload: {
      toolCallId: "call-1",
      toolName: "workspace.read-file",
      args: { path: "README.md" },
    },
  });

  assert.equal(update.sessionUpdate, "tool_call");
  assert.equal(update.toolCallId, "call-1");
  assert.equal(update.status, "in_progress");
  assert.equal(update.title, "workspace.read-file");
  assert.equal(update.kind, "read");
  assert.deepEqual(update.rawInput, { path: "README.md" });
  assert.equal(update._meta.mastra.type, "tool-call");
});

test("ACP event mapper preserves streamed tool input deltas", () => {
  const [start] = mapMastraChunkToUpdates({
    type: "tool-call-input-streaming-start",
    payload: { toolCallId: "call-1", toolName: "bash-command" },
  });
  const [delta] = mapMastraChunkToUpdates({
    type: "tool-call-delta",
    payload: { toolCallId: "call-1", toolName: "bash-command", argsTextDelta: '{"command":"npm test' },
  });
  const [end] = mapMastraChunkToUpdates({
    type: "tool-call-input-streaming-end",
    payload: { toolCallId: "call-1" },
  });

  assert.equal(start.sessionUpdate, "tool_call_update");
  assert.equal(start.status, "in_progress");
  assert.equal(start.kind, "execute");

  assert.equal(delta.sessionUpdate, "tool_call_update");
  assert.deepEqual(delta.rawInput, { argsTextDelta: '{"command":"npm test' });
  assert.equal(delta._meta.mastra.payload.argsTextDelta, '{"command":"npm test');

  assert.equal(end.sessionUpdate, "tool_call_update");
  assert.equal(end.status, "in_progress");
  assert.equal(end.rawOutput, undefined);
});

test("ACP event mapper adds Claude-like terminal metadata for execute results", () => {
  const [update] = mapMastraChunkToUpdates({
    type: "tool-result",
    payload: {
      toolCallId: "call-1",
      toolName: "workspace.execute-command",
      args: { command: "npm test" },
      result: { stdout: "ok\n", stderr: "warn\n", exitCode: 0, status: "completed" },
    },
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.status, "completed");
  assert.equal(update.kind, "execute");
  assert.deepEqual(update._meta.terminal, {
    output: "ok\nwarn\n",
    command: "npm test",
    exitCode: 0,
    status: "completed",
  });
  assert.equal(update._meta.mastra.type, "tool-result");
  assert.equal(update.content[0].content.text, "ok\nwarn\n");
});

test("ACP event mapper infers terminal metadata from terminal-shaped results without tool names", () => {
  const [update] = mapMastraChunkToUpdates({
    type: "tool-error",
    payload: {
      toolCallId: "call-1",
      error: { stderr: "command failed", exit_code: 2 },
    },
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.status, "failed");
  assert.deepEqual(update._meta.terminal, {
    output: "command failed",
    exitCode: 2,
  });
  assert.equal(update.rawOutput.stderr, "command failed");
});

test("ACP event mapper does not add terminal metadata for non-execute tools", () => {
  const [update] = mapMastraChunkToUpdates({
    type: "tool-result",
    payload: {
      toolCallId: "call-1",
      toolName: "workspace.read-file",
      result: { content: "hello" },
    },
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.status, "completed");
  assert.equal(update.kind, "read");
  assert.equal(update._meta.terminal, undefined);
});

test("ACP event mapper reads usage from top-level and payload finish chunks", () => {
  const [topLevel] = mapMastraChunkToUpdates({
    type: "finish",
    usage: { totalTokens: 123 },
  });
  const [payload] = mapMastraChunkToUpdates({
    type: "finish",
    payload: { usage: { totalTokens: 456 } },
  });

  assert.equal(topLevel.sessionUpdate, "usage_update");
  assert.equal(topLevel.used, 123);
  assert.equal(topLevel.size, 123);
  assert.equal(payload.sessionUpdate, "usage_update");
  assert.equal(payload.used, 456);
  assert.equal(payload.size, 456);
});

test("ACP event mapper exposes delegation start as a tool call with prompt input", () => {
  const [update] = mapMastraChunkToUpdates({
    type: "delegation-event",
    payload: {
      phase: "delegation_start",
      delegationId: "delegate-1",
      delegatedAgentId: "scout-agent",
      prompt: "Find the source of the auth error",
    },
  });

  assert.equal(update.sessionUpdate, "tool_call");
  assert.equal(update.toolCallId, "delegate-1");
  assert.equal(update.status, "in_progress");
  assert.equal(update.title, "scout-agent");
  assert.deepEqual(update.rawInput, {
    query: "Find the source of the auth error",
    prompt: "Find the source of the auth error",
  });
  assert.equal(update.content[0].content.text, "query:\nFind the source of the auth error");
});

test("ACP event mapper exposes delegation completion as a tool update with response text", () => {
  const [update] = mapMastraChunkToUpdates({
    type: "delegation-event",
    payload: {
      phase: "delegation_complete",
      delegationId: "delegate-1",
      delegatedAgentId: "scout-agent",
      prompt: "Find the source of the auth error",
      response: {
        text: "The docker sandbox setting falls through to Daytona.",
        subAgentThreadId: "thread-2",
        subAgentResourceId: "resource-2",
      },
      success: true,
    },
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.toolCallId, "delegate-1");
  assert.equal(update.status, "completed");
  assert.deepEqual(update.rawInput, {
    query: "Find the source of the auth error",
    prompt: "Find the source of the auth error",
  });
  assert.equal(update.rawOutput.text, "The docker sandbox setting falls through to Daytona.");
  assert.equal(update.content[0].content.text, "The docker sandbox setting falls through to Daytona.");
});

test("ACP event mapper exposes agent tool prompts as visible query content", () => {
  const [update] = mapMastraChunkToUpdates({
    type: "tool-call",
    payload: {
      toolCallId: "call-scout",
      toolName: "agent-scoutAgent",
      args: {
        prompt: "Inspect the ACP mapper",
        maxSteps: 6,
      },
    },
  });

  assert.equal(update.sessionUpdate, "tool_call");
  assert.deepEqual(update.rawInput, {
    query: "Inspect the ACP mapper",
    prompt: "Inspect the ACP mapper",
    maxSteps: 6,
  });
  assert.equal(update.content[0].content.text, "query:\nInspect the ACP mapper");
});

test("ACP event mapper accumulates streamed agent tool prompt deltas", () => {
  const mapper = createMastraChunkMapper();
  assert.deepEqual(mapper({
    type: "tool-call-input-streaming-start",
    payload: { toolCallId: "call-scout", toolName: "agent-scoutAgent" },
  }), []);
  assert.deepEqual(mapper({
    type: "tool-call-delta",
    payload: { toolCallId: "call-scout", toolName: "agent-scoutAgent", argsTextDelta: '{"prompt":"Inspect' },
  }), []);
  const [update] = mapper({
    type: "tool-call-delta",
    payload: { toolCallId: "call-scout", toolName: "agent-scoutAgent", argsTextDelta: ' files","maxSteps":6}' },
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.deepEqual(update.rawInput, {
    query: "Inspect files",
    prompt: "Inspect files",
    maxSteps: 6,
  });
  assert.equal(update.content[0].content.text, "query:\nInspect files");
});

test("ACP event mapper exposes nested agent tool-output chunks as visible content", () => {
  const mapper = createMastraChunkMapper();
  mapper({
    type: "tool-call",
    payload: {
      toolCallId: "call-scout",
      toolName: "agent-scoutAgent",
      args: { prompt: "Inspect files" },
    },
  });
  mapper({
    type: "tool-output",
    payload: {
      toolCallId: "call-scout",
      toolName: "agent-scoutAgent",
      output: {
        type: "reasoning-delta",
        payload: { text: "Checking files. " },
      },
    },
  });
  const [update] = mapper({
    type: "tool-output",
    payload: {
      toolCallId: "call-scout",
      toolName: "agent-scoutAgent",
      output: {
        type: "text-delta",
        payload: { text: "Found the mapper." },
      },
    },
  });

  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.match(update.content[0].content.text, /response:\nFound the mapper\./);
  assert.match(update.content[0].content.text, /thought:\nChecking files\./);
});

test("ACP event mapper suppresses non-renderable nested agent lifecycle chunks", () => {
  const mapper = createMastraChunkMapper();
  mapper({
    type: "tool-call",
    payload: {
      toolCallId: "call-scout",
      toolName: "agent-scoutAgent",
      args: { prompt: "Inspect files" },
    },
  });
  const updates = mapper({
    type: "tool-output",
    payload: {
      toolCallId: "call-scout",
      toolName: "agent-scoutAgent",
      output: {
        type: "step-start",
        payload: { request: {} },
      },
    },
  });

  assert.deepEqual(updates, []);
});

test("ACP event mapper exposes observational memory lifecycle events", () => {
  const [start] = mapMastraChunkToUpdates({
    type: "observational-memory-event",
    payload: {
      type: "om_observation_start",
      cycleId: "om-1",
      tokensToObserve: 120,
    },
  });
  const [end] = mapMastraChunkToUpdates({
    type: "observational-memory-event",
    payload: {
      type: "om_observation_end",
      cycleId: "om-1",
      tokensObserved: 120,
      observationTokens: 24,
    },
  });

  assert.equal(start.sessionUpdate, "tool_call");
  assert.equal(start.toolCallId, "observational-memory:om-1");
  assert.equal(start.status, "in_progress");
  assert.equal(start.title, "observational memory");

  assert.equal(end.sessionUpdate, "tool_call_update");
  assert.equal(end.toolCallId, "observational-memory:om-1");
  assert.equal(end.status, "completed");
  assert.equal(end.content[0].content.text, "observed 120 message tokens into 24 observation tokens");
});

test("ACP event mapper classifies execute-style tool names", () => {
  assert.equal(inferToolKind("bash"), "execute");
  assert.equal(inferToolKind("sandbox.run"), "execute");
  assert.equal(inferToolKind("workspace.execute-command"), "execute");
});
