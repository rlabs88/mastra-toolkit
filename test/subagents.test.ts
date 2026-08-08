import { describe, expect, test } from "vitest";
import { createCodeSubagents, fillMissingSubagentModelId } from "@rlabs/mcode";
import { createToolkitRuntimeContract } from "@rlabs/mastra-primitives-export";
import { loadModelProfile } from "@rlabs/runtime-config";

describe("canonical subagent model routing", () => {
  test("derives every native descriptor from the contract's distinct role mapping", () => {
    const profile = structuredClone(loadModelProfile());
    profile.roles.cortex = "code-frontier-max";
    profile.roles.flux = "code-workhorse-high";
    profile.roles.zen = "code-economic";
    profile.roles.ayra = "code-frontier-low";
    const descriptors = createCodeSubagents(createToolkitRuntimeContract({ profile }));

    expect(descriptors.map(({ id, defaultModelId }) => ({ id, defaultModelId }))).toEqual([
      { id: "cortex", defaultModelId: "proxy/a1-proxy/code-frontier-max" },
      { id: "flux", defaultModelId: "proxy/a1-proxy/code-workhorse-high" },
      { id: "zen", defaultModelId: "proxy/a1-proxy/code-economic" },
      { id: "ayra", defaultModelId: "proxy/a1-proxy/code-frontier-low" },
    ]);

    for (const [agentType, modelId] of [
      ["cortex", "proxy/a1-proxy/code-frontier-max"],
      ["flux", "proxy/a1-proxy/code-workhorse-high"],
      ["zen", "proxy/a1-proxy/code-economic"],
      ["ayra", "proxy/a1-proxy/code-frontier-low"],
    ] as const) {
      const input = { agentType, task: "Inspect the runtime", modelId: "" };
      fillMissingSubagentModelId(profile, input);
      expect(input.modelId).toBe(modelId);
    }
  });

  test("fills an empty native subagent model with the selected role's runtime model", () => {
    const input = { agentType: "flux", task: "Inspect the runtime", modelId: "" };

    fillMissingSubagentModelId(loadModelProfile(), input);

    expect(input.modelId).toBe("proxy/a1-proxy/code-frontier-high");
  });

  test("preserves an explicit model and ignores unknown targets", () => {
    const explicit = { agentType: "zen", modelId: "proxy/a1-proxy/code-frontier-max" };
    const unknown = { agentType: "unknown", modelId: "" };

    fillMissingSubagentModelId(loadModelProfile(), explicit);
    fillMissingSubagentModelId(loadModelProfile(), unknown);

    expect(explicit.modelId).toBe("proxy/a1-proxy/code-frontier-max");
    expect(unknown.modelId).toBe("");
  });
});
