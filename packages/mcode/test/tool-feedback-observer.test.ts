import { describe, expect, test, vi } from "vitest";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import { startForegroundToolFeedbackObserver } from "../src/tool-feedback-observer.js";

type InfoEvent = { type: "info"; message: string };

function sessionHarness() {
  const listeners = new Set<(event: AgentControllerEvent) => void | Promise<void>>();
  return {
    session: {
      subscribe(listener: (event: AgentControllerEvent) => void | Promise<void>) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    push(event: AgentControllerEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

describe("foreground tool feedback observer", () => {
  test("reports tool execution separately before a delayed provider continuation", async () => {
    const source = sessionHarness();
    const emitted: InfoEvent[] = [];
    let now = 1_000;
    const observer = startForegroundToolFeedbackObserver({
      session: source.session,
      emit: event => emitted.push(event),
      now: () => now,
    });

    source.push({ type: "agent_start" });
    source.push({ type: "tool_start", toolCallId: "call-1", toolName: "search_content", args: {} });
    now = 1_013;
    source.push({ type: "tool_end", toolCallId: "call-1", result: {}, isError: false });
    await Promise.resolve();

    expect(emitted).toEqual([{
      type: "info",
      message: "Tool · search_content completed in 13 ms · waiting for model continuation…",
    }]);

    now = 4_113;
    source.push({
      type: "message_update",
      message: {
        id: "message-1",
        role: "assistant",
        createdAt: new Date(4_113),
        content: { format: 2, parts: [{ type: "text", text: "Done" }] },
      },
    });
    await Promise.resolve();

    expect(emitted[1]).toEqual({
      type: "info",
      message: "Model continued after 3.1 s.",
    });
    await observer.close();
  });

  test("waits for parallel tools and preserves error state", async () => {
    const source = sessionHarness();
    const emitted: InfoEvent[] = [];
    let now = 0;
    const observer = startForegroundToolFeedbackObserver({
      session: source.session,
      emit: event => emitted.push(event),
      now: () => now,
    });

    source.push({ type: "tool_start", toolCallId: "one", toolName: "search_content", args: {} });
    source.push({ type: "tool_start", toolCallId: "two", toolName: "read_file", args: {} });
    now = 5;
    source.push({ type: "tool_end", toolCallId: "one", result: {}, isError: false });
    now = 8;
    source.push({ type: "tool_end", toolCallId: "two", result: {}, isError: true });
    await Promise.resolve();

    expect(emitted).toEqual([
      {
        type: "info",
        message: "Tool · search_content completed in 5 ms · 1 tool still running…",
      },
      {
        type: "info",
        message: "Tool · read_file failed in 8 ms · waiting for model continuation…",
      },
    ]);
    await observer.close();
  });

  test("unsubscribes on close and keeps feedback failures fail-open", async () => {
    const source = sessionHarness();
    const onError = vi.fn();
    const observer = startForegroundToolFeedbackObserver({
      session: source.session,
      emit: () => { throw new Error("renderer failed"); },
      onError,
    });

    source.push({ type: "tool_start", toolCallId: "call-1", toolName: "search_content", args: {} });
    source.push({ type: "tool_end", toolCallId: "call-1", result: {}, isError: false });
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
    expect(source.listenerCount()).toBe(1);
    await observer.close();
    expect(source.listenerCount()).toBe(0);

    source.push({ type: "tool_start", toolCallId: "call-2", toolName: "search_content", args: {} });
    expect(onError).toHaveBeenCalledOnce();
  });
});
