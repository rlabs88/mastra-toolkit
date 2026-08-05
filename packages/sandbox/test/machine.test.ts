import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SANDBOX_SPEC_PATH,
  createDockerSandboxMachine,
  createLocalSandboxMachine,
  createSandboxMachine,
  loadSandboxSpec,
} from "../src/index.js";

const specification = loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH);

describe("sandbox machine adapters", () => {
  test.each(["local", "docker", "platform"] as const)("creates a cloneable %s machine", provider => {
    const machine = createSandboxMachine({
      provider,
      workspaceRoot: process.cwd(),
      specification,
      platform: provider === "platform"
        ? { environmentId: "env", projectId: "project", secretKey: "secret" }
        : undefined,
    });

    expect(machine.provider).toBe(provider);
    expect(machine.clone({ id: "clone" }).provider).toBe(provider);
  });

  test("requires complete Platform identity instead of falling back", () => {
    expect(() => createSandboxMachine({
      provider: "platform",
      workspaceRoot: process.cwd(),
      specification,
    })).toThrow(/platform/i);
  });

  test("maps immutable entrypoint policy into Docker", async () => {
    const machine = createDockerSandboxMachine({
      workspaceRoot: process.cwd(),
      specification,
    });

    await expect(machine.getInfo!()).resolves.toMatchObject({
      metadata: {
        image: specification.spec.entrypointProfile.image,
        workingDir: specification.spec.workdir,
      },
    });
  });

  test("makes git available through the configured Local adapter", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "rlabs-local-sandbox-"));
    const machine = createLocalSandboxMachine({ workspaceRoot, specification });

    try {
      await machine.start!();
      const result = await machine.executeCommand!("git", ["--version"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^git version /);
    } finally {
      await machine.destroy!();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
