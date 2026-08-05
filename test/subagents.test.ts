import { describe, expect, test } from "vitest";
import { fillMissingSubagentModelId } from "../src/agents/subagents.js";
import { loadModelProfile } from "../src/models/profile.js";

describe("canonical subagent model routing", () => {
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
