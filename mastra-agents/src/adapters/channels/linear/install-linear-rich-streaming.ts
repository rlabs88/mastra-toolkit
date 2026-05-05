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
      return await thread.post(new StreamingPlan(bridgeMastraStreamToLinearChunks(stream.fullStream)));
    } catch (error) {
      if (isLinearActivitySourceCommentError(error)) return undefined;
      throw error;
    }
  };

  prototype[installMarker] = true;
}
