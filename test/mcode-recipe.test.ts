import { describe, expect, test } from "vitest";
import { createMcodeCapabilityDescriptor, createMcodeRecipe, loadMcodeConfig } from "@rlabs/mcode";
import { loadModelProfile } from "@rlabs/runtime-config";
import { createSandboxCommandRunTool } from "@rlabs/sandbox";

describe("canonical MCode recipe", () => {
  test("owns the shared agents, modes, subagents, and sandbox tool projection", async () => {
    const commandRun = createSandboxCommandRunTool();
    const recipe = createMcodeRecipe({
      profile: loadModelProfile(),
      commandRun,
      browser: false,
    });

    expect(recipe.version).toBe(1);
    expect(recipe).not.toHaveProperty("settings");
    expect(recipe.controller.modes.map(mode => mode.id)).toEqual([
      "cortex/scope",
      "cortex/build",
      "flux/scope",
      "flux/build",
      "zen/scope",
      "zen/build",
    ]);
    expect(recipe.controller.subagents.map(subagent => subagent.id)).toEqual(["cortex", "flux", "zen"]);
    expect(recipe.controller.subagents.every(subagent => subagent.tools?.command_run === commandRun)).toBe(true);
    for (const agent of Object.values(recipe.agents)) {
      expect((await agent.listTools()).command_run).toBe(commandRun);
    }
  });

  test("publishes a deterministic, serializable, secret-free compatibility descriptor", () => {
    const profile = loadModelProfile();
    const first = createMcodeRecipe({ profile, commandRun: createSandboxCommandRunTool(), browser: false });
    const second = createMcodeRecipe({ profile, commandRun: createSandboxCommandRunTool(), browser: false });

    expect(first.capability).toEqual(second.capability);
    expect(first.capability.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.capability.models).toMatchObject({
      providerId: profile.provider.id,
      aliases: profile.aliases,
      modeDefaults: { "cortex/build": "a1-proxy/code-frontier-high" },
      subagentDefaults: { cortex: "proxy/a1-proxy/code-frontier-high" },
    });
    const serialized = JSON.stringify(first.capability);
    expect(serialized).not.toContain("test-only-secret");
    expect(serialized).not.toContain("apiKey");
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  test("changes the capability digest when a canonical model default changes", () => {
    const profile = loadModelProfile();
    const changedProfile = structuredClone(profile);
    changedProfile.roles.cortex = changedProfile.aliases.find(alias => alias !== profile.roles.cortex)!;

    const original = createMcodeRecipe({
      profile,
      commandRun: createSandboxCommandRunTool(),
      browser: false,
    });
    const changed = createMcodeRecipe({
      profile: changedProfile,
      commandRun: createSandboxCommandRunTool(),
      browser: false,
    });

    expect(changed.capability.digest).not.toBe(original.capability.digest);
  });

  test("keeps runtime memory defaults outside the recipe capability and digest", () => {
    const profile = loadModelProfile();
    const changedMemory = structuredClone(profile);
    changedMemory.memory.contextBudgetTokens = 180_000;
    changedMemory.memory.observationThresholdTokens = 70_000;
    const original = createMcodeRecipe({
      profile,
      commandRun: createSandboxCommandRunTool(),
      browser: false,
    });
    const changed = createMcodeRecipe({
      profile: changedMemory,
      commandRun: createSandboxCommandRunTool(),
      browser: false,
    });

    expect(original.capability.models).not.toHaveProperty("memory");
    expect(changed.capability.digest).toBe(original.capability.digest);
  });

  test("changes the capability digest when canonical instructions change", () => {
    const profile = loadModelProfile();
    const recipe = createMcodeRecipe({
      profile,
      commandRun: createSandboxCommandRunTool(),
      browser: false,
    });
    const changedModes = recipe.controller.modes.map((mode, index) =>
      index === 0 ? { ...mode, instructions: `${String(mode.instructions)}\nChanged.` } : mode);
    const changed = createMcodeCapabilityDescriptor(
      profile,
      changedModes,
      recipe.controller.subagents,
    );

    expect(changed.digest).not.toBe(recipe.capability.digest);
  });

  test("does not project a resolved runtime API key into the capability descriptor", () => {
    const config = loadMcodeConfig({
      CLI_PROXY_API_KEY: "test-only-secret",
      SANDBOX_PROVIDER: "local",
      WORKSPACE_ROOT: process.cwd(),
    });
    const recipe = createMcodeRecipe({
      profile: loadModelProfile(),
      commandRun: createSandboxCommandRunTool(),
      browser: false,
    });

    expect(config.runtime.proxy.apiKey).toBe("test-only-secret");
    expect(JSON.stringify(recipe.capability)).not.toContain("test-only-secret");
  });

  test("uses the startup-resolved profile when loading MCode runtime config", () => {
    const profile = structuredClone(loadModelProfile());
    profile.aliases.push("startup-only");

    expect(loadMcodeConfig({
      CLI_PROXY_API_KEY: "test-only-key",
      PROXY_MODEL: "startup-only",
      SANDBOX_PROVIDER: "local",
      WORKSPACE_ROOT: process.cwd(),
    }, process.cwd(), profile).runtime.proxy.model).toBe("startup-only");
  });
});
