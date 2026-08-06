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
    expect(config.projectRuntime).toEqual({
      profile: "ephemeral-development",
      lifecycle: "ephemeral",
      packageLayers: ["mcode-runtime", "project-development"],
      credentials: "task-scoped",
    });
    expect(config.github).toBeUndefined();
    expect(config.workos).toBeUndefined();
  });

  test("rejects partial GitHub and WorkOS credentials", () => {
    expect(() => loadFactoryConfig({ GITHUB_APP_ID: "partial" }, process.cwd()))
      .toThrow(/GitHub App.*missing/i);
    expect(() => loadFactoryConfig({ WORKOS_API_KEY: "partial" }, process.cwd()))
      .toThrow(/WorkOS.*missing/i);
  });

  test("rejects a persistent operations runtime on the host-local sandbox provider", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      SANDBOX_PROVIDER: "local",
    }, process.cwd())).toThrow(/persistent-operations.*Platform/i);
  });

  test("rejects a persistent operations runtime without durable Factory state", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      SANDBOX_PROVIDER: "platform",
      MASTRA_ENVIRONMENT_ID: "environment",
      MASTRA_PROJECT_ID: "project",
      MASTRA_PLATFORM_SECRET_KEY: "secret",
    }, process.cwd())).toThrow(/persistent-operations.*DATABASE_URL.*REDIS_URL/i);
  });

  test("rejects a persistent operations runtime without deployment authentication", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      SANDBOX_PROVIDER: "platform",
      MASTRA_ENVIRONMENT_ID: "environment",
      MASTRA_PROJECT_ID: "project",
      MASTRA_PLATFORM_SECRET_KEY: "secret",
      DATABASE_URL: "postgres://factory",
      REDIS_URL: "redis://factory",
    }, process.cwd())).toThrow(/persistent-operations.*WorkOS/i);
  });

  test("selects the hardened persistent operations profile with an approved runtime secret provider", () => {
    const config = loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      SANDBOX_PROVIDER: "platform",
      MASTRA_ENVIRONMENT_ID: "environment",
      MASTRA_PROJECT_ID: "project",
      MASTRA_PLATFORM_SECRET_KEY: "secret",
      DATABASE_URL: "postgres://factory",
      REDIS_URL: "redis://factory",
      WORKOS_API_KEY: "workos-key",
      WORKOS_CLIENT_ID: "workos-client",
      WORKOS_COOKIE_PASSWORD: "x".repeat(32),
    }, process.cwd());

    expect(config.projectRuntime).toEqual({
      profile: "persistent-operations",
      lifecycle: "persistent",
      packageLayers: ["mcode-runtime", "project-development", "operations"],
      credentials: "runtime-secret-provider",
      secretProvider: {
        kind: "infisical",
        projectId: "0b0f6354-029f-45a7-9c1c-b65968b5f46c",
        environment: "dev",
        path: "/mastra-toolkit",
      },
    });
  });
});
