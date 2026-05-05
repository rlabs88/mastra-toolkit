import { AgentChannels } from "@mastra/core/channels";
import { StreamingPlan } from "chat";

import { bridgeMastraStreamToLinearChunks } from "./linear-stream-bridge.js";

const installMarker = Symbol.for("mastra-system.linear-rich-streaming-installed");

type MastraStream = {
  fullStream?: AsyncIterable<{
    type?: string;
    payload?: Record<string, unknown>;
  }>;
};

type MastraChunk = NonNullable<MastraStream["fullStream"]> extends AsyncIterable<infer Chunk> ? Chunk : never;

type ChannelThread = {
  id?: string;
  post?: (message: unknown) => Promise<unknown>;
};

type ConsumeAgentStream = (
  stream: MastraStream,
  thread: ChannelThread,
  platform: string,
  approvalContext?: unknown,
) => Promise<unknown>;

type Logger = {
  debug?: (message: string, args?: unknown) => void;
  info?: (message: string, args?: unknown) => void;
  warn?: (message: string, args?: unknown) => void;
  error?: (message: string, args?: unknown) => void;
};

function isLinearAgentSessionThread(thread: ChannelThread, platform: string) {
  return (
    platform === "linear" &&
    typeof thread.id === "string" &&
    /^linear:[^:]+(?::c:[^:]+)?:s:[^:]+$/.test(thread.id)
  );
}

function isLinearActivitySourceCommentError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Failed to resolve source comment for Linear agent activity")
  );
}

function toolCallId(chunk: MastraChunk) {
  return typeof chunk.payload?.toolCallId === "string" ? chunk.payload.toolCallId : undefined;
}

function toolName(chunk: MastraChunk) {
  return typeof chunk.payload?.toolName === "string" ? chunk.payload.toolName : undefined;
}

async function* observeLinearStream(
  chunks: AsyncIterable<MastraChunk>,
  thread: ChannelThread,
  logger?: Logger,
) {
  const startedAt = Date.now();
  const toolStarts = new Map<string, { name?: string; startedAt: number }>();
  const counts: Record<string, number> = {};
  let firstResponseMs: number | undefined;
  let firstToolMs: number | undefined;

  logger?.info?.("[linear-rich-stream] start", { threadId: thread.id });

  try {
    for await (const chunk of chunks) {
      const type = chunk.type ?? "unknown";
      counts[type] = (counts[type] ?? 0) + 1;

      if (type === "text-delta" && firstResponseMs == null) {
        firstResponseMs = Date.now() - startedAt;
        logger?.info?.("[linear-rich-stream] first response text", {
          threadId: thread.id,
          elapsedMs: firstResponseMs,
        });
      }

      if (type === "tool-call") {
        const id = toolCallId(chunk) ?? `tool-${counts[type]}`;
        const elapsedMs = Date.now() - startedAt;
        if (firstToolMs == null) firstToolMs = elapsedMs;
        toolStarts.set(id, { name: toolName(chunk), startedAt: Date.now() });
        logger?.info?.("[linear-rich-stream] tool call start", {
          threadId: thread.id,
          toolCallId: id,
          toolName: toolName(chunk),
          elapsedMs,
        });
      }

      if (type === "tool-result" || type === "tool-error") {
        const id = toolCallId(chunk) ?? "tool-call";
        const started = toolStarts.get(id);
        const durationMs = started ? Date.now() - started.startedAt : undefined;
        logger?.info?.("[linear-rich-stream] tool call finish", {
          threadId: thread.id,
          toolCallId: id,
          toolName: toolName(chunk) ?? started?.name,
          durationMs,
          status: type === "tool-error" || chunk.payload?.isError === true ? "error" : "complete",
        });
      }

      yield chunk;
    }

    logger?.info?.("[linear-rich-stream] complete", {
      threadId: thread.id,
      durationMs: Date.now() - startedAt,
      firstResponseMs,
      firstToolMs,
      counts,
    });
  } catch (error) {
    logger?.error?.("[linear-rich-stream] failed", {
      threadId: thread.id,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      counts,
    });
    throw error;
  }
}

export function installLinearRichStreaming() {
  const prototype = AgentChannels.prototype as unknown as {
    [installMarker]?: boolean;
    consumeAgentStream?: ConsumeAgentStream;
  };

  if (prototype[installMarker] || typeof prototype.consumeAgentStream !== "function") return;

  const consumeAgentStream = prototype.consumeAgentStream;

  prototype.consumeAgentStream = async function consumeAgentStreamWithLinearRichStreaming(
    stream: MastraStream,
    thread: ChannelThread,
    platform: string,
    approvalContext?: unknown,
  ) {
    if (
      approvalContext ||
      !stream?.fullStream ||
      typeof thread?.post !== "function" ||
      !isLinearAgentSessionThread(thread, platform)
    ) {
      return consumeAgentStream.call(this, stream, thread, platform, approvalContext);
    }

    try {
      const logger = (this as { logger?: Logger }).logger;
      const observedStream = observeLinearStream(stream.fullStream, thread, logger);
      return await thread.post(new StreamingPlan(bridgeMastraStreamToLinearChunks(observedStream)));
    } catch (error) {
      if (isLinearActivitySourceCommentError(error)) return undefined;
      throw error;
    }
  };

  prototype[installMarker] = true;
}
