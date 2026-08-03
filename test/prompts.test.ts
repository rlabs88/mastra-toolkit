import { describe, expect, test } from "vitest";
import { ARCHETYPES, composePrompt } from "../src/agents/archetypes.js";

describe("agent archetypes", () => {
  test.each(["cortex", "flux", "zen"] as const)("%s has the six prompt sections", id => {
    const prompt = composePrompt(ARCHETYPES[id]);
    const headings = prompt.match(/^# .+$/gm);

    expect(headings).toEqual([
      "# Base Identity",
      "# Role Identity",
      "# Shared Security",
      "# Role Security Additions",
      "# Base Task Behavior",
      "# Role Task Behavior",
    ]);
  });

  test("keeps the just-oc model policies", () => {
    expect(ARCHETYPES.cortex.model).toEqual({ id: "openai/gpt-5.6-luna", temperature: 0.2, steps: 80 });
    expect(ARCHETYPES.flux.model).toEqual({ id: "openai/gpt-5.6-luna", temperature: 0.7, steps: 80 });
    expect(ARCHETYPES.zen.model).toEqual({ id: "openai/gpt-5.6-luna", temperature: 0.1, steps: 48 });
  });
});
