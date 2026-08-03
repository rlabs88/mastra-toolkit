import { describe, expect, test } from "vitest";
import { createSandboxMachine } from "../src/sandbox/index.js";

describe("createSandboxMachine", () => {
  test.each(["local", "docker", "platform"] as const)("creates a cloneable %s machine", provider => {
    const machine = createSandboxMachine({
      provider,
      workspaceRoot: process.cwd(),
      platform: provider === "platform" ? { environmentId: "env", projectId: "project", secretKey: "secret" } : undefined,
    });

    expect(machine.provider).toBe(provider);
    expect(machine.clone({ id: "clone" }).provider).toBe(provider);
  });

  test("requires complete Platform identity", () => {
    expect(() => createSandboxMachine({ provider: "platform", workspaceRoot: process.cwd() })).toThrow(/Platform/);
  });
});
