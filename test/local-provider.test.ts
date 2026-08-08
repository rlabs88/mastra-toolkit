import { describe, expect, test } from "vitest";
import type { FactoryStorage } from "@mastra/core/storage";
import { loadModelProfile, resolveRuntimeDefaultsV1 } from "@rlabs/runtime-config";
import {
  normalizeModelReferences,
  normalizeStoredModelId,
  prepareLocalA1Provider,
} from "@rlabs/factory-integration";

// prepareLocalA1Provider is always handed the full declared alias list in production
// (`defaults.gateway.models`). A narrower list here would make every declared alias except one
// look unrecognised, and the migration would rewrite settings it should leave alone.
const DECLARED_ALIASES = [...resolveRuntimeDefaultsV1(loadModelProfile()).gateway.models];

const CATALOG = {
  aliases: new Set(["code-frontier-high", "code-workhorse-high", "code-economic"]),
  defaultModelId: "a1-proxy/code-frontier-high",
};

describe("local A1 provider migration", () => {
  test.each([
    // A declared alias survives in whatever prefix form it already carries.
    ["a1-proxy/code-frontier-high", "a1-proxy/code-frontier-high"],
    ["proxy/a1-proxy/code-workhorse-high", "proxy/a1-proxy/code-workhorse-high"],
    ["mastracode/a1-proxy/code-economic", "a1-proxy/code-economic"],
    // A raw upstream id is not a declared alias, whatever prefix it wears, so it resets to the
    // documented default. The tier is unrecoverable: gpt-5.6-luna serves both workhorse tiers and
    // gpt-5.6-sol serves all three frontier tiers, so there is nothing faithful to map back to.
    ["a1-proxy/gpt-5.6-luna", "a1-proxy/code-frontier-high"],
    ["mastracode/gpt-5.6-luna", "a1-proxy/code-frontier-high"],
    // The one that shipped the bug: an OpenAI-prefixed upstream id used to pass through untouched,
    // then resolved against the OpenAI provider and failed on a missing OPENAI_API_KEY.
    ["openai/gpt-5.6-sol", "a1-proxy/code-frontier-high"],
    ["openai/gpt-5.6-luna", "a1-proxy/code-frontier-high"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeStoredModelId(input, CATALOG)).toBe(expected);
  });

  test("migrates nested thread model references without changing unrelated metadata", () => {
    const result = normalizeModelReferences({
      currentModelId: "mastracode/a1-proxy/gpt-5.6-luna",
      // The key shape observed live in Factory thread metadata.
      modeModelId_build: "openai/gpt-5.6-sol",
      modes: ["a1-proxy/gpt-5.6-luna"],
      projectPath: "/workspace/a1-proxy/example",
    }, CATALOG);

    expect(result).toEqual({
      changed: true,
      value: {
        currentModelId: "a1-proxy/code-frontier-high",
        modeModelId_build: "a1-proxy/code-frontier-high",
        modes: ["a1-proxy/code-frontier-high"],
        projectPath: "/workspace/a1-proxy/example",
      },
    });
  });

  test("leaves a non-model string alone even when it looks like a model id", () => {
    // Selection is by key. Normalising by value would rewrite every unrecognised string in the
    // object to the default model id, destroying titles, branches, and paths.
    const result = normalizeModelReferences({
      title: "openai/gpt-5.6-sol",
      branch: "factory/gpt-5.6-luna",
      resourceId: "mastracode/a1-proxy/whatever",
    }, CATALOG);

    expect(result).toEqual({
      changed: false,
      value: {
        title: "openai/gpt-5.6-sol",
        branch: "factory/gpt-5.6-luna",
        resourceId: "mastracode/a1-proxy/whatever",
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
      models: DECLARED_ALIASES,
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
      models: DECLARED_ALIASES,
    }, resolveRuntimeDefaultsV1(loadModelProfile()));

    expect(memoryPatch).toEqual({
      orgId: "local-org",
      userId: "local-user",
      patch: {
        // Canonical activation threshold retuned to 180k in #174. The
        // reflection budget is a separate upstream setting and is unchanged.
        observationThreshold: 180_000,
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
      models: DECLARED_ALIASES,
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
      models: DECLARED_ALIASES,
    }, resolveRuntimeDefaultsV1(loadModelProfile()));

    expect(memoryPatch).toEqual({
      orgId: "local-org",
      userId: "local-user",
      patch: { observationThreshold: 180_000 },
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
      models: DECLARED_ALIASES,
    };
    const defaults = resolveRuntimeDefaultsV1(loadModelProfile());

    await prepareLocalA1Provider(storage, provider, defaults);
    await prepareLocalA1Provider(storage, provider, defaults);

    expect(memoryPatches).toHaveLength(1);
    expect(memory).toEqual({
      observerModelId: "a1-proxy/code-workhorse-high",
      reflectorModelId: "a1-proxy/code-workhorse-high",
      observationThreshold: 180_000,
      reflectionThreshold: 60_000,
    });
  });
});
