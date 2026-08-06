import { describe, expect, test } from "vitest";
import { createToolkitAgents } from "@rlabs/agents-roles";
import { loadModelProfile } from "@rlabs/runtime-config";
import { createSandboxCommandRunTool } from "@rlabs/sandbox";
import {
  CODE_MODE_IDS,
  createCodeModes,
  decodeAgentMode,
  encodeAgentMode,
  switchAgent,
  switchMode,
} from "@rlabs/mcode";

describe("Mastra Code canonical modes", () => {
  test("projects three canonical agents into exactly six scope/build modes", () => {
    const agents = createToolkitAgents({ commandRun: createSandboxCommandRunTool(), browser: false });
    const modes = createCodeModes(agents, loadModelProfile());

    expect(modes.map(mode => mode.id)).toEqual(CODE_MODE_IDS);
    expect(modes.find(mode => mode.metadata?.default)?.id).toBe("cortex/build");
    expect(modes.every(mode => mode.availableTools === undefined)).toBe(true);
    expect(modes.find(mode => mode.id === "flux/scope")?.agent).toBe(agents.flux);
    expect(modes.find(mode => mode.id === "zen/build")?.agent).toBe(agents.zen);
  });

  test("keeps agent and mode as independent switches", () => {
    const selection = decodeAgentMode("flux/scope");

    expect(switchAgent(selection, "zen")).toEqual({ agent: "zen", mode: "scope" });
    expect(switchMode(selection, "build")).toEqual({ agent: "flux", mode: "build" });
    expect(encodeAgentMode({ agent: "cortex", mode: "build" })).toBe("cortex/build");
    expect(() => decodeAgentMode("cortex/spec")).toThrow(/invalid agent mode/i);
  });

  test("uses shared prompt overlays without changing tools or permissions", () => {
    const agents = createToolkitAgents({ commandRun: createSandboxCommandRunTool(), browser: false });
    const modes = createCodeModes(agents, loadModelProfile());
    const cortexScope = modes.find(mode => mode.id === "cortex/scope");
    const cortexBuild = modes.find(mode => mode.id === "cortex/build");

    expect(cortexScope?.instructions).toContain("Scope mode");
    expect(cortexBuild?.instructions).toContain("Build mode");
    expect(cortexScope?.additionalTools).toBe(cortexBuild?.additionalTools);
    expect(cortexScope?.availableTools).toBeUndefined();
    expect(cortexBuild?.availableTools).toBeUndefined();
  });
});
