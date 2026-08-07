import { describe, expect, test } from "vitest";
import {
  createMcodeCapabilityDescriptor,
  createMcodeControllerProjection,
  createMcodeRecipe,
  createStudioControllerProjection,
  loadMcodeConfig,
} from "@rlabs/mcode";
import { createToolkitRuntimeContract, type ToolkitRuntimeBinding } from "@rlabs/mastra-primitives-export";
import { loadModelProfile } from "@rlabs/runtime-config";

describe("canonical MCode recipe", () => {
  test("projects one shared contract into MCode and Studio without owning a controller", async () => {
    const profile = loadModelProfile();
    const contract = createToolkitRuntimeContract({ profile });
    const workspace = { id: "local-project" };
    const sandbox = { provider: "local" };
    const binding = {
      identity: { projectId: "local-project", userId: "local-user", sessionId: "local-session" },
      workspace: { resolve: () => workspace },
      sandbox: { resolve: () => sandbox },
      commandExecution: { authorize: () => undefined },
      approval: { context: { host: "local" } },
    } satisfies ToolkitRuntimeBinding<typeof workspace, typeof sandbox>;
    const mcode = createMcodeControllerProjection(contract, binding, { browser: false });
    const studio = createStudioControllerProjection(contract, binding, { browser: false });

    expect(mcode.capability.contractDigest).toBe(contract.capability.digest);
    expect(mcode.binding).toBe(binding);
    expect(studio.capability.contractDigest).toBe(contract.capability.digest);
    expect(mcode.controller.modes.map(mode => mode.id)).toEqual(studio.controller.modes.map(mode => mode.id));
    expect(mcode.controller.subagents.map(subagent => subagent.id)).toEqual(["cortex", "flux", "zen"]);
    expect(mcode.agents.cortex.id).toBe(contract.roles.definitions.cortex.id);
    expect(studio.agents.zen.id).toBe(contract.roles.definitions.zen.id);
    expect(mcode).not.toHaveProperty("agentController");
    expect(studio).not.toHaveProperty("agentController");

  });

  test("projects Studio supervisors over canonical non-recursive leaves while MCode stays controller-native", async () => {
    const contract = createToolkitRuntimeContract({ profile: loadModelProfile() });
    const binding = {
      identity: { projectId: "project", userId: "user", sessionId: "session" },
      workspace: { resolve: () => ({ id: "workspace" }) },
      sandbox: { resolve: () => ({ provider: "local" }) },
      commandExecution: { authorize: () => undefined },
      approval: { context: { host: "test" } },
    } satisfies ToolkitRuntimeBinding;
    const mcode = createMcodeControllerProjection(contract, binding, { browser: false });
    const studio = createStudioControllerProjection(contract, binding, { browser: false });

    expect(mcode.controller.subagents.map(subagent => subagent.id)).toEqual(["cortex", "flux", "zen"]);
    for (const subagent of mcode.controller.subagents) {
      expect(Object.keys(subagent.tools ?? {}).filter(isRoleSpecificDelegationTool)).toEqual([]);
    }
    for (const supervisor of Object.values(studio.agents)) {
      const leaves = await supervisor.listAgents();
      expect(Object.keys(leaves)).toEqual(["cortex", "flux", "zen"]);
    }
    for (const agent of Object.values(mcode.agents)) {
      expect(await agent.listAgents()).toEqual({});
      expect(Object.keys(await agent.listTools()).filter(isRoleSpecificDelegationTool)).toEqual([]);
    }
  });

  test("projects native workspace tools without legacy command tools", async () => {
    const recipe = createMcodeRecipe({
      profile: loadModelProfile(),
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
    expect(recipe).not.toHaveProperty("tools.command_run");
    expect(recipe.capability.requiredTools).toContain("execute_command");
    expect(recipe.controller.subagents.every(subagent =>
      !Object.keys(subagent.tools ?? {}).some(tool => tool === "command_run" || tool === "adhd_run")
    )).toBe(true);
    for (const agent of Object.values(recipe.agents)) {
      expect(Object.keys(await agent.listTools())).not.toEqual(expect.arrayContaining(["command_run", "adhd_run"]));
    }
  });

  test("publishes a deterministic, serializable, secret-free compatibility descriptor", () => {
    const profile = loadModelProfile();
    const first = createMcodeRecipe({ profile, browser: false });
    const second = createMcodeRecipe({ profile, browser: false });

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
      browser: false,
    });
    const changed = createMcodeRecipe({
      profile: changedProfile,
      browser: false,
    });

    expect(changed.capability.digest).not.toBe(original.capability.digest);
  });

  test("inherits runtime-memory changes through the shared contract digest", () => {
    const profile = loadModelProfile();
    const changedMemory = structuredClone(profile);
    changedMemory.memory.contextBudgetTokens = 180_000;
    changedMemory.memory.observationThresholdTokens = 70_000;
    const original = createMcodeRecipe({
      profile,
      browser: false,
    });
    const changed = createMcodeRecipe({
      profile: changedMemory,
      browser: false,
    });

    expect(original.capability.models).not.toHaveProperty("memory");
    expect(changed.capability.digest).not.toBe(original.capability.digest);
  });

  test("changes the capability digest when canonical instructions change", () => {
    const profile = loadModelProfile();
    const recipe = createMcodeRecipe({
      profile,
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

function isRoleSpecificDelegationTool(toolName: string): boolean {
  return /^(?:use|delegate)_(?:cortex|flux|zen)$/.test(toolName);
}
