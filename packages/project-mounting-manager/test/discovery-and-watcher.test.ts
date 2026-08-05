import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  discoverProjectSpecialists,
  isProjectResourcePath,
} from "../src/index.js";

describe("project specialist discovery", () => {
  test("lets .mastracode override a same-ID GitHub specialist", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-specialists-"));
    await mkdir(join(root, ".github", "agents"), { recursive: true });
    await mkdir(join(root, ".mastracode", "agents"), { recursive: true });
    await writeFile(join(root, ".github", "agents", "review.md"), specialist("GitHub"));
    await writeFile(join(root, ".mastracode", "agents", "review.agent.md"), specialist("Mastra Code"));

    const specialists = await discoverProjectSpecialists(root, {
      resolveSpecialistModel: alias => `openai/${alias ?? "default"}`,
    });

    expect(specialists.get("review")?.description).toBe("Mastra Code");
    expect(specialists.get("review")?.source).toBe(".mastracode/agents/review.agent.md");
  });

  test("rejects specialist symlinks instead of following them outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-specialists-root-"));
    const outside = await mkdtemp(join(tmpdir(), "project-specialists-outside-"));
    await mkdir(join(root, ".github", "agents"), { recursive: true });
    await writeFile(join(outside, "escape.md"), specialist("Escape"));
    await symlink(join(outside, "escape.md"), join(root, ".github", "agents", "escape.md"));

    await expect(discoverProjectSpecialists(root, {
      resolveSpecialistModel: alias => `openai/${alias ?? "default"}`,
    })).rejects.toThrow(/symbolic link/i);
  });
});

describe("project watcher scope", () => {
  test("accepts project resource paths and rejects unrelated or escaping paths", () => {
    expect(isProjectResourcePath("/workspace/project", ".mastracode/workflow/demo.ts")).toBe(true);
    expect(isProjectResourcePath("/workspace/project", ".github/agents/review.md")).toBe(true);
    expect(isProjectResourcePath("/workspace/project", "src/index.ts")).toBe(false);
    expect(isProjectResourcePath("/workspace/project", "../other/.mastracode/workflow/demo.ts")).toBe(false);
  });
});

function specialist(description: string): string {
  return `---\ndescription: ${description}\n---\n\nReview the project.`;
}
