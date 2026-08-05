import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createSandboxMachine, loadSandboxSpec } from "@rlabs/sandbox";

const specification = loadSandboxSpec(resolve("packages/sandbox/config/sandbox.config.json"));

describe("createSandboxMachine", () => {
  test.each(["local", "docker", "platform"] as const)("creates a cloneable %s machine", provider => {
    const machine = createSandboxMachine({
      provider,
      workspaceRoot: process.cwd(),
      specification,
      platform: provider === "platform" ? { environmentId: "env", projectId: "project", secretKey: "secret" } : undefined,
    });

    expect(machine.provider).toBe(provider);
    expect(machine.clone({ id: "clone" }).provider).toBe(provider);
  });

  test("requires complete Platform identity", () => {
    expect(() => createSandboxMachine({ provider: "platform", workspaceRoot: process.cwd(), specification })).toThrow(/Platform/);
  });

  test("maps the immutable entrypoint profile into Docker", async () => {
    const machine = createSandboxMachine({ provider: "docker", workspaceRoot: process.cwd(), specification });
    expect(machine.getInfo).toBeDefined();

    expect((await machine.getInfo!()).metadata).toMatchObject({
      image: specification.spec.entrypointProfile.image,
      workingDir: specification.spec.workdir,
    });
  });

  test("makes git available inside the configured local sandbox", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "mastra-toolkit-sandbox-"));
    const machine = createSandboxMachine({ provider: "local", workspaceRoot, specification });

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
