import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_SANDBOX_SPEC_PATH, loadSandboxConfig } from "../src/index.js";

describe("loadSandboxConfig", () => {
  test("accepts an immutable runtime image selected by the deployment", () => {
    const config = loadSandboxConfig({
      SANDBOX_PROVIDER: "docker",
      SANDBOX_RUNTIME_IMAGE: "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }, process.cwd());

    expect(config.runtimeImage).toBe(
      "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  test("rejects a mutable deployment runtime image", () => {
    expect(() => loadSandboxConfig({
      SANDBOX_PROVIDER: "docker",
      SANDBOX_RUNTIME_IMAGE: "ghcr.io/rlabs88/toolkit/mcode-sandbox:latest",
    }, process.cwd())).toThrow(/immutable.*digest/i);
  });

  test("projects package defaults into a narrow sandbox config", () => {
    const config = loadSandboxConfig({}, resolve("packages/sandbox/test"));

    expect(config.provider).toBe("local");
    expect(config.workdir).toBe("/workspace");
    expect(config.maxSandboxes).toBe(8);
    expect(config.commandTimeoutMs).toBe(300_000);
    expect(config.specification).toEqual(expect.objectContaining({
      apiVersion: "cortex.provisioning/v1",
    }));
    expect(config.platform).toBeUndefined();
  });

  test("resolves an explicit specification and provider", () => {
    const config = loadSandboxConfig({
      SANDBOX_PROVIDER: "docker",
      SANDBOX_SPEC_PATH: DEFAULT_SANDBOX_SPEC_PATH,
      WORKSPACE_ROOT: "./fixtures/workspace",
    });

    expect(config.provider).toBe("docker");
    expect(config.workspaceRoot).toBe(resolve("fixtures/workspace"));
  });

  test("rejects incomplete Platform credentials", () => {
    expect(() => loadSandboxConfig({
      MASTRA_ENVIRONMENT_ID: "environment",
    })).toThrow(/platform sandbox.*missing MASTRA_PROJECT_ID, MASTRA_PLATFORM_SECRET_KEY/i);
  });

  test("returns complete Platform credentials without an aggregate config", () => {
    const config = loadSandboxConfig({
      SANDBOX_PROVIDER: "platform",
      MASTRA_ENVIRONMENT_ID: "environment",
      MASTRA_PROJECT_ID: "project",
      MASTRA_PLATFORM_SECRET_KEY: "secret",
    });

    expect(config.platform).toEqual({
      environmentId: "environment",
      projectId: "project",
      secretKey: "secret",
    });
  });
});
