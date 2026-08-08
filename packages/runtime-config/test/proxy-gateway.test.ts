import { describe, expect, test, vi } from "vitest";
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

  test("never advertises an id the proxy serves but the profile does not declare", async () => {
    // `GET /models` returns the raw upstream names next to the aliases. Publishing those made
    // `gpt-5.6-sol` selectable, and it resolved against no provider entry. A credential is present
    // here, which is what used to enable discovery.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "code-frontier-high" },
        { id: "gpt-5.6-sol" },
        { id: "gpt-5.6-luna" },
        { id: "deepseek-v4-pro" },
      ],
    })));
    try {
      const gateway = new ProxyGateway({
        baseUrl: "https://proxy.example.test/v1",
        apiKey: "present",
        models: ["code-frontier-high", "code-workhorse-high"],
      });

      const providers = await gateway.fetchProviders();

      expect(providers["a1-proxy"]!.models).toEqual(["code-frontier-high", "code-workhorse-high"]);
      // The declared list is the whole catalog, so the endpoint is not consulted at all.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
