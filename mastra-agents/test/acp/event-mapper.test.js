import assert from "node:assert/strict";
import test from "node:test";

import { inferToolKind, mapMastraChunkToUpdates } from "../../../compiled/mastra-agents/acp/event-mapper.js";

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

test("ACP event mapper classifies execute-style tool names", () => {
  assert.equal(inferToolKind("bash"), "execute");
  assert.equal(inferToolKind("sandbox.run"), "execute");
  assert.equal(inferToolKind("workspace.execute-command"), "execute");
});
