import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTIVE_ALIAS,
  DEFAULT_OBSERVER_ALIAS,
  AGENT_BACKGROUND_TASK_POLICY,
  HOST_BACKGROUND_TASK_POLICY,
  loadModelProfile,
  resolveRuntimeDefaultsV1,
  resolveAliasModelId,
  resolveObservationalMemoryThresholds,
  resolveProxyGatewayModelId,
} from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("model profile", () => {
  test("exports one bounded background-task policy for every host and agent", () => {
    expect(HOST_BACKGROUND_TASK_POLICY).toEqual({
      enabled: true,
      mode: "full",
      globalConcurrency: 4,
      perAgentConcurrency: 1,
      backpressure: "reject",
      defaultTimeoutMs: 180_000,
      waitTimeoutMs: 5_000,
    });
    expect(AGENT_BACKGROUND_TASK_POLICY).toEqual({
      tools: "all",
      concurrency: 1,
      waitTimeoutMs: 5_000,
    });
  });

  test("loads the package-local A1 catalog and role defaults", () => {
    const profile = loadModelProfile();

    expect(profile.provider).toMatchObject({
      id: "a1-proxy",
      baseUrl: "https://aa.renaissancelab.org/v1",
      apiKeyEnv: "CLI_PROXY_API_KEY",
    });
    expect(profile.roles).toMatchObject({
      cortex: DEFAULT_ACTIVE_ALIAS,
      flux: DEFAULT_ACTIVE_ALIAS,
      zen: DEFAULT_ACTIVE_ALIAS,
      observer: DEFAULT_OBSERVER_ALIAS,
      reflector: DEFAULT_OBSERVER_ALIAS,
    });
    expect(profile.aliases).toContain("code-frontier-max");
  });

  test("loads the canonical catalog after Mastra relocates the bundled module", async () => {
    const modulesDirectory = join(packageRoot, "node_modules");
    await mkdir(modulesDirectory, { recursive: true });
    const cacheDirectory = await mkdtemp(join(modulesDirectory, "model-profile-bundle-"));
    const output = join(cacheDirectory, "index.mjs");

    try {
      await build({
        entryPoints: [join(packageRoot, "src/profile.ts")],
        bundle: true,
        format: "esm",
        outfile: output,
        packages: "external",
        platform: "node",
        target: "node22",
      });
      const bundled = await import(`${pathToFileURL(output).href}?test=${Date.now()}`) as {
        loadModelProfile: typeof loadModelProfile;
      };

      expect(bundled.loadModelProfile().provider.id).toBe("a1-proxy");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  test("resolves provider and gateway IDs only for declared aliases", () => {
    const profile = loadModelProfile();

    expect(resolveAliasModelId(profile, "code-frontier-high")).toBe("a1-proxy/code-frontier-high");
    expect(resolveProxyGatewayModelId(profile, "code-frontier-high")).toBe("proxy/a1-proxy/code-frontier-high");
    expect(() => resolveAliasModelId(profile, "openai/gpt-5.6-sol")).toThrow(/unknown model alias/i);
  });

  test("projects observation and reflection thresholds from one budget", () => {
    expect(resolveObservationalMemoryThresholds(loadModelProfile())).toEqual({
      observationThreshold: 120_000,
      reflectionThreshold: 60_000,
    });
  });

  test("projects one immutable, secret-free runtime-default contract for every host", () => {
    const profile = loadModelProfile();
    const defaults = resolveRuntimeDefaultsV1(profile);

    expect(defaults).toMatchObject({
      version: 1,
      models: {
        providerId: "a1-proxy",
        roles: {
          cortex: {
            alias: "code-frontier-high",
            providerModelId: "a1-proxy/code-frontier-high",
            gatewayModelId: "proxy/a1-proxy/code-frontier-high",
          },
          observer: {
            alias: "code-workhorse-high",
            providerModelId: "a1-proxy/code-workhorse-high",
          },
        },
      },
      memory: {
        contextWindowTokens: 120_000,
        secondaryInputTokens: 60_000,
      },
      codeSdk: {
        activeModelId: "a1-proxy/code-frontier-high",
        observerModelId: "a1-proxy/code-workhorse-high",
        reflectorModelId: "a1-proxy/code-workhorse-high",
        observationThreshold: 120_000,
        reflectionThreshold: 60_000,
      },
      factory: {
        observerModelId: "a1-proxy/code-workhorse-high",
        reflectorModelId: "a1-proxy/code-workhorse-high",
        observationThreshold: 120_000,
        reflectionThreshold: 60_000,
      },
      gateway: { models: profile.aliases },
    });
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.keys(defaults)).toEqual(["version", "models", "memory", "codeSdk", "factory", "gateway"]);
    expect(Object.keys(defaults.models)).toEqual(["providerId", "aliases", "roles"]);
    expect(Object.keys(defaults.models.roles)).toEqual([
      "cortex",
      "flux",
      "zen",
      "specialist",
      "observer",
      "reflector",
    ]);
    expect(Object.keys(defaults.models.roles.cortex)).toEqual([
      "alias",
      "providerModelId",
      "gatewayModelId",
    ]);
    expect(Object.keys(defaults.memory)).toEqual(["contextWindowTokens", "secondaryInputTokens"]);
    expect(Object.keys(defaults.codeSdk)).toEqual([
      "activeModelId",
      "observerModelId",
      "reflectorModelId",
      "observationThreshold",
      "reflectionThreshold",
    ]);
    expect(Object.keys(defaults.factory)).toEqual([
      "observerModelId",
      "reflectorModelId",
      "observationThreshold",
      "reflectionThreshold",
    ]);
    expect(Object.keys(defaults.gateway)).toEqual(["models"]);
    expectRecursivelyFrozen(defaults);
    expect(JSON.stringify(defaults)).not.toMatch(/apiKey|secret|credential/i);
  });

  test("keeps the host-neutral secondary input distinct from derived host thresholds", () => {
    const profile = structuredClone(loadModelProfile());
    profile.memory.contextBudgetTokens = 150_000;
    profile.memory.observationThresholdTokens = 40_000;

    const defaults = resolveRuntimeDefaultsV1(profile);

    expect(defaults.memory).toEqual({
      contextWindowTokens: 150_000,
      secondaryInputTokens: 40_000,
    });
    expect(defaults.codeSdk).toMatchObject({
      observationThreshold: 150_000,
      reflectionThreshold: 110_000,
    });
    expect(defaults.factory).toMatchObject({
      observationThreshold: 150_000,
      reflectionThreshold: 110_000,
    });
  });

  test("derives the active Code SDK model from the profile's declared default agent", () => {
    const profile = structuredClone(loadModelProfile());
    profile.roles.cortex = "fast-high";

    expect(resolveRuntimeDefaultsV1(profile).codeSdk.activeModelId).toBe("a1-proxy/fast-high");
  });
});

function expectRecursivelyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectRecursivelyFrozen(nested);
}
