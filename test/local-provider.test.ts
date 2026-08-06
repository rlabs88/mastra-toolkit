import { describe, expect, test } from "vitest";
import type { FactoryStorage } from "@mastra/core/storage";
import { loadModelProfile, resolveRuntimeDefaultsV1 } from "@rlabs/runtime-config";
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
    }, resolveRuntimeDefaultsV1(loadModelProfile()));

    expect(initialized).toBe(true);
  });

  test("seeds Factory memory defaults from the canonical model profile", async () => {
    let memoryPatch: unknown;
    const domains = {
      "custom-providers": {
        ensureReady: async () => undefined,
        upsert: async () => undefined,
      },
      projects: {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "model-packs": {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "memory-settings": {
        ensureReady: async () => undefined,
        get: async () => null,
        patch: async (input: unknown) => { memoryPatch = input; },
      },
    };
    const storage = {
      getDomain: (name: keyof typeof domains) => domains[name],
      getMastraStorage: () => ({ getStore: async () => undefined }),
    } as unknown as FactoryStorage;

    await prepareLocalA1Provider(storage, {
      baseUrl: "https://proxy.invalid/v1",
      apiKey: "test-only-key",
      models: ["code-frontier-high"],
    }, resolveRuntimeDefaultsV1(loadModelProfile()));

    expect(memoryPatch).toEqual({
      orgId: "local-org",
      userId: "local-user",
      patch: {
        observationThreshold: 120_000,
        reflectionThreshold: 60_000,
      },
      fillIfUnset: {
        observerModelId: "a1-proxy/code-workhorse-high",
        reflectorModelId: "a1-proxy/code-workhorse-high",
      },
    });
  });

  test("preserves explicitly configured Factory memory settings", async () => {
    let memoryPatch: unknown;
    const domains = {
      "custom-providers": {
        ensureReady: async () => undefined,
        upsert: async () => undefined,
      },
      projects: {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "model-packs": {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "memory-settings": {
        ensureReady: async () => undefined,
        get: async () => ({
          observerModelId: "a1-proxy/fast-high",
          reflectorModelId: "a1-proxy/fast-low",
          observationThreshold: 90_000,
          reflectionThreshold: 30_000,
        }),
        patch: async (input: unknown) => { memoryPatch = input; },
      },
    };
    const storage = {
      getDomain: (name: keyof typeof domains) => domains[name],
      getMastraStorage: () => ({ getStore: async () => undefined }),
    } as unknown as FactoryStorage;

    await prepareLocalA1Provider(storage, {
      baseUrl: "https://proxy.invalid/v1",
      apiKey: "test-only-key",
      models: ["code-frontier-high"],
    }, resolveRuntimeDefaultsV1(loadModelProfile()));

    expect(memoryPatch).toBeUndefined();
  });

  test("fills only null Factory memory fields in a partial persisted record", async () => {
    let memoryPatch: unknown;
    const domains = {
      "custom-providers": {
        ensureReady: async () => undefined,
        upsert: async () => undefined,
      },
      projects: {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "model-packs": {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "memory-settings": {
        ensureReady: async () => undefined,
        get: async () => ({
          observerModelId: "a1-proxy/fast-high",
          reflectorModelId: null,
          observationThreshold: null,
          reflectionThreshold: 30_000,
        }),
        patch: async (input: unknown) => { memoryPatch = input; },
      },
    };
    const storage = {
      getDomain: (name: keyof typeof domains) => domains[name],
      getMastraStorage: () => ({ getStore: async () => undefined }),
    } as unknown as FactoryStorage;

    await prepareLocalA1Provider(storage, {
      baseUrl: "https://proxy.invalid/v1",
      apiKey: "test-only-key",
      models: ["code-frontier-high"],
    }, resolveRuntimeDefaultsV1(loadModelProfile()));

    expect(memoryPatch).toEqual({
      orgId: "local-org",
      userId: "local-user",
      patch: { observationThreshold: 120_000 },
      fillIfUnset: { reflectorModelId: "a1-proxy/code-workhorse-high" },
    });
  });

  test("does not rewrite Factory memory defaults on repeated startup", async () => {
    const memory = {
      observerModelId: null as string | null,
      reflectorModelId: null as string | null,
      observationThreshold: null as number | null,
      reflectionThreshold: null as number | null,
    };
    const memoryPatches: unknown[] = [];
    const domains = {
      "custom-providers": {
        ensureReady: async () => undefined,
        upsert: async () => undefined,
      },
      projects: {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "model-packs": {
        ensureReady: async () => undefined,
        list: async () => [],
      },
      "memory-settings": {
        ensureReady: async () => undefined,
        get: async () => ({ ...memory }),
        patch: async (input: {
          patch: Partial<typeof memory>;
          fillIfUnset?: Partial<typeof memory>;
        }) => {
          memoryPatches.push(input);
          Object.assign(memory, input.patch);
          for (const [key, value] of Object.entries(input.fillIfUnset ?? {})) {
            if (memory[key as keyof typeof memory] == null) {
              Object.assign(memory, { [key]: value });
            }
          }
        },
      },
    };
    const storage = {
      getDomain: (name: keyof typeof domains) => domains[name],
      getMastraStorage: () => ({ getStore: async () => undefined }),
    } as unknown as FactoryStorage;
    const provider = {
      baseUrl: "https://proxy.invalid/v1",
      apiKey: "test-only-key",
      models: ["code-frontier-high"],
    };
    const defaults = resolveRuntimeDefaultsV1(loadModelProfile());

    await prepareLocalA1Provider(storage, provider, defaults);
    await prepareLocalA1Provider(storage, provider, defaults);

    expect(memoryPatches).toHaveLength(1);
    expect(memory).toEqual({
      observerModelId: "a1-proxy/code-workhorse-high",
      reflectorModelId: "a1-proxy/code-workhorse-high",
      observationThreshold: 120_000,
      reflectionThreshold: 60_000,
    });
  });
});
