import { describe, expect, test } from "vitest";
import { isProjectResourcePath } from "../src/project/watcher.js";

describe("project resource watcher", () => {
  test.each([
    ".agents/skills/review/SKILL.md",
    ".claude/skills/review/SKILL.md",
    ".claude/settings.local.json",
    ".github/agents/review.agent.md",
    ".mcp.json",
    ".mastracode/agents/review.md",
    ".mastracode/mcp.json",
    ".mastracode/skills/review/SKILL.md",
    ".mastracode/workflow/review.ts",
  ])("accepts trusted resource path %s", path => {
    expect(isProjectResourcePath("/project", path)).toBe(true);
  });

  test.each(["src/index.ts", ".env", "../outside/.mcp.json", ".github/workflows/ci.yml"])(
    "rejects unrelated path %s",
    path => {
      expect(isProjectResourcePath("/project", path)).toBe(false);
    },
  );
});
