import { describe, expect, test } from "vitest";
import * as agentTools from "@rlabs/agent-tools";
import { createToolkitAgents } from "@rlabs/agents-roles";
import * as sandbox from "@rlabs/sandbox";
// These type imports lock deletion at the package facade, where downstream callers compile.
// @ts-expect-error Command Run contracts were deleted with the tool.
import type { CommandInput } from "@rlabs/agent-tools";
// @ts-expect-error The sandbox-owned Command Run adapter was deleted with the tool.
import type { SandboxCommandRunToolOptions } from "@rlabs/sandbox";

describe("canonical toolkit tools", () => {
  test("publishes dynamic orchestration without restoring legacy command APIs", () => {
    expect(Object.keys(agentTools).sort()).toEqual([
      "DYNAMIC_WORKFLOW_DEPTH_CONTEXT_KEY",
      "DYNAMIC_WORKFLOW_ORIGIN",
      "RUN_CONTAINMENT_POLICY",
      "browserActionRequiresApproval",
      "createDynamicWorkflowTool",
      "createRunBudgetHooks",
      "createToolAuditHooks",
      "createVisibleBrowser",
      "reconcileDynamicWorkflowDefinitions",
    ]);
    expect(Object.keys(sandbox).sort()).toEqual([
      "DEFAULT_SANDBOX_SPEC_PATH",
      "createDockerSandboxMachine",
      "createLocalSandboxMachine",
      "createPlatformSandboxMachine",
      "createSandboxMachine",
      "enforceSandboxRuntimeProfile",
      "findSandboxSpecPath",
      "loadDefaultSandboxSpec",
      "loadSandboxConfig",
      "loadSandboxSpec",
      "parseSandboxSpec",
      "resolveSandboxRuntimeProfile",
    ]);
  });
});

describe("Mastra agents", () => {
  test("registers Cortex, Flux, and Zen as non-recursive leaves", async () => {
    const agents = createToolkitAgents({ browser: false });

    expect(Object.keys(agents)).toEqual(["cortex", "flux", "zen"]);
    for (const agent of Object.values(agents)) expect(await agent.listAgents()).toEqual({});
  });

  test("configures visible Chrome when browser support is enabled", () => {
    const agents = createToolkitAgents({ browser: true });

    expect(agents.cortex.browser).toBeDefined();
    expect(agents.flux.browser).toBeDefined();
    expect(agents.zen.browser).toBeDefined();
  });
});
