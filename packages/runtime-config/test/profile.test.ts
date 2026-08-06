import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTIVE_ALIAS,
  DEFAULT_OBSERVER_ALIAS,
  loadModelProfile,
  resolveAliasModelId,
  resolveObservationalMemoryThresholds,
  resolveProxyGatewayModelId,
} from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("model profile", () => {
  test("loads the package-local A1 catalog and role defaults", () => {
    const profile = loadModelProfile();

    expect(profile.provider).toMatchObject({
      id: "a1-proxy",
      baseUrl: "https://aa.renaissancelab.org/v1",
      apiKeyEnv: "CLI_PROXY_API_KEY",
    });
    expect(profile.roles).toMatchObject({
      cortex: DEFAULT_ACTIVE_ALIAS,
      flux: DEFAULT_ACTIVE_ALIAS,
      zen: DEFAULT_ACTIVE_ALIAS,
      observer: DEFAULT_OBSERVER_ALIAS,
      reflector: DEFAULT_OBSERVER_ALIAS,
    });
    expect(profile.aliases).toContain("code-frontier-max");
  });

  test("loads the canonical catalog after Mastra relocates the bundled module", async () => {
    const cacheDirectory = await mkdtemp(join(packageRoot, "node_modules/model-profile-bundle-"));
    const output = join(cacheDirectory, "index.mjs");

    try {
      await build({
        entryPoints: [join(packageRoot, "src/profile.ts")],
        bundle: true,
        format: "esm",
        outfile: output,
        packages: "external",
        platform: "node",
        target: "node22",
      });
      const bundled = await import(`${pathToFileURL(output).href}?test=${Date.now()}`) as {
        loadModelProfile: typeof loadModelProfile;
      };

      expect(bundled.loadModelProfile().provider.id).toBe("a1-proxy");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  test("resolves provider and gateway IDs only for declared aliases", () => {
    const profile = loadModelProfile();

    expect(resolveAliasModelId(profile, "code-frontier-high")).toBe("a1-proxy/code-frontier-high");
    expect(resolveProxyGatewayModelId(profile, "code-frontier-high")).toBe("proxy/a1-proxy/code-frontier-high");
    expect(() => resolveAliasModelId(profile, "openai/gpt-5.6-sol")).toThrow(/unknown model alias/i);
  });

  test("projects observation and reflection thresholds from one budget", () => {
    expect(resolveObservationalMemoryThresholds(loadModelProfile())).toEqual({
      observationThreshold: 60_000,
      reflectionThreshold: 60_000,
    });
  });
});
