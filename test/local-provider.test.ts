import { describe, expect, test } from "vitest";
import { normalizeModelReferences, normalizeStoredModelId } from "../src/factory/local-provider.js";

describe("local A1 provider migration", () => {
  test.each([
    ["a1-proxy/gpt-5.6-luna", "mastracode/gpt-5.6-luna"],
    ["mastracode/a1-proxy/gpt-5.6-luna", "mastracode/gpt-5.6-luna"],
    ["mastracode/gpt-5.6-luna", "mastracode/gpt-5.6-luna"],
    ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeStoredModelId(input)).toBe(expected);
  });

  test("migrates nested thread model references without changing unrelated metadata", () => {
    const result = normalizeModelReferences({
      currentModelId: "mastracode/a1-proxy/gpt-5.6-luna",
      modes: ["a1-proxy/gpt-5.6-luna"],
      projectPath: "/workspace/a1-proxy/example",
    });

    expect(result).toEqual({
      changed: true,
      value: {
        currentModelId: "mastracode/gpt-5.6-luna",
        modes: ["mastracode/gpt-5.6-luna"],
        projectPath: "/workspace/a1-proxy/example",
      },
    });
  });
});
