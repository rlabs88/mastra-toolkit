import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { prepareCodeSdkSettings } from "../src/factory/code-sdk.js";

describe("Factory Code SDK configuration", () => {
  test("seeds A1 model defaults without persisting the proxy key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-code-sdk-"));
    await prepareCodeSdkSettings({ dataDirectory: directory, model: "gpt-5.6-luna" });
    const settings = await readFile(join(directory, "settings.json"), "utf8");

    expect(JSON.parse(settings).models.modeDefaults).toMatchObject({
      fast: "a1-proxy/gpt-5.6-luna",
      plan: "a1-proxy/gpt-5.6-luna",
      build: "a1-proxy/gpt-5.6-luna",
    });
    expect(settings).not.toContain("apiKey");
  });
});
