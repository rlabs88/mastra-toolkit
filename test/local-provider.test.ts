import { describe, expect, test } from "vitest";
import type { FactoryStorage } from "@mastra/core/storage";
import {
  normalizeModelReferences,
  normalizeStoredModelId,
  prepareLocalA1Provider,
} from "@rlabs/factory-integration";

describe("local A1 provider migration", () => {
  test.each([
    ["a1-proxy/gpt-5.6-luna", "a1-proxy/code-workhorse-high"],
    ["mastracode/a1-proxy/gpt-5.6-luna", "a1-proxy/code-workhorse-high"],
    ["mastracode/gpt-5.6-luna", "a1-proxy/code-workhorse-high"],
    ["a1-proxy/code-frontier-high", "a1-proxy/code-frontier-high"],
    ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeStoredModelId(input)).toBe(expected);
  });

  test("migrates nested thread model references without changing unrelated metadata", () => {
    const result = normalizeModelReferences({
      currentModelId: "mastracode/a1-proxy/gpt-5.6-luna",
      modes: ["a1-proxy/gpt-5.6-luna"],
      projectPath: "/workspace/a1-proxy/example",
    });

    expect(result).toEqual({
      changed: true,
      value: {
        currentModelId: "a1-proxy/code-workhorse-high",
        modes: ["a1-proxy/code-workhorse-high"],
        projectPath: "/workspace/a1-proxy/example",
      },
    });
  });

  test("initializes memory storage before migrating thread metadata", async () => {
    let initialized = false;
    const memory = {
      init: async () => { initialized = true; },
      listThreads: async () => {
        if (!initialized) throw new Error("mastra_threads is not initialized");
        return { threads: [] };
      },
      updateThread: async () => undefined,
    };
    const readyDomain = {
      ensureReady: async () => undefined,
      upsert: async () => undefined,
      list: async () => [],
      get: async () => null,
      patch: async () => undefined,
    };
    const storage = {
      getDomain: () => readyDomain,
      getMastraStorage: () => ({
        getStore: async (name: string) => name === "memory" ? memory : undefined,
      }),
    } as unknown as FactoryStorage;

    await prepareLocalA1Provider(storage, {
      baseUrl: "https://proxy.invalid/v1",
      apiKey: "test-only-key",
      models: ["code-frontier-high"],
    });

    expect(initialized).toBe(true);
  });
});
