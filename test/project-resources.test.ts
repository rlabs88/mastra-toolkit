import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadModelProfile } from "../src/models/profile.js";
import { AtomicResourceStore } from "../src/project/atomic-store.js";
import { loadProjectSpecialists } from "../src/project/specialists.js";
import { loadProjectWorkflows } from "../src/project/workflows.js";

describe("project specialists", () => {
  test("loads both roots and lets .mastracode win a same-ID conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-specialists-"));
    await mkdir(join(root, ".github", "agents"), { recursive: true });
    await mkdir(join(root, ".mastracode", "agents"), { recursive: true });
    await writeFile(join(root, ".github", "agents", "review.md"), specialist("GitHub review"));
    await writeFile(join(root, ".mastracode", "agents", "review.agent.md"), specialist("Mastra review"));

    const specialists = await loadProjectSpecialists(root, loadModelProfile());

    expect(specialists.get("review")?.description).toBe("Mastra review");
    expect(specialists.get("review")?.source).toContain(".mastracode/agents/review.agent.md");
  });

  test("rejects unknown aliases and symlinks outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-specialists-unsafe-"));
    const outside = await mkdtemp(join(tmpdir(), "mastra-specialists-outside-"));
    await mkdir(join(root, ".github", "agents"), { recursive: true });
    await writeFile(join(root, ".github", "agents", "unknown.md"), specialist("Unknown", "gpt-5.6-sol"));

    await expect(loadProjectSpecialists(root, loadModelProfile())).rejects.toThrow(/unknown model alias/i);

    await writeFile(join(outside, "escape.md"), specialist("Escape"));
    await symlink(join(outside, "escape.md"), join(root, ".github", "agents", "escape.md"));
    await expect(loadProjectSpecialists(root, loadModelProfile())).rejects.toThrow(/symbolic link/i);
  });
});

describe("atomic project generations", () => {
  test("keeps the last-known-good generation after candidate validation fails", async () => {
    const store = new AtomicResourceStore({ value: "first" });
    const first = store.snapshot();

    await expect(store.reload(async () => { throw new Error("invalid candidate"); })).rejects.toThrow("invalid candidate");

    expect(store.snapshot()).toBe(first);
    expect(store.snapshot().value).toBe("first");
  });
});

describe("project workflows", () => {
  test("bundles local dependencies and publishes a new content generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-workflows-"));
    const workflowRoot = join(root, ".mastracode", "workflow");
    await mkdir(join(workflowRoot, "lib"), { recursive: true });
    await writeFile(join(workflowRoot, "lib", "message.ts"), "export const message = 'first';\n");
    await writeFile(join(workflowRoot, "demo.ts"), workflowSource());

    const first = await loadProjectWorkflows(root);
    await writeFile(join(workflowRoot, "lib", "message.ts"), "export const message = 'second';\n");
    const second = await loadProjectWorkflows(root);

    expect(first.get("demo")?.workflow.id).toBe("demo");
    expect(first.get("demo")?.tool?.id).toBe("workflow_demo");
    expect(second.get("demo")?.generation).not.toBe(first.get("demo")?.generation);
  });

  test("does not expose a discovered workflow without agentTool metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-workflows-private-"));
    const workflowRoot = join(root, ".mastracode", "workflow");
    await mkdir(join(workflowRoot, "lib"), { recursive: true });
    await writeFile(join(workflowRoot, "lib", "message.ts"), "export const message = 'private';\n");
    await writeFile(join(workflowRoot, "demo.ts"), workflowSource(false));

    const workflows = await loadProjectWorkflows(root);

    expect(workflows.get("demo")?.tool).toBeUndefined();
  });

  test("rejects a workflow whose published schemas are not Standard Schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-workflows-schema-"));
    const workflowRoot = join(root, ".mastracode", "workflow");
    await mkdir(workflowRoot, { recursive: true });
    await writeFile(join(workflowRoot, "invalid.ts"), `
import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
const workflow = createWorkflow({
  id: "invalid",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
}).commit();
Object.defineProperty(workflow, "inputSchema", { value: {} });
export default workflow;
export const agentTool = { description: "Invalid schema" };
`);

    await expect(loadProjectWorkflows(root)).rejects.toThrow(/standard schema/i);
  });
});

function specialist(description: string, model = "code-frontier-high"): string {
  return `---\ndescription: ${description}\nmodel: ${model}\ntools:\n  - read_file\nmetadata:\n  team: runtime\n---\n\nReview the selected project boundary.\n`;
}

function workflowSource(exposed = true): string {
  return `import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { message } from "./lib/message.js";

const step = createStep({
  id: "echo",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string(), message: z.string() }),
  execute: async ({ inputData }) => ({ value: inputData.value, message }),
});

export default createWorkflow({
  id: "demo",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string(), message: z.string() }),
}).then(step).commit();

${exposed ? "export const agentTool = { description: \"Run the demo workflow\" };" : ""}
`;
}
