import { ROLE_IDS } from "@rlabs/agents-roles";
import { loadModelProfile } from "@rlabs/runtime-config";
import { describe, expect, test } from "vitest";
import {
  createToolkitRuntimeContract,
  verifyToolkitRuntimeCapability,
} from "../src/index.js";

describe("ToolkitRuntimeContract", () => {
  test("recreates and verifies the same secret-free capability descriptor", () => {
    const profile = loadModelProfile();
    const first = createToolkitRuntimeContract({ profile });
    const second = createToolkitRuntimeContract({ profile });

    expect(first.capability).toEqual(second.capability);
    expect(verifyToolkitRuntimeCapability(first, second.capability)).toBe(true);
    expect(verifyToolkitRuntimeCapability(first, "sha256:mismatch")).toBe(false);
    expect(verifyToolkitRuntimeCapability(first, {
      ...second.capability,
      roles: ["zen", "flux", "cortex"],
    } as unknown as typeof second.capability)).toBe(false);
    expect(first.capability.runtime.providerApiKeyEnv).toBe("CLI_PROXY_API_KEY");
    expect(JSON.stringify(first.capability)).not.toContain("resolved-test-secret");
    expect(first).not.toHaveProperty("controller");
    expect(Object.isFrozen(first.roles.definitions.cortex.model)).toBe(true);

    // Preset cards are behaviour, not annotation: the default agent's card sets
    // the observational-memory thresholds every host resolves, so a card edit
    // must move the shared capability digest. This replaces the older
    // `memory.contextBudgetTokens` probe, which now only reaches an alias that
    // declares no card and therefore no longer perturbs the digest.
    const changedProfile = structuredClone(profile);
    changedProfile.modelCards["code-frontier-high"]!.observation!.messageTokens = 170_000;
    expect(createToolkitRuntimeContract({ profile: changedProfile }).capability.digest)
      .not.toBe(first.capability.digest);
    expect(createToolkitRuntimeContract({
      profile,
      providerBaseUrl: "https://runtime-override.invalid/v1",
    }).capability.digest).not.toBe(first.capability.digest);

    const credentialUrlProfile = structuredClone(profile);
    credentialUrlProfile.provider.baseUrl = "https://runtime-user:runtime-password@example.invalid/v1";
    expect(() => createToolkitRuntimeContract({ profile: credentialUrlProfile }))
      .toThrow(/must not contain credentials/i);
    expect(() => createToolkitRuntimeContract({
      profile,
      providerBaseUrl: "https://example.invalid/v1?api_key=resolved-test-secret",
    })).toThrow(/query parameters/i);
    expect(Object.isFrozen(first.capability.runtime.backgroundTasks.agent)).toBe(true);
    expect(first.capability.tools.agentVisible).toEqual({
      workspace: "mastra-workspace-tools/v1",
      dynamicWorkflow: "dynamic-workflow/v1",
    });
    expect(first.capability.tools).not.toHaveProperty("compatibilityLibraries");
    expect(first.tools).not.toHaveProperty("commandRun");
    expect(first.tools.dynamicWorkflow).toBe("dynamic-workflow/v1");
    expect(first.tools.createDynamicWorkflow).toBeTypeOf("function");
    expect(first.tools.reconcileDynamicWorkflowDefinitions).toBeTypeOf("function");
    expect(first.sandbox).not.toHaveProperty("createCommandRun");
  });

  test("projects every id in the canonical role registry, not a fixed three", () => {
    const contract = createToolkitRuntimeContract({ profile: loadModelProfile() });
    const capability = contract.capability;
    const canonical = [...ROLE_IDS].sort();

    // Compared against ROLE_IDS rather than a literal list, so a fourth
    // canonical role widens this contract instead of quietly bypassing it.
    expect([...capability.roles]).toEqual([...ROLE_IDS]);
    expect([...capability.delegation.targets]).toEqual([...ROLE_IDS]);
    expect([...capability.delegation.supervisorTargets]).toEqual([...ROLE_IDS]);
    expect([...contract.roles.ids]).toEqual([...ROLE_IDS]);
    expect(Object.keys(contract.roles.definitions).sort()).toEqual(canonical);

    // Every per-role projection must cover the registry exactly: no missing
    // role, and no stale entry for a role that no longer exists.
    for (const record of [
      capability.roleInstructionDigests,
      capability.roleModels,
      capability.roleMaxSteps,
      capability.roleTemperatures,
    ]) {
      expect(Object.keys(record).sort()).toEqual(canonical);
    }

    // The digest covers the role list, so adding a role must move it.
    expect(capability.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("boot reconciliation fails open when the host has no workflow definition store", async () => {
    const contract = createToolkitRuntimeContract({ profile: loadModelProfile() });
    const reconcile = contract.tools.reconcileDynamicWorkflowDefinitions;
    const removed: string[] = [];

    // A host without `workflowDefinitions` storage cannot have persisted a
    // model-authored definition, so boot continues instead of failing closed.
    // Pinned because startup calls this before anything can mount those rows:
    // if it ever starts throwing, MCode startup ordering has to be revisited.
    await expect(reconcile({ getStorage: () => undefined })).resolves.toBe(0);
    await expect(reconcile({ getStorage: () => ({}) })).resolves.toBe(0);
    await expect(reconcile({ getStorage: () => ({ getStore: async () => undefined }) })).resolves.toBe(0);
    await expect(reconcile({})).resolves.toBe(0);

    // ...but a host that does expose the store must have its stray rows archived.
    const rows = [
      { id: "dyn_0000000000000001", metadata: { origin: "dynamic_workflow" } },
      { id: "project_workflow", metadata: { origin: "project" } },
    ];
    const archived: Array<Record<string, unknown>> = [];
    await expect(reconcile({
      getStorage: () => ({
        getStore: async (name: string) => name === "workflowDefinitions"
          ? {
            upsert: async (input: Record<string, unknown>) => { archived.push(input); },
            list: async () => ({ definitions: rows }),
          }
          : undefined,
      }),
      removeWorkflow: (id: string) => { removed.push(id); return true; },
    })).resolves.toBe(1);
    expect(archived).toEqual([{ id: "dyn_0000000000000001", status: "archived" }]);
    expect(removed).toEqual(["dyn_0000000000000001"]);
  });
});
