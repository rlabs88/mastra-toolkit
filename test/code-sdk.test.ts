import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createA1MastraCodeGateway, getA1CodeModelId, prepareCodeSdkSettings } from "../src/factory/code-sdk.js";

describe("Factory Code SDK configuration", () => {
  test("seeds A1 model defaults without persisting the proxy key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-code-sdk-"));
    await prepareCodeSdkSettings({ dataDirectory: directory, model: "gpt-5.6-luna" });
    const settings = await readFile(join(directory, "settings.json"), "utf8");

    expect(JSON.parse(settings).models.modeDefaults).toMatchObject({
      fast: "mastracode/gpt-5.6-luna",
      plan: "mastracode/gpt-5.6-luna",
      build: "mastracode/gpt-5.6-luna",
    });
    expect(settings).not.toContain("apiKey");
  });

  test("registers the provider ID emitted by Factory onboarding", async () => {
    const gateway = createA1MastraCodeGateway({
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "test-key",
      model: "gpt-5.6-luna",
    });

    expect(gateway.id).toBe("mastracode");
    expect(
      gateway.resolveAuth({
        gatewayId: "mastracode",
        providerId: "mastracode",
        modelId: "gpt-5.6-luna",
        routerId: "mastracode/gpt-5.6-luna",
      }),
    ).toMatchObject({ apiKey: "test-key" });
    await expect(gateway.fetchProviders()).resolves.toHaveProperty("mastracode");
  });

  test("normalizes legacy A1 model IDs to the resolvable provider ID", () => {
    expect(getA1CodeModelId("gpt-5.6-luna")).toBe("mastracode/gpt-5.6-luna");
    expect(getA1CodeModelId("a1-proxy/gpt-5.6-luna")).toBe("mastracode/gpt-5.6-luna");
    expect(getA1CodeModelId("mastracode/a1-proxy/gpt-5.6-luna")).toBe("mastracode/gpt-5.6-luna");
  });
});
