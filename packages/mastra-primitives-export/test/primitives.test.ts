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

    const changedProfile = structuredClone(profile);
    changedProfile.memory.contextBudgetTokens += 1;
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
});
