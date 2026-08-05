import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CODE_MODE_IDS } from "../src/agents/modes/index.js";
import { createA1MastraCodeGateway, getA1CodeModelId, prepareCodeSdkSettings } from "../src/factory/code-sdk.js";
import { loadModelProfile } from "../src/models/profile.js";

describe("Factory Code SDK configuration", () => {
  test("seeds A1 model defaults without persisting the proxy key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-code-sdk-"));
    await prepareCodeSdkSettings({ dataDirectory: directory, profile: loadModelProfile() });
    const settings = await readFile(join(directory, "settings.json"), "utf8");
    const parsed = JSON.parse(settings);

    expect(Object.keys(parsed.models.modeDefaults)).toEqual(CODE_MODE_IDS);
    expect(new Set(Object.values(parsed.models.modeDefaults))).toEqual(new Set(["a1-proxy/code-frontier-high"]));
    expect(parsed.models.observerModelOverride).toBe("a1-proxy/code-workhorse-high");
    expect(parsed.models.reflectorModelOverride).toBe("a1-proxy/code-workhorse-high");
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
        observerModelOverride: "a1-proxy/fast-high",
      },
      preferences: { yolo: true, thinkingLevel: "xhigh" },
    }));

    await prepareCodeSdkSettings({ dataDirectory: directory, profile: loadModelProfile() });
    const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));

    expect(settings.models.modeDefaults["cortex/build"]).toBe("a1-proxy/code-frontier-max");
    expect(settings.models.observerModelOverride).toBe("a1-proxy/fast-high");
    expect(settings.preferences).toMatchObject({ yolo: true, thinkingLevel: "xhigh" });
  });
});
