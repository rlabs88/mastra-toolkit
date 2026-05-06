import type { StreamChunk } from "chat";

import { stringifyForChannel, stripToolPrefix } from "./text-format.js";

type MastraChunk = {
  type?: string;
  payload?: Record<string, unknown>;
};

function chunkPayload(chunk: MastraChunk) {
  return chunk.payload ?? {};
}

function toolChunkId(payload: Record<string, unknown>) {
  return typeof payload.toolCallId === "string" ? payload.toolCallId : "tool-call";
}

function toolChunkTitle(payload: Record<string, unknown>) {
  const name = typeof payload.toolName === "string" ? stripToolPrefix(payload.toolName) : "tool";
  return name.replace(/[_-]+/g, " ");
}

function chunkText(payload: Record<string, unknown>) {
  return typeof payload.text === "string" ? payload.text : "";
}

export function mastraChunkToChatStreamChunk(chunk: MastraChunk): StreamChunk | null {
  const payload = chunkPayload(chunk);

  if (chunk.type === "text-delta") {
    const text = chunkText(payload);
    return text ? { type: "markdown_text", text } : null;
  }

  if (chunk.type === "reasoning-delta") {
    const text = typeof payload.text === "string" ? payload.text : "Thinking...";
    return { type: "markdown_text", text };
  }

  if (chunk.type === "tool-call") {
    return {
      type: "task_update",
      id: toolChunkId(payload),
      title: toolChunkTitle(payload),
      details: stringifyForChannel(payload.args ?? {}, 2000),
      status: "in_progress",
    };
  }

  if (chunk.type === "tool-result") {
    const isError = payload.isError === true;
    return {
      type: "task_update",
      id: toolChunkId(payload),
      title: toolChunkTitle(payload),
      output: stringifyForChannel(payload.result, isError ? 2000 : 4000),
      status: isError ? "error" : "complete",
    };
  }

  if (chunk.type === "tool-error") {
    return {
      type: "task_update",
      id: toolChunkId(payload),
      title: toolChunkTitle(payload),
      output: stringifyForChannel(payload.error, 2000),
      status: "error",
    };
  }

  if (chunk.type === "step-start") {
    return { type: "plan_update", title: "Working" };
  }

  return null;
}

export async function* bridgeMastraStreamToChatChunks(chunks: AsyncIterable<MastraChunk>) {
  let pendingReasoning = "";

  for await (const chunk of chunks) {
    if (chunk.type === "reasoning-delta") {
      pendingReasoning += chunkText(chunkPayload(chunk));
      continue;
    }

    if (chunk.type === "text-delta") {
      pendingReasoning = "";
    }

    const mapped = mastraChunkToChatStreamChunk(chunk);
    if (!mapped) continue;

    if (mapped.type === "task_update" && pendingReasoning) {
      yield { type: "markdown_text", text: pendingReasoning };
      pendingReasoning = "";
    }

    yield mapped;
  }
}
