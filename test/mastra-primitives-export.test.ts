import { describe, expect, test } from "vitest";
import {
  createToolkitRuntimeContract,
  type ToolkitRuntimeBinding,
  verifyToolkitRuntimeCapability,
} from "@rlabs/mastra-primitives-export";
import { loadModelProfile } from "@rlabs/runtime-config";
import { createMcodeControllerProjection, createStudioControllerProjection } from "@rlabs/mcode";
import {
  createFactoryControllerProjection,
  createFactoryRuntimeBinding,
} from "@rlabs/factory-integration";

describe("shared Mastra Toolkit runtime contract", () => {
  test("aggregates canonical primitives behind a deterministic secret-free descriptor", () => {
    const profile = loadModelProfile();
    const first = createToolkitRuntimeContract({ profile });
    const second = createToolkitRuntimeContract({ profile });

    expect(first.version).toBe(2);
    expect(first.capability.schemaVersion).toBe(2);
    expect(first.roles.ids).toEqual(["cortex", "flux", "zen"]);
    expect(first.roles.definitions.cortex.id).toBe("cortex");
    expect(first.runtime.profile).toEqual(profile);
    expect(first.runtime.defaults.version).toBe(1);
    expect(first.tools.agentVisible).toEqual({
      workspace: "mastra-workspace-tools/v1",
    });
    expect(first.delegation).toEqual({
      nativeTool: "subagent",
      targets: ["cortex", "flux", "zen"],
      delegatedLeavesReceiveSubagent: false,
      supervisorSurface: "agents-map",
      supervisorTargets: ["cortex", "flux", "zen"],
      supervisorLeavesReceiveAgents: false,
    });
    expect(first.roles.createAgentRegistry).toBeTypeOf("function");
    expect(first.containment).toEqual({
      maxToolCalls: 64,
      maxDelegations: 8,
      maxRetainedOutputChars: 256_000,
      maxWallClockMs: 1_200_000,
      duplicateScopes: "reject",
      uncertainRemoteWrites: "reconcile-before-retry",
    });
    expect(first.capability.containment).toEqual(first.containment);
    expect(first.sandbox.createMachine).toBeTypeOf("function");
    expect(first.workspace.contextKey).toBe("mastraToolkitWorkspace");
    expect(first.capability).toEqual(second.capability);
    expect(first.capability.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyToolkitRuntimeCapability(first, second.capability)).toBe(true);
    expect(verifyToolkitRuntimeCapability(first, "sha256:missing")).toBe(false);
    expect(verifyToolkitRuntimeCapability(first, {
      ...second.capability,
      containment: { ...second.capability.containment, maxToolCalls: 65 },
    } as unknown as typeof second.capability)).toBe(false);
    expect(first.capability.runtime.providerApiKeyEnv).toBe("CLI_PROXY_API_KEY");
    expect(JSON.stringify(first.capability)).not.toContain("resolved-test-secret");
    expect(first).not.toHaveProperty("controller");

    const changedProfile = structuredClone(profile);
    changedProfile.provider.baseUrl = "https://different.invalid/v1";
    expect(createToolkitRuntimeContract({ profile: changedProfile }).capability.digest)
      .not.toBe(first.capability.digest);

    const mutableProfile = structuredClone(profile);
    const immutableContract = createToolkitRuntimeContract({ profile: mutableProfile });
    const initialCortexModel = immutableContract.runtime.profile.roles.cortex;
    mutableProfile.roles.cortex = mutableProfile.aliases.find(alias => alias !== initialCortexModel)!;
    expect(immutableContract.runtime.profile.roles.cortex).toBe(initialCortexModel);
  });

  test("keeps execution identities and live instances in a host-owned binding", () => {
    const workspace = { id: "local-project" };
    const sandbox = { provider: "local" };
    const binding = {
      identity: {
        projectId: "project-1",
        userId: "user-1",
        sessionId: "session-1",
      },
      workspace: { resolve: async () => workspace },
      sandbox: { resolve: async () => sandbox },
      approval: { context: { mode: "interactive" } },
    } satisfies ToolkitRuntimeBinding<typeof workspace, typeof sandbox>;

    expect(binding.workspace.resolve()).resolves.toBe(workspace);
    expect(binding.sandbox.resolve()).resolves.toBe(sandbox);
  });

  test("gives MCode, Studio, and Factory equivalent canonical capability digests", () => {
    const contract = createToolkitRuntimeContract({ profile: loadModelProfile() });
    const binding = {
      identity: { projectId: "project", userId: "user", sessionId: "session" },
      workspace: { resolve: () => ({ id: "workspace" }) },
      sandbox: { resolve: () => ({ provider: "local" }) },
      approval: { context: { mode: "test" } },
    } satisfies ToolkitRuntimeBinding;
    const mcode = createMcodeControllerProjection(contract, binding, { browser: false });
    const studio = createStudioControllerProjection(contract, binding, { browser: false });
    const factory = createFactoryControllerProjection(
      contract,
      createFactoryRuntimeBinding(),
      { browser: false },
    );

    expect(new Set([
      mcode.capability.contractDigest,
      studio.capability.contractDigest,
      factory.capability.contractDigest,
    ])).toEqual(new Set([contract.capability.digest]));
    expect(Object.keys(mcode.agents)).toEqual(Object.keys(factory.agents));
    expect(Object.keys(studio.agents)).toEqual(["cortex", "flux", "zen"]);
  });
});
