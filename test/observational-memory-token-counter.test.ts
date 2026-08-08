import { TokenCounter } from "@mastra/memory/processors";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type CountedMessage = Parameters<TokenCounter["countMessage"]>[0];

function failedToolMessage(): CountedMessage {
  return {
    id: "failed-tool-message",
    role: "assistant",
    createdAt: new Date(0),
    content: {
      format: 2,
      parts: [{
        type: "tool-invocation",
        toolInvocation: {
          state: "output-error",
          toolCallId: "failed-call",
          toolName: "dynamic_workflow",
          args: { action: "run" },
          errorText: "workflow dispatch failed",
        },
      }],
    },
  } as unknown as CountedMessage;
}

describe("observational-memory token counting", () => {
  test("makes the fixed memory build the one MCode consumers resolve", () => {
    const rootRequire = createRequire(import.meta.url);
    const fixedMemory = rootRequire.resolve("@mastra/memory/processors");

    for (const [consumer, entrypoint] of [
      ["@mastra/code-sdk", "@mastra/code-sdk/schema"],
      ["mastracode", "mastracode/tui"],
    ] as const) {
      const consumerRequire = createRequire(import.meta.resolve(entrypoint));
      expect(consumerRequire.resolve("@mastra/memory/processors"), consumer).toBe(fixedMemory);
    }
  });

  test("keeps memory processing alive after a persisted tool error", async () => {
    const counter = new TokenCounter();
    const message = failedToolMessage();

    expect(() => counter.countMessage(message)).not.toThrow();
    await expect(counter.countMessageAsync(message)).resolves.toBeGreaterThan(0);
  });
});
