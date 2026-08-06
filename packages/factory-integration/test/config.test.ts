import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadModelProfile } from "@rlabs/runtime-config";
import type { CloneableSandboxMachine, SandboxMachineOptions } from "@rlabs/sandbox";
import { createFactorySandboxMachine, loadFactoryConfig } from "../src/index.js";

describe("loadFactoryConfig", () => {
  test("publishes one root facade over four cohesive source modules", async () => {
    const packageRoot = join(import.meta.dirname, "..");
    const sourceEntries = await readdir(join(packageRoot, "src"));
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };

    expect(sourceEntries.sort()).toEqual(["config.ts", "index.ts", "integration.ts", "runtime.ts"]);
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
  });

  test("keeps the Factory application behind the package facade", async () => {
    const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
    const appManifest = JSON.parse(
      await readFile(join(repositoryRoot, "apps", "factory", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const appSource = await readFile(join(repositoryRoot, "apps", "factory", "src", "index.ts"), "utf8");

    expect(appManifest.dependencies).toEqual({ "@rlabs/factory-integration": "*" });
    expect(appSource).toContain('from "@rlabs/factory-integration"');
    expect(appSource).not.toMatch(/from "@rlabs\/(runtime-config|sandbox|agents-roles)"/);
  });

  test("uses the startup-resolved model profile", () => {
    const profile = structuredClone(loadModelProfile());
    profile.aliases.push("startup-only");

    expect(loadFactoryConfig({
      FACTORY_REPOSITORY_EXECUTION: "disabled",
      PROXY_MODEL: "startup-only",
    }, process.cwd(), profile).runtime.proxy.model).toBe("startup-only");
  });

  test("fails closed when Docker repository execution has no profile runtime image", () => {
    expect(() => loadFactoryConfig({
      SANDBOX_PROVIDER: "docker",
      CLI_PROXY_API_KEY: "test-only-key",
    }, process.cwd())).toThrow(/Docker.*SANDBOX_RUNTIME_IMAGE/i);
  });

  test("projects the selected runtime image and profile into Factory's machine construction", () => {
    const runtimeImage = "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const config = loadFactoryConfig({
      SANDBOX_PROVIDER: "docker",
      SANDBOX_RUNTIME_IMAGE: runtimeImage,
      FACTORY_PROJECT_RUNTIME_PROFILE: "ephemeral-development",
      CLI_PROXY_API_KEY: "test-only-key",
    }, process.cwd());
    if (!config.sandbox) throw new Error("expected configured sandbox");
    let captured: SandboxMachineOptions | undefined;
    let fixture: CloneableSandboxMachine;
    fixture = {
      id: "factory-fixture",
      name: "FactoryFixture",
      provider: "docker" as const,
      status: "pending" as const,
      clone: () => fixture,
    };

    const machine = createFactorySandboxMachine(
      { ...config, sandbox: config.sandbox },
      options => { captured = options; return fixture; },
    );

    expect(machine).toBe(fixture);
    expect(captured).toMatchObject({
      provider: "docker",
      runtimeImage,
      runtimeProfile: "ephemeral-development",
    });
  });

  test("composes host-neutral runtime and sandbox configuration", () => {
    const config = loadFactoryConfig({
      MASTRA_TOOLKIT_MODE: "factory",
      CLI_PROXY_API_KEY: "test-only-key",
      WORKSPACE_ROOT: process.cwd(),
      SANDBOX_PROVIDER: "local",
    }, process.cwd());

    expect(config.runtime.mode).toBe("factory");
    expect(config.runtime.proxy.apiKey).toBe("test-only-key");
    expect(config.server).toEqual({
      publicUrl: "http://localhost:4111",
      allowedOrigins: ["http://localhost:4111"],
    });
    expect(config.sandbox?.provider).toBe("local");
    expect(config.projectRuntime).toEqual({
      profile: "ephemeral-development",
      lifecycle: "ephemeral",
      packageLayers: ["mcode-runtime", "project-development"],
      credentials: "task-scoped",
    });
    expect(config.github).toBeUndefined();
    expect(config.workos).toBeUndefined();
  });

  test("boots the Factory control plane without repository sandboxes", () => {
    const config = loadFactoryConfig({
      MASTRA_TOOLKIT_MODE: "factory",
      FACTORY_REPOSITORY_EXECUTION: "disabled",
    }, process.cwd());

    expect(config.sandbox).toBeUndefined();
    expect(config.projectRuntime.profile).toBe("ephemeral-development");
  });

  test("rejects a non-loopback public origin when local authentication is selected", () => {
    expect(() => loadFactoryConfig({
      FACTORY_REPOSITORY_EXECUTION: "disabled",
      FACTORY_PUBLIC_URL: "http://192.0.2.10:4111",
    }, process.cwd())).toThrow(/local authentication.*loopback/i);
  });

  test("rejects partial GitHub and WorkOS credentials", () => {
    expect(() => loadFactoryConfig({ GITHUB_APP_ID: "partial" }, process.cwd()))
      .toThrow(/GitHub App.*missing/i);
    expect(() => loadFactoryConfig({ WORKOS_API_KEY: "partial" }, process.cwd()))
      .toThrow(/WorkOS.*missing/i);
  });

  test("rejects GitHub without a stable state secret", () => {
    expect(() => loadFactoryConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "test-private-key",
      GITHUB_APP_CLIENT_ID: "client",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    }, process.cwd())).toThrow(/GitHub.*state secret/i);
  });

  test("rejects a persistent operations runtime on the host-local sandbox provider", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      SANDBOX_PROVIDER: "local",
    }, process.cwd())).toThrow(/persistent-operations.*Platform/i);
  });

  test("rejects persistent operations when repository execution is disabled", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      FACTORY_REPOSITORY_EXECUTION: "disabled",
    }, process.cwd())).toThrow(/persistent-operations.*sandbox/i);
  });

  test("rejects a persistent operations runtime without durable Factory state", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      NODE_ENV: "production",
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

  test("rejects a persistent operations runtime without Platform identity", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      SANDBOX_PROVIDER: "platform",
      DATABASE_URL: "postgres://factory",
      REDIS_URL: "redis://factory",
      WORKOS_API_KEY: "workos-key",
      WORKOS_CLIENT_ID: "workos-client",
      WORKOS_COOKIE_PASSWORD: "x".repeat(32),
    }, process.cwd())).toThrow(/persistent-operations.*Platform identity/i);
  });

  test("selects the hardened persistent operations profile with an approved runtime secret provider", () => {
    const config = loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      NODE_ENV: "production",
      SANDBOX_PROVIDER: "platform",
      MASTRA_ENVIRONMENT_ID: "environment",
      MASTRA_PROJECT_ID: "project",
      MASTRA_PLATFORM_SECRET_KEY: "secret",
      DATABASE_URL: "postgres://factory",
      REDIS_URL: "redis://factory",
      WORKOS_API_KEY: "workos-key",
      WORKOS_CLIENT_ID: "workos-client",
      WORKOS_COOKIE_PASSWORD: "x".repeat(32),
      FACTORY_PUBLIC_URL: "https://factory.example.com",
      FACTORY_ALLOWED_ORIGINS: "https://factory.example.com,https://app.example.com",
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
    expect(config.server).toEqual({
      publicUrl: "https://factory.example.com",
      allowedOrigins: ["https://factory.example.com", "https://app.example.com"],
    });
  });

  test("rejects persistent operations without an HTTPS public origin", () => {
    expect(() => loadFactoryConfig({
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
      FACTORY_PUBLIC_URL: "http://factory.example.com",
    }, process.cwd())).toThrow(/persistent-operations.*HTTPS/i);
  });

  test("rejects persistent operations outside the production cookie policy", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      NODE_ENV: "development",
      SANDBOX_PROVIDER: "platform",
      MASTRA_ENVIRONMENT_ID: "environment",
      MASTRA_PROJECT_ID: "project",
      MASTRA_PLATFORM_SECRET_KEY: "secret",
      DATABASE_URL: "postgres://factory",
      REDIS_URL: "redis://factory",
      WORKOS_API_KEY: "workos-key",
      WORKOS_CLIENT_ID: "workos-client",
      WORKOS_COOKIE_PASSWORD: "x".repeat(32),
      FACTORY_PUBLIC_URL: "https://factory.example.com",
    }, process.cwd())).toThrow(/persistent-operations.*NODE_ENV=production/i);
  });

  test("rejects non-web and path-bearing Factory origins", () => {
    expect(() => loadFactoryConfig({
      FACTORY_PUBLIC_URL: "ftp://factory.example.com",
    }, process.cwd())).toThrow(/HTTP.*origin/i);
    expect(() => loadFactoryConfig({
      FACTORY_ALLOWED_ORIGINS: "http://localhost:4111/application",
    }, process.cwd())).toThrow(/origin without a path/i);
  });

  test("rejects production WorkOS over HTTP independently of the sandbox profile", () => {
    expect(() => loadFactoryConfig({
      NODE_ENV: "production",
      FACTORY_REPOSITORY_EXECUTION: "disabled",
      FACTORY_PUBLIC_URL: "http://factory.example.com",
      WORKOS_API_KEY: "workos-key",
      WORKOS_CLIENT_ID: "workos-client",
      WORKOS_COOKIE_PASSWORD: "x".repeat(32),
    }, process.cwd())).toThrow(/production WorkOS.*HTTPS/i);
    expect(() => loadFactoryConfig({
      NODE_ENV: "production",
      FACTORY_REPOSITORY_EXECUTION: "disabled",
      FACTORY_PUBLIC_URL: "https://factory.example.com",
      FACTORY_ALLOWED_ORIGINS: "http://app.example.com",
      WORKOS_API_KEY: "workos-key",
      WORKOS_CLIENT_ID: "workos-client",
      WORKOS_COOKIE_PASSWORD: "x".repeat(32),
    }, process.cwd())).toThrow(/production WorkOS.*HTTPS/i);
  });
});
