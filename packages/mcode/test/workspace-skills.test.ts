import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "@rlabs/sandbox";
import { beforeAll, describe, expect, test, vi } from "vitest";

/**
 * The home directory is redirected so this contract is hermetic. Asserting
 * against the developer's real `~/.claude/skills` would pass on the machine
 * that has those skills installed and fail everywhere else, which is the
 * opposite of a contract.
 */
const fixtureHome = mkdtempSync(join(tmpdir(), "mcode-skills-home-"));
const fixtureProject = mkdtempSync(join(tmpdir(), "mcode-skills-project-"));

vi.mock("node:os", async importActual => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fixtureHome }, homedir: () => fixtureHome };
});

function writeSkill(root: string, name: string): void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture skill used to prove ${name} resolves through the MCode workspace.\n---\n\n# ${name}\n\nFixture body.\n`,
  );
}

beforeAll(() => {
  // Ayra's two skills live in the Claude Code convention directory under home.
  writeSkill(join(fixtureHome, ".claude", "skills"), "graph-engineering");
  writeSkill(join(fixtureHome, ".claude", "skills"), "loop-engineering");
  // Already-supported home location, kept so the new path is proven to be an
  // addition rather than a replacement.
  writeSkill(join(fixtureHome, ".agents", "skills"), "fixture-agents-skill");
  // Already-supported workspace location.
  writeSkill(join(fixtureProject, ".claude", "skills"), "fixture-workspace-skill");
});

async function resolveSkillNames(): Promise<string[]> {
  const { createMcodeWorkspace } = await import("../src/index.js");
  const workspace = createMcodeWorkspace(loadSandboxConfig({}), { projectRoot: fixtureProject });
  const skills = await workspace.skills?.list();
  return (skills ?? []).map(skill => skill.name);
}

describe("MCode workspace skill resolution", () => {
  test("resolves Ayra's graph-engineering and loop-engineering skills from home", async () => {
    const names = await resolveSkillNames();

    // Asserts the outcome, not the configuration. Adding the path to the
    // `skills` array alone is not enough: `contained: true` gates reads on
    // `allowedPaths`, so a half-fix degrades to a logged "Permission denied"
    // warning and an empty result instead of an error. This fails loudly there.
    expect(names).toContain("graph-engineering");
    expect(names).toContain("loop-engineering");
  });

  test("keeps the already-supported home and workspace skill locations", async () => {
    const names = await resolveSkillNames();

    expect(names).toContain("fixture-agents-skill");
    expect(names).toContain("fixture-workspace-skill");
  });
});
