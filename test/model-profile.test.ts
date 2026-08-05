import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTIVE_ALIAS,
  DEFAULT_OBSERVER_ALIAS,
  loadModelProfile,
  resolveAliasModelId,
} from "../src/models/profile.js";

describe("model profile", () => {
  test("loads the stable A1 proxy catalog and role defaults", () => {
    const profile = loadModelProfile();

    expect(profile.provider.id).toBe("a1-proxy");
    expect(profile.aliases).toEqual([
      "primary",
      "gpt-4o",
      "secondary",
      "third",
      "code-frontier-max",
      "code-frontier-high",
      "code-frontier-low",
      "code-workhorse-high",
      "code-workhorse-low",
      "code-economic",
      "fast",
      "fast-high",
      "fast-low",
    ]);
    expect(profile.roles).toMatchObject({
      cortex: DEFAULT_ACTIVE_ALIAS,
      flux: DEFAULT_ACTIVE_ALIAS,
      zen: DEFAULT_ACTIVE_ALIAS,
      specialist: DEFAULT_ACTIVE_ALIAS,
      observer: DEFAULT_OBSERVER_ALIAS,
      reflector: DEFAULT_OBSERVER_ALIAS,
    });
  });

  test("resolves only catalog aliases and rejects raw upstream IDs", () => {
    const profile = loadModelProfile();

    expect(resolveAliasModelId(profile, "code-frontier-high")).toBe("a1-proxy/code-frontier-high");
    expect(() => resolveAliasModelId(profile, "gpt-5.6-sol")).toThrow(/unknown model alias/i);
    expect(() => resolveAliasModelId(profile, "openai\/gpt-5.6-sol")).toThrow(/unknown model alias/i);
  });
});
