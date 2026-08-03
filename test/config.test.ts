import { describe, expect, test } from "vitest";
import { loadToolkitConfig } from "../src/config.js";

describe("loadToolkitConfig", () => {
  test("uses the A1 proxy and local standalone defaults", () => {
    const config = loadToolkitConfig({});

    expect(config.mode).toBe("standalone");
    expect(config.proxy.baseUrl).toBe("https://aa.renaissancelab.org/v1");
    expect(config.proxy.model).toBe("openai/gpt-5.6-luna");
    expect(config.sandbox.provider).toBe("local");
  });

  test("rejects partial GitHub App configuration", () => {
    expect(() => loadToolkitConfig({ GITHUB_APP_ID: "123" })).toThrow(/GitHub App/);
  });

  test("allows the default GitHub App slug before credentials exist", () => {
    const config = loadToolkitConfig({ GITHUB_APP_SLUG: "rlabs-mastra-toolkit" });

    expect(config.github).toBeUndefined();
  });

  test("does not silently fall back for an invalid sandbox provider", () => {
    expect(() => loadToolkitConfig({ SANDBOX_PROVIDER: "daytona" })).toThrow(/SANDBOX_PROVIDER/);
  });
});
