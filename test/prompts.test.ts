import { describe, expect, test } from "vitest";
import { ARCHETYPES, composePrompt } from "@rlabs/agents-roles";


describe("agent archetypes", () => {
  test.each(["cortex", "flux", "zen", "ayra"] as const)("%s has the six prompt sections", id => {
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
    expect(ARCHETYPES.cortex.model).toEqual({ id: "code-frontier-high", temperature: 0.2, steps: 80 });
    expect(ARCHETYPES.flux.model).toEqual({ id: "code-frontier-high", temperature: 0.7, steps: 80 });
    expect(ARCHETYPES.zen.model).toEqual({ id: "code-frontier-high", temperature: 0.1, steps: 48 });
    expect(ARCHETYPES.ayra.model).toEqual({ id: "code-frontier-high", temperature: 0.3, steps: 80 });
  });

  test("gives every archetype the dynamic_workflow and subagent distinction", () => {
    for (const id of ["cortex", "flux", "zen", "ayra"] as const) {
      const prompt = composePrompt(ARCHETYPES[id]);

      expect(prompt).toMatch(/`dynamic_workflow` authors/);
      expect(prompt).toMatch(/native `subagent` tool runs one bounded delegation/);
    }
  });

  test("makes Ayra the agent provisioner and primary dynamic-workflow author", () => {
    const prompt = composePrompt(ARCHETYPES.ayra);

    expect(prompt).toMatch(/provisions? domain-focused agents/i);
    expect(prompt).toMatch(/graph-engineering/);
    expect(prompt).toMatch(/loop-engineering/);
  });
});
