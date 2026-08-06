import { describe, expect, test } from "vitest";
import { createToolkitAgents } from "@rlabs/agents-roles";
import { createSandboxCommandRunTool } from "@rlabs/sandbox";

describe("Mastra agents", () => {
  test("registers Cortex, Flux, and Zen with bounded delegation", async () => {
    const agents = createToolkitAgents({ commandRun: createSandboxCommandRunTool(), browser: false });

    expect(Object.keys(agents)).toEqual(["cortex", "flux", "zen"]);
    expect(Object.keys(await agents.zen.listAgents())).toEqual(["cortex", "flux"]);
    expect(Object.keys(await agents.cortex.listAgents())).toEqual([]);
    expect(Object.keys(await agents.flux.listAgents())).toEqual([]);
  });

  test("configures visible Chrome when browser support is enabled", () => {
    const agents = createToolkitAgents({ commandRun: createSandboxCommandRunTool(), browser: true });

    expect(agents.cortex.browser).toBeDefined();
    expect(agents.flux.browser).toBeDefined();
    expect(agents.zen.browser).toBeDefined();
  });
});

describe("command_run Mastra tool", () => {
  test("requests approval only when a batch contains a mutation", async () => {
    const tool = createSandboxCommandRunTool();
    const approval = tool.requireApproval;
    if (typeof approval !== "function") throw new Error("dynamic approval is not configured");

    const readOnly = await approval({ description: "read", commands: [{ command_type: "read", command_line: '{"path":"README.md"}', step: 1 }] }, {} as never);
    const mutating = await approval({ description: "shell", commands: [{ command_type: "shell", command_line: "true", step: 1 }] }, {} as never);

    expect(readOnly).toBe(false);
    expect(mutating).toBe(true);
  });
});
