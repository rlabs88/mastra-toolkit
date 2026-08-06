import { describe, expect, test } from "vitest";
import { ProxyGateway } from "../src/index.js";

describe("ProxyGateway", () => {
  test("advertises stable aliases when discovery has no credential", async () => {
    const models = ["startup-profile-model"];
    const gateway = new ProxyGateway({ baseUrl: "https://proxy.example.test/v1", models });

    await expect(gateway.fetchProviders()).resolves.toMatchObject({
      "a1-proxy": {
        models,
        apiKeyEnvVar: ["PROXY_API_KEY", "CLI_PROXY_API_KEY"],
        url: "https://proxy.example.test/v1",
      },
    });
    await expect(gateway.getApiKey()).rejects.toThrow(/proxy api key is missing/i);
  });
});
