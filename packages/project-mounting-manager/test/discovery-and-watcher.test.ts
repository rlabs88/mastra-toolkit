import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  discoverProjectSpecialists,
  discoverProjectWorkflows,
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

describe("project workflow layout", () => {
  test("bundles a helper subdirectory into the entrypoint and repropagates helper edits", async () => {
    const { root, workflowDirectory } = await projectFixture("multi-file");
    await mkdir(join(workflowDirectory, "steps"), { recursive: true });
    await writeFile(join(workflowDirectory, "flow.ts"), workflowEntrypoint("flow", "./steps/one.js"));
    await writeFile(join(workflowDirectory, "steps", "one.ts"), helperModule("first"));

    const first = await discoverProjectWorkflows(root);
    expect([...first.keys()]).toEqual(["flow"]);
    expect(first.get("flow")?.source).toBe(".mastracode/workflow/flow.ts");

    await writeFile(join(workflowDirectory, "steps", "one.ts"), helperModule("second"));
    const second = await discoverProjectWorkflows(root);

    expect([...second.keys()]).toEqual(["flow"]);
    expect(second.get("flow")?.generation).not.toBe(first.get("flow")?.generation);
  }, 30_000);

  test("rejects a relative helper import that escapes the project root", async () => {
    const { base, root, workflowDirectory } = await projectFixture("relative-escape");
    await mkdir(join(base, "outside"), { recursive: true });
    await writeFile(join(base, "outside", "evil.ts"), helperModule("evil"));
    await writeFile(
      join(workflowDirectory, "flow.ts"),
      workflowEntrypoint("flow", "../../../outside/evil.js"),
    );

    await expect(discoverProjectWorkflows(root)).rejects.toThrow(/escapes the project root/);
  }, 30_000);

  test("rejects an absolute helper import outside the project root", async () => {
    const { base, root, workflowDirectory } = await projectFixture("absolute-escape");
    await mkdir(join(base, "outside"), { recursive: true });
    await writeFile(join(base, "outside", "evil.ts"), helperModule("evil"));
    await writeFile(
      join(workflowDirectory, "flow.ts"),
      workflowEntrypoint("flow", join(base, "outside", "evil.js")),
    );

    await expect(discoverProjectWorkflows(root)).rejects.toThrow(/escapes the project root/);
  }, 30_000);

  test("rejects an absolute helper import that does not exist on disk", async () => {
    const { root, workflowDirectory } = await projectFixture("absolute-missing");
    await writeFile(join(workflowDirectory, "flow.ts"), workflowEntrypoint("flow", "/etc/anything.js"));

    await expect(discoverProjectWorkflows(root)).rejects.toThrow(/escapes the project root/);
  }, 30_000);

  test("rejects a helper subdirectory entry symlinked outside the project root", async () => {
    const { base, root, workflowDirectory } = await projectFixture("symlink-escape");
    await mkdir(join(base, "outside"), { recursive: true });
    await mkdir(join(workflowDirectory, "steps"), { recursive: true });
    await writeFile(join(base, "outside", "evil.ts"), helperModule("evil"));
    await symlink(join(base, "outside", "evil.ts"), join(workflowDirectory, "steps", "link.ts"));
    await writeFile(join(workflowDirectory, "flow.ts"), workflowEntrypoint("flow", "./steps/link.js"));

    await expect(discoverProjectWorkflows(root)).rejects.toThrow(/escapes the project root/);
  }, 30_000);

  test("names the helper-subdirectory layout when a flat sibling is not a workflow", async () => {
    const { root, workflowDirectory } = await projectFixture("flat-helper");
    await writeFile(join(workflowDirectory, "flow.ts"), workflowEntrypoint("flow", "./steps.js"));
    await writeFile(join(workflowDirectory, "steps.ts"), helperModule("flat"));

    const failure = await discoverProjectWorkflows(root).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/must default-export a committed Mastra Workflow/);
    expect((failure as Error).message).toMatch(/\.mastracode\/workflow\/steps\.ts/);
    expect((failure as Error).message).toMatch(/subdirectory/i);
  }, 30_000);

  test("ignores declaration files in every module extension", async () => {
    const { root, workflowDirectory } = await projectFixture("declarations");
    await mkdir(join(workflowDirectory, "steps"), { recursive: true });
    await writeFile(join(workflowDirectory, "flow.ts"), workflowEntrypoint("flow", "./steps/one.js"));
    await writeFile(join(workflowDirectory, "steps", "one.ts"), helperModule("first"));
    await writeFile(join(workflowDirectory, "types.d.ts"), "export type Unused = string;\n");
    await writeFile(join(workflowDirectory, "types.d.mts"), "export type Unused = string;\n");
    await writeFile(join(workflowDirectory, "types.d.cts"), "export type Unused = string;\n");

    const workflows = await discoverProjectWorkflows(root);

    expect([...workflows.keys()]).toEqual(["flow"]);
  }, 30_000);

  test("resolves a bare import from the importing helper's own resolution scope", async () => {
    const { root, workflowDirectory } = await projectFixture("helper-scope");
    const scopedPackage = join(workflowDirectory, "steps", "node_modules", "scoped-helper");
    await mkdir(scopedPackage, { recursive: true });
    await writeFile(
      join(scopedPackage, "package.json"),
      JSON.stringify({ name: "scoped-helper", version: "1.0.0", type: "module", exports: "./index.mjs" }),
    );
    await writeFile(join(scopedPackage, "index.mjs"), 'export const scopedValue = "scoped";\n');
    await writeFile(join(workflowDirectory, "flow.ts"), workflowEntrypoint("flow", "./steps/one.js"));
    await writeFile(
      join(workflowDirectory, "steps", "one.ts"),
      'import { scopedValue } from "scoped-helper";\n\nexport const helperValue = scopedValue;\n',
    );

    const workflows = await discoverProjectWorkflows(root);

    expect([...workflows.keys()]).toEqual(["flow"]);
  }, 30_000);
});

async function projectFixture(label: string): Promise<{
  base: string;
  root: string;
  workflowDirectory: string;
}> {
  const base = await mkdtemp(join(tmpdir(), `project-workflow-${label}-`));
  const root = join(base, "project");
  const workflowDirectory = join(root, ".mastracode", "workflow");
  await mkdir(workflowDirectory, { recursive: true });
  return { base, root, workflowDirectory };
}

function workflowEntrypoint(id: string, helperSpecifier: string): string {
  return `import { helperValue } from ${JSON.stringify(helperSpecifier)};

const schema = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: (value: unknown) => ({ value }),
  },
};

export default {
  component: "WORKFLOW",
  committed: true,
  id: ${JSON.stringify(id)},
  helperValue,
  inputSchema: schema,
  outputSchema: schema,
  createRun: async () => ({
    runId: ${JSON.stringify(`${id}-run`)},
    cancel: async () => undefined,
    start: async () => ({ status: "success", result: { helperValue } }),
  }),
};
`;
}

function helperModule(value: string): string {
  return `export const helperValue = ${JSON.stringify(value)};\n`;
}

function specialist(description: string): string {
  return `---\ndescription: ${description}\n---\n\nReview the project.`;
}
