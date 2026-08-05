import { describe, expect, test } from "vitest";
import { loadRuntimeConfig } from "../src/index.js";

describe("loadRuntimeConfig", () => {
  test("uses standalone A1 proxy defaults without resolving a secret", () => {
    const config = loadRuntimeConfig({});

    expect(config).toEqual({
      mode: "standalone",
      proxy: {
        baseUrl: "https://aa.renaissancelab.org/v1",
        model: "code-frontier-high",
      },
    });
  });

  test("normalizes explicit host settings and prefers PROXY_API_KEY", () => {
    const config = loadRuntimeConfig({
      MASTRA_TOOLKIT_MODE: "factory",
      PROXY_BASE_URL: "https://proxy.example.test/v1///",
      PROXY_API_KEY: "host-key",
      CLI_PROXY_API_KEY: "profile-key",
      PROXY_MODEL: "code-workhorse-high",
    });

    expect(config).toEqual({
      mode: "factory",
      proxy: {
        baseUrl: "https://proxy.example.test/v1",
        apiKey: "host-key",
        model: "code-workhorse-high",
      },
    });
  });

  test("rejects a model outside the package catalog", () => {
    expect(() => loadRuntimeConfig({ PROXY_MODEL: "gpt-5.6-sol" })).toThrow(/unknown model alias/i);
  });
});
