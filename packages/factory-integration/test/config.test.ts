import { describe, expect, test } from "vitest";
import { loadFactoryConfig } from "../src/config.js";

describe("loadFactoryConfig", () => {
  test("composes host-neutral runtime and sandbox configuration", () => {
    const config = loadFactoryConfig({
      MASTRA_TOOLKIT_MODE: "factory",
      CLI_PROXY_API_KEY: "test-only-key",
      WORKSPACE_ROOT: process.cwd(),
      SANDBOX_PROVIDER: "local",
    }, process.cwd());

    expect(config.runtime.mode).toBe("factory");
    expect(config.runtime.proxy.apiKey).toBe("test-only-key");
    expect(config.sandbox.provider).toBe("local");
    expect(config.github).toBeUndefined();
    expect(config.workos).toBeUndefined();
  });

  test("rejects partial GitHub and WorkOS credentials", () => {
    expect(() => loadFactoryConfig({ GITHUB_APP_ID: "partial" }, process.cwd()))
      .toThrow(/GitHub App.*missing/i);
    expect(() => loadFactoryConfig({ WORKOS_API_KEY: "partial" }, process.cwd()))
      .toThrow(/WorkOS.*missing/i);
  });
});
