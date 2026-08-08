import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { stringify } from "yaml";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTIVE_ALIAS,
  DEFAULT_OBSERVER_ALIAS,
  AGENT_BACKGROUND_TASK_POLICY,
  HOST_BACKGROUND_TASK_POLICY,
  UPSTREAM_BLOCKED_OBSERVATION_SETTINGS,
  loadModelProfile,
  resolveModelCard,
  resolveRuntimeDefaultsV1,
  resolveAliasModelId,
  resolveObservationalMemoryThresholds,
  resolveProxyGatewayModelId,
  selectModelAlias,
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
      // Ayra provisions domain-focused agents and authors dynamic workflows.
      // Orchestration-heavy, so it shares the frontier tier rather than a
      // cheaper one.
      ayra: DEFAULT_ACTIVE_ALIAS,
      observer: DEFAULT_OBSERVER_ALIAS,
      reflector: DEFAULT_OBSERVER_ALIAS,
    });
    expect(profile.aliases).toContain("code-frontier-max");
  });

  test("rejects an unknown alias on the ayra role like any other canonical role", async () => {
    await expect(parseProfile(profile => {
      profile.roles.ayra = "not-a-declared-alias";
    })).rejects.toThrow(/unknown model alias/i);
  });

  test("carries per-alias capability metadata on a preset card beside the alias list", () => {
    const profile = loadModelProfile();

    // The alias list stays a flat string[]; cards are a sibling map keyed by alias.
    expect(profile.aliases.every(alias => typeof alias === "string")).toBe(true);
    expect(Object.keys(profile.modelCards).every(alias => profile.aliases.includes(alias))).toBe(true);

    expect(resolveModelCard(profile, DEFAULT_ACTIVE_ALIAS)).toEqual({
      alias: "code-frontier-high",
      contextWindowTokens: 400_000,
      capabilities: ["code", "reasoning", "long-context"],
      observation: {
        messageTokens: 180_000,
        bufferTokens: 30_000,
        bufferActivation: 0.8,
      },
      reflection: { observationTokens: 60_000 },
    });
    expect(resolveModelCard(profile, DEFAULT_OBSERVER_ALIAS).contextWindowTokens).toBe(128_000);
    expect(() => resolveModelCard(profile, "openai/gpt-5.6-sol")).toThrow(/unknown model alias/i);

    // Per-model, not global: smaller tiers carry smaller budgets.
    expect(resolveModelCard(profile, "code-economic").observation.messageTokens).toBe(90_000);
    expect(resolveModelCard(profile, "code-workhorse-high").observation.messageTokens).toBe(120_000);
    expect(resolveModelCard(profile, "code-frontier-max").contextWindowTokens).toBe(400_000);
  });

  test("falls back to the profile-level memory budget for an alias with no card", () => {
    const profile = structuredClone(loadModelProfile());
    profile.aliases.push("uncarded");

    expect(resolveModelCard(profile, "uncarded")).toEqual({
      alias: "uncarded",
      contextWindowTokens: profile.memory.contextBudgetTokens,
      capabilities: [],
      observation: {
        messageTokens: profile.memory.contextBudgetTokens,
        bufferTokens: 24_000,
        bufferActivation: 0.8,
      },
      reflection: {
        observationTokens: profile.memory.contextBudgetTokens - profile.memory.observationThresholdTokens,
      },
    });
  });

  test("selects a model by declared capability instead of a hardcoded alias name", () => {
    const profile = loadModelProfile();

    expect(selectModelAlias(profile, { capabilities: ["long-context"] })).toBe("code-frontier-max");
    expect(selectModelAlias(profile, { capabilities: ["vision"] })).toBe("gpt-4o");
    expect(selectModelAlias(profile, { capabilities: ["economical"] })).toBe("code-economic");
    expect(selectModelAlias(profile, { capabilities: ["code", "fast"] })).toBe("fast-high");
    expect(selectModelAlias(profile, {
      capabilities: ["code"],
      minContextWindowTokens: 400_000,
    })).toBe("code-frontier-max");
    expect(selectModelAlias(profile, { minObservationMessageTokens: 180_000 })).toBe("code-frontier-max");
    expect(() => selectModelAlias(profile, {
      capabilities: ["vision"],
      minContextWindowTokens: 400_000,
    })).toThrow(/no model card satisfies/i);
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

  test("caps the observation threshold at the selected Observer's input budget", () => {
    expect(resolveObservationalMemoryThresholds(loadModelProfile())).toEqual({
      observationThreshold: 90_000,
      reflectionThreshold: 60_000,
    });
  });

  test("projects economical observation and reflection models to both hosts", () => {
    const defaults = resolveRuntimeDefaultsV1(loadModelProfile());

    expect(defaults.codeSdk).toMatchObject({
      observerModelId: "a1-proxy/code-economic",
      reflectorModelId: "a1-proxy/code-economic",
      observationThreshold: 90_000,
    });
    expect(defaults.factory).toMatchObject({
      observerModelId: "a1-proxy/code-economic",
      reflectorModelId: "a1-proxy/code-economic",
      observationThreshold: 90_000,
    });
  });

  test("keeps the reflection threshold on upstream reflection.observationTokens, not observation.bufferTokens", () => {
    // memory.js:104 maps our reflectionThreshold to `reflection.observationTokens`.
    // The 30k target in #174 is `observation.bufferTokens` (memory.js:90) and must
    // never be folded into the reflector activation budget.
    const profile = loadModelProfile();
    const { reflectionThreshold } = resolveObservationalMemoryThresholds(profile);

    expect(reflectionThreshold).toBe(60_000);
    expect(reflectionThreshold).not.toBe(30_000);
    expect(resolveModelCard(profile, DEFAULT_ACTIVE_ALIAS).observation.bufferTokens).toBe(30_000);
  });

  test("names the observation settings upstream hardcodes instead of wiring them", () => {
    expect(UPSTREAM_BLOCKED_OBSERVATION_SETTINGS.map(entry => entry.setting)).toEqual([
      "observation.bufferTokens",
      "observation.bufferActivation",
    ]);
    for (const entry of UPSTREAM_BLOCKED_OBSERVATION_SETTINGS) {
      // Paths are relative to the Mastra Code SDK package root: this package is
      // host-neutral, and test/workspace-structure.test.ts forbids naming a host
      // package inside packages/runtime-config/src.
      expect(entry.evidence).toMatch(/^dist\/agents\/memory\.js:\d+$/);
      expect(entry.upstreamLiteral.length).toBeGreaterThan(0);
      expect(entry.cardField).toMatch(/^observation\./);
    }

    // A blocked setting must never surface in a host projection as if it were live.
    const serialized = JSON.stringify(resolveRuntimeDefaultsV1(loadModelProfile()));
    expect(serialized).not.toContain("bufferTokens");
    expect(serialized).not.toContain("bufferActivation");
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
          ayra: {
            alias: "code-frontier-high",
            providerModelId: "a1-proxy/code-frontier-high",
            gatewayModelId: "proxy/a1-proxy/code-frontier-high",
          },
          observer: {
            alias: "code-economic",
            providerModelId: "a1-proxy/code-economic",
          },
        },
      },
      memory: {
        contextWindowTokens: 400_000,
        secondaryInputTokens: 60_000,
      },
      codeSdk: {
        activeModelId: "a1-proxy/code-frontier-high",
        observerModelId: "a1-proxy/code-economic",
        reflectorModelId: "a1-proxy/code-economic",
        observationThreshold: 90_000,
        reflectionThreshold: 60_000,
      },
      factory: {
        observerModelId: "a1-proxy/code-economic",
        reflectorModelId: "a1-proxy/code-economic",
        observationThreshold: 90_000,
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
      "ayra",
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

  test("caps the active agent's observation cadence to the Observer card", () => {
    const profile = structuredClone(loadModelProfile());
    const card = profile.modelCards[DEFAULT_ACTIVE_ALIAS]!;
    card.contextWindowTokens = 300_000;
    card.observation!.messageTokens = 150_000;
    card.reflection!.observationTokens = 40_000;

    const defaults = resolveRuntimeDefaultsV1(profile);

    expect(defaults.memory).toEqual({
      contextWindowTokens: 300_000,
      secondaryInputTokens: 40_000,
    });
    expect(defaults.codeSdk).toMatchObject({
      observationThreshold: 90_000,
      reflectionThreshold: 40_000,
    });
    expect(defaults.factory).toMatchObject({
      observationThreshold: 90_000,
      reflectionThreshold: 40_000,
    });
  });

  test("derives the active Code SDK model and its budgets from the declared default agent", () => {
    const profile = structuredClone(loadModelProfile());
    profile.roles.cortex = "fast-high";

    const defaults = resolveRuntimeDefaultsV1(profile);

    expect(defaults.codeSdk.activeModelId).toBe("a1-proxy/fast-high");
    expect(defaults.codeSdk.observationThreshold).toBe(90_000);
    expect(defaults.memory.contextWindowTokens).toBe(128_000);
  });

  test("rejects a card for an alias the catalog never declared", async () => {
    await expect(parseProfile(profile => {
      profile.modelCards["not-in-catalog"] = { contextWindowTokens: 1_000 };
    })).rejects.toThrow(/undeclared model alias/i);
  });

  test("rejects a card whose observation budget cannot fit its own context window", async () => {
    await expect(parseProfile(profile => {
      profile.modelCards[DEFAULT_ACTIVE_ALIAS].observation.messageTokens = 400_001;
    })).rejects.toThrow(/context window/i);
  });

  test("rejects a reflection budget that exceeds its own observation budget", async () => {
    await expect(parseProfile(profile => {
      profile.modelCards[DEFAULT_ACTIVE_ALIAS].reflection.observationTokens = 180_001;
    })).rejects.toThrow(/observation budget/i);
  });
});

/** Round-trips the canonical YAML through a mutation so schema rejections are covered end to end. */
async function parseProfile(mutate: (profile: any) => void): Promise<void> {
  const profile = structuredClone(loadModelProfile()) as any;
  mutate(profile);
  const directory = await mkdtemp(join(tmpdir(), "model-profile-parse-"));
  try {
    const path = join(directory, "models.yaml");
    await writeFile(path, stringify(profile));
    loadModelProfile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function expectRecursivelyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectRecursivelyFrozen(nested);
}
