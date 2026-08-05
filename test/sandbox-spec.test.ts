import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { findSandboxSpecPath, loadSandboxSpec, parseSandboxSpec } from "@rlabs/sandbox";

describe("sandbox specification", () => {
  test("loads the checked-in Cortex provisioning profile", () => {
    const specification = loadSandboxSpec(resolve("packages/sandbox/config/sandbox.config.json"));

    expect(specification.apiVersion).toBe("cortex.provisioning/v1");
    expect(specification.kind).toBe("SandboxRuntime");
    expect(specification.metadata.id).toBe("mastra-toolkit");
    expect(specification.spec.defaultProvider).toBe("local");
    expect(specification.spec.entrypointProfile.image).toMatch(
      /^ghcr\.io\/rlabs88\/toolkit\/aes-sandbox@sha256:[a-f0-9]{64}$/,
    );
    expect(specification.spec.entrypointProfile.platform).toBe("linux/arm64");
    expect(specification.spec.entrypointProfile.command).toEqual(["serve"]);
  });

  test("rejects a mutable Docker image tag", () => {
    const specification = structuredClone(loadSandboxSpec(resolve("packages/sandbox/config/sandbox.config.json")));
    specification.spec.entrypointProfile.image = "ghcr.io/rlabs88/toolkit/aes-sandbox:latest";

    expect(() => parseSandboxSpec(specification)).toThrow(/immutable.*digest/i);
  });

  test("rejects credentials and runtime authority in a versioned specification", () => {
    const specification = structuredClone(loadSandboxSpec(resolve("packages/sandbox/config/sandbox.config.json"))) as unknown as Record<string, unknown>;
    const spec = specification.spec as Record<string, unknown>;
    spec.env = { GH_TOKEN: "must-not-be-committed" };

    expect(() => parseSandboxSpec(specification)).toThrow();
  });

  test("discovers the repository specification from Mastra's public runtime directory", () => {
    expect(findSandboxSpecPath(undefined, resolve("apps/studio/src"))).toBe(
      resolve("packages/sandbox/config/sandbox.config.json"),
    );
  });
});
