import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SANDBOX_SPEC_PATH,
  findSandboxSpecPath,
  loadSandboxSpec,
  parseSandboxSpec,
} from "../src/index.js";

describe("sandbox specification", () => {
  test("loads the package-local immutable entrypoint profile", () => {
    const specification = loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH);

    expect(specification.apiVersion).toBe("cortex.provisioning/v1");
    expect(specification.metadata.id).toBe("mastra-toolkit");
    expect(specification.spec.defaultProvider).toBe("local");
    expect(specification.spec.entrypointProfile.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  });

  test("rejects mutable images and undeclared runtime authority", () => {
    const mutable = structuredClone(loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH));
    mutable.spec.entrypointProfile.image = "ghcr.io/rlabs88/toolkit/aes-sandbox:latest";
    expect(() => parseSandboxSpec(mutable)).toThrow(/immutable.*digest/i);

    const credentialed = structuredClone(loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH)) as unknown as Record<string, unknown>;
    (credentialed.spec as Record<string, unknown>).env = { GH_TOKEN: "must-not-be-committed" };
    expect(() => parseSandboxSpec(credentialed)).toThrow();
  });

  test("falls back to the package default when no repository config exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-spec-search-"));
    try {
      expect(findSandboxSpecPath(undefined, directory)).toBe(DEFAULT_SANDBOX_SPEC_PATH);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
