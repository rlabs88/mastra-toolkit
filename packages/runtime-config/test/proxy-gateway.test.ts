import { describe, expect, test } from "vitest";
import { ProxyGateway, loadModelProfile } from "../src/index.js";

describe("ProxyGateway", () => {
  test("advertises stable aliases when discovery has no credential", async () => {
    const gateway = new ProxyGateway({ baseUrl: "https://proxy.example.test/v1" });

    await expect(gateway.fetchProviders()).resolves.toMatchObject({
      "a1-proxy": {
        models: loadModelProfile().aliases,
        apiKeyEnvVar: ["PROXY_API_KEY", "CLI_PROXY_API_KEY"],
        url: "https://proxy.example.test/v1",
      },
    });
    await expect(gateway.getApiKey()).rejects.toThrow(/proxy api key is missing/i);
  });
});
