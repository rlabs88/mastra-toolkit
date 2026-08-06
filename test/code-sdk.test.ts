import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CODE_MODE_IDS, createA1MastraCodeGateway, getA1CodeModelId, prepareCodeSdkSettings } from "@rlabs/mcode";
import { loadModelProfile, resolveRuntimeDefaultsV1 } from "@rlabs/runtime-config";

describe("Factory Code SDK configuration", () => {
  test("seeds A1 model defaults without persisting the proxy key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-code-sdk-"));
    const profile = loadModelProfile();
    const defaults = resolveRuntimeDefaultsV1(profile);
    await prepareCodeSdkSettings({
      dataDirectory: directory,
      defaults,
      provider: { baseUrl: "https://proxy.example.test/v1", models: defaults.gateway.models },
    });
    const settings = await readFile(join(directory, "settings.json"), "utf8");
    const parsed = JSON.parse(settings);

    expect(parsed.onboarding).toMatchObject({ version: 1, completedAt: new Date(0).toISOString() });
    expect(Object.keys(parsed.models.modeDefaults)).toEqual(CODE_MODE_IDS);
    expect(new Set(Object.values(parsed.models.modeDefaults))).toEqual(new Set(["a1-proxy/code-frontier-high"]));
    expect(parsed.models.observerModelOverride).toBe("a1-proxy/code-workhorse-high");
    expect(parsed.models.reflectorModelOverride).toBe("a1-proxy/code-workhorse-high");
    expect(parsed.models.subagentModels).toEqual({
      cortex: "proxy/a1-proxy/code-frontier-high",
      flux: "proxy/a1-proxy/code-frontier-high",
      zen: "proxy/a1-proxy/code-frontier-high",
    });
    expect(parsed.models.omObservationThreshold).toBe(120_000);
    expect(parsed.models.omReflectionThreshold).toBe(60_000);
    expect(parsed.customProviders).toEqual([{
      name: "A1 Proxy",
      url: "https://proxy.example.test/v1",
      models: profile.aliases,
    }]);
    expect(settings).not.toContain("apiKey");
    expect(settings).not.toContain("gpt-5.6-sol");
  });

  test("registers the provider ID emitted by Factory onboarding", async () => {
    const gateway = createA1MastraCodeGateway({
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "test-key",
      models: loadModelProfile().aliases,
    });

    expect(gateway.id).toBe("mastracode");
    expect(
      gateway.resolveAuth({
        gatewayId: "mastracode",
        providerId: "a1-proxy",
        modelId: "code-frontier-high",
        routerId: "mastracode/a1-proxy/code-frontier-high",
      }),
    ).toMatchObject({ apiKey: "test-key" });
    await expect(gateway.fetchProviders()).resolves.toHaveProperty("a1-proxy");
  });

  test("normalizes aliases to the stable A1 provider ID", () => {
    expect(getA1CodeModelId("code-frontier-high")).toBe("a1-proxy/code-frontier-high");
    expect(getA1CodeModelId("a1-proxy/code-frontier-high")).toBe("a1-proxy/code-frontier-high");
  });

  test("preserves explicit model, approval, and observational-memory choices", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-code-sdk-existing-"));
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      models: {
        modeDefaults: { "cortex/build": "a1-proxy/code-frontier-max" },
        subagentModels: { cortex: "openai/gpt-5.4-mini" },
        observerModelOverride: "a1-proxy/fast-high",
        omObservationThreshold: 72_000,
        omReflectionThreshold: 48_000,
      },
      preferences: { yolo: true, thinkingLevel: "xhigh" },
    }));

    await prepareCodeSdkSettings({
      dataDirectory: directory,
      defaults: resolveRuntimeDefaultsV1(loadModelProfile()),
    });
    const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));

    expect(settings.models.modeDefaults["cortex/build"]).toBe("a1-proxy/code-frontier-max");
    expect(settings.models.observerModelOverride).toBe("a1-proxy/fast-high");
    expect(settings.models.subagentModels).toEqual({
      cortex: "proxy/a1-proxy/code-frontier-high",
      flux: "proxy/a1-proxy/code-frontier-high",
      zen: "proxy/a1-proxy/code-frontier-high",
    });
    expect(settings.models.omObservationThreshold).toBe(72_000);
    expect(settings.models.omReflectionThreshold).toBe(48_000);
    expect(settings.preferences).toMatchObject({ yolo: true, thinkingLevel: "xhigh" });
  });

  test("projects distinct memory roles and budgets from a caller-supplied profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-code-sdk-memory-profile-"));
    const profile = structuredClone(loadModelProfile());
    profile.roles.observer = "fast-high";
    profile.roles.reflector = "fast-low";
    profile.memory.contextBudgetTokens = 150_000;
    profile.memory.observationThresholdTokens = 40_000;

    await prepareCodeSdkSettings({ dataDirectory: directory, defaults: resolveRuntimeDefaultsV1(profile) });
    const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));

    expect(settings.models).toMatchObject({
      observerModelOverride: "a1-proxy/fast-high",
      reflectorModelOverride: "a1-proxy/fast-low",
      omObservationThreshold: 150_000,
      omReflectionThreshold: 110_000,
    });
  });

  test("rejects persisted raw upstream model IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-code-sdk-raw-model-"));
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      models: { modeDefaults: { "cortex/build": "openai/gpt-5.6-sol" } },
    }));

    await expect(prepareCodeSdkSettings({
      dataDirectory: directory,
      defaults: resolveRuntimeDefaultsV1(loadModelProfile()),
    }))
      .rejects.toThrow(/stable a1 model alias/i);
  });
});
