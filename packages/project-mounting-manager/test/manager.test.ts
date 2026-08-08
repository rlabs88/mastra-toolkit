import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import {
  ProjectMountingManager,
  type HostGenerationRegistration,
  type McpLifecyclePort,
  type PreparedMcpGeneration,
  type PreparedHostRegistration,
  type StagedHostRegistrationPort,
} from "../src/index.js";

describe("ProjectMountingManager", () => {
  test("publishes one complete generation and gives unrestricted specialists every explicitly published tool", async () => {
    const projectRoot = await projectFixture();
    const host = new RecordingHost();
    const mcp = new RecordingMcp();
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp,
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      host,
    });

    const generation = manager.snapshot();
    const specialistTools = await generation.specialistAgents.get("review")!.listTools();

    expect(generation.id).toBe(1);
    expect(Object.keys(specialistTools).sort()).toEqual(["host_read", "mcp_lookup", "workflow_demo"]);
    expect(Object.keys(manager.getTools()).sort()).toEqual([
      "host_read",
      "mcp_lookup",
      "project_specialist",
      "workflow_demo",
    ]);
    expect(generation.workflows.get("private")?.tool).toBeUndefined();
    expect(host.current?.generation.id).toBe(1);
  });

  test("rolls prepared resources back and retains the last-known-good generation when host commit fails", async () => {
    const projectRoot = await projectFixture();
    const host = new RecordingHost();
    const mcp = new RecordingMcp();
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp,
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      host,
    });
    const first = manager.snapshot();
    host.failNextCommit = true;

    await expect(manager.reload()).rejects.toThrow("host commit failed");

    expect(manager.snapshot()).toBe(first);
    expect(host.current?.generation.id).toBe(1);
    expect(host.current?.generation.specialistAgents).toBe(first.specialistAgents);
    expect(host.current?.generation.workflows).toBe(first.workflows);
    expect(host.rollbackCount).toBe(1);
    expect(mcp.currentGeneration).toBe(1);
    expect(mcp.rollbackCount).toBe(1);
    expect(manager.diagnostics().at(-1)?.phase).toBe("commit");
  });

  test("does not publish a host generation when MCP commit fails", async () => {
    const projectRoot = await projectFixture();
    const host = new RecordingHost();
    const mcp = new RecordingMcp();
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp,
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      host,
    });
    const first = manager.snapshot();
    mcp.failNextCommit = true;

    await expect(manager.reload()).rejects.toThrow("MCP commit failed");

    expect(manager.snapshot()).toBe(first);
    expect(host.current?.generation.id).toBe(1);
    expect(mcp.currentGeneration).toBe(1);
    expect(host.rollbackCount).toBe(1);
    expect(mcp.rollbackCount).toBe(1);
  });

  test("rejects an invalid specialist tool selection before host publication", async () => {
    const projectRoot = await projectFixture();
    const host = new RecordingHost();
    const mcp = new RecordingMcp();
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp,
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      host,
    });
    const first = manager.snapshot();
    await writeFile(
      join(projectRoot, ".github", "agents", "review.md"),
      "---\ndescription: Review the project\ntools: [missing_tool]\n---\n\nReview the current project.",
    );

    await expect(manager.reload()).rejects.toThrow("Unknown tool for specialist review: missing_tool");

    expect(manager.snapshot()).toBe(first);
    expect(host.current?.generation.id).toBe(1);
    expect(mcp.currentGeneration).toBe(1);
    expect(mcp.rollbackCount).toBe(1);
    expect(manager.diagnostics().at(-1)?.phase).toBe("prepare");
  });

  test("keeps a reserved host tool ID out of an unrestricted project specialist", async () => {
    const projectRoot = await projectFixture();
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp: new RecordingMcp(),
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      reservedToolIds: ["dynamic_workflow"],
      host: new RecordingHost(),
    });

    const specialistTools = await manager.snapshot().specialistAgents.get("review")!.listTools();

    expect(Object.keys(specialistTools).sort()).toEqual(["host_read", "mcp_lookup", "workflow_demo"]);
    expect(specialistTools).not.toHaveProperty("dynamic_workflow");
  });

  test("does not surface a reserved host tool ID through the host bridge", async () => {
    const projectRoot = await projectFixture();
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp: new RecordingMcp(),
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      reservedToolIds: ["dynamic_workflow"],
      host: new RecordingHost(),
    });

    expect(Object.keys(manager.getTools()).sort()).toEqual([
      "host_read",
      "mcp_lookup",
      "project_specialist",
      "workflow_demo",
    ]);
    expect(manager.getTools()).not.toHaveProperty("dynamic_workflow");
  });

  test("still rejects a project workflow whose tool ID shadows a reserved host tool ID", async () => {
    const projectRoot = await projectFixture();
    await writeFile(join(projectRoot, ".mastracode", "workflow", "shadow.ts"), workflow("shadow", true));
    const host = new RecordingHost();
    const mcp = new RecordingMcp();

    await expect(ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp,
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      reservedToolIds: ["workflow_shadow"],
      host,
    })).rejects.toThrow("Duplicate published tool ID: workflow_shadow");

    expect(host.current).toBeUndefined();
    expect(mcp.currentGeneration).toBe(0);
    expect(mcp.rollbackCount).toBe(1);
  });

  test("retains the last-known-good generation when a reload introduces a reserved-ID collision", async () => {
    const projectRoot = await projectFixture();
    const host = new RecordingHost();
    const mcp = new RecordingMcp();
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp,
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      reservedToolIds: ["workflow_shadow"],
      host,
    });
    const first = manager.snapshot();
    await writeFile(join(projectRoot, ".mastracode", "workflow", "shadow.ts"), workflow("shadow", true));

    await expect(manager.reload()).rejects.toThrow("Duplicate published tool ID: workflow_shadow");

    expect(manager.snapshot()).toBe(first);
    expect(host.current?.generation.id).toBe(1);
    expect(mcp.currentGeneration).toBe(1);
    expect(mcp.rollbackCount).toBe(1);
    expect(manager.diagnostics().at(-1)?.phase).toBe("prepare");
  });

  test("refuses a project specialist that asks for a reserved host tool by name", async () => {
    const projectRoot = await projectFixture();
    await writeFile(
      join(projectRoot, ".github", "agents", "review.md"),
      "---\ndescription: Review the project\ntools: [dynamic_workflow]\n---\n\nReview the current project.",
    );

    await expect(ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp: new RecordingMcp(),
      currentTools: { snapshot: () => ({ host_read: tool("host_read") }) },
      reservedToolIds: ["dynamic_workflow"],
      host: new RecordingHost(),
    })).rejects.toThrow("Reserved host tool cannot be granted to specialist review: dynamic_workflow");
  });

  test("returns the value produced by Standard Schema output transformation", async () => {
    const projectRoot = await projectFixture();
    await writeFile(
      join(projectRoot, ".mastracode", "workflow", "transform.ts"),
      transformingWorkflow(),
    );
    const manager = await ProjectMountingManager.create({
      projectRoot,
      modelAliases: { resolveSpecialistModel: alias => `openai/${alias ?? "specialist-default"}` },
      mcp: new RecordingMcp(),
      currentTools: { snapshot: () => ({}) },
      host: new RecordingHost(),
    });
    const workflowTool = manager.snapshot().workflows.get("transform")?.tool;

    await expect(workflowTool?.execute?.({ value: "raw" }, {
      requestContext: new RequestContext(),
    } as never)).resolves.toEqual({
      runId: "transform-run",
      status: "success",
      output: { value: "TRANSFORMED" },
    });
  });
});

class RecordingHost implements StagedHostRegistrationPort {
  current: HostGenerationRegistration | undefined;
  failNextCommit = false;
  rollbackCount = 0;

  async prepare(candidate: HostGenerationRegistration): Promise<PreparedHostRegistration> {
    const previous = this.current;
    return {
      commit: async () => {
        this.current = candidate;
        if (!this.failNextCommit) return;
        this.failNextCommit = false;
        throw new Error("host commit failed");
      },
      rollback: async () => {
        this.current = previous;
        this.rollbackCount += 1;
      },
    };
  }
}

class RecordingMcp implements McpLifecyclePort {
  currentGeneration = 0;
  rollbackCount = 0;
  failNextCommit = false;

  async prepare(): Promise<PreparedMcpGeneration> {
    const candidate = this.currentGeneration + 1;
    const previous = this.currentGeneration;
    return {
      snapshot: () => ({ mcp_lookup: tool("mcp_lookup") }),
      commit: async () => {
        if (this.failNextCommit) {
          this.failNextCommit = false;
          throw new Error("MCP commit failed");
        }
        this.currentGeneration = candidate;
      },
      rollback: async () => {
        this.currentGeneration = previous;
        this.rollbackCount += 1;
      },
    };
  }

  async close(): Promise<void> {}
}

function tool(id: string) {
  return createTool({
    id,
    description: id,
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true }),
  });
}

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-mounting-manager-"));
  await mkdir(join(root, ".github", "agents"), { recursive: true });
  await mkdir(join(root, ".mastracode", "workflow"), { recursive: true });
  await writeFile(
    join(root, ".github", "agents", "review.md"),
    "---\ndescription: Review the project\n---\n\nReview the current project.",
  );
  await writeFile(join(root, ".mastracode", "workflow", "demo.ts"), workflow("demo", true));
  await writeFile(join(root, ".mastracode", "workflow", "private.ts"), workflow("private", false));
  return root;
}

function workflow(id: string, published: boolean): string {
  return `import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
export default createWorkflow({
  id: "${id}",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
}).commit();
${published ? `export const agentTool = { description: "Run ${id}" };` : ""}
`;
}

function transformingWorkflow(): string {
  return `const inputSchema = {
  "~standard": { version: 1, vendor: "fixture", validate: async value => ({ value }) },
};
const outputSchema = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: async () => ({ value: { value: "TRANSFORMED" } }),
  },
};
export const agentTool = { description: "Transform output" };
export default {
  component: "WORKFLOW",
  committed: true,
  id: "transform",
  inputSchema,
  outputSchema,
  createRun: async () => ({
    runId: "transform-run",
    cancel: async () => undefined,
    start: async () => ({ status: "success", result: { value: "raw" } }),
  }),
};
`;
}
