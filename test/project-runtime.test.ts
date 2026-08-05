import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { describe, expect, test } from "vitest";
import { loadModelProfile } from "../src/models/profile.js";
import { ProjectResourceRuntime, type ProjectMcpRuntime } from "../src/project/runtime.js";

describe("ProjectResourceRuntime", () => {
  test("publishes complete generations and retains the last-known-good snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-project-runtime-"));
    await mkdir(join(root, ".github", "agents"), { recursive: true });
    await writeFile(join(root, ".github", "agents", "review.md"), specialist("Initial"));
    const mastra = new Mastra();
    const runtime = await ProjectResourceRuntime.create({
      projectRoot: root,
      profile: loadModelProfile(),
      mastra,
      mcp: fakeMcpRuntime(),
    });
    const first = runtime.snapshot();

    await writeFile(join(root, ".github", "agents", "review.md"), specialist("Broken", "raw-model"));
    await expect(runtime.reload()).rejects.toThrow(/unknown model alias/i);

    expect(runtime.snapshot()).toBe(first);
    expect(runtime.snapshot().specialists.get("review")?.description).toBe("Initial");
  });

  test("exposes current workflow, specialist, and MCP tools from one generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-project-tools-"));
    await mkdir(join(root, ".mastracode", "agents"), { recursive: true });
    await writeFile(join(root, ".mastracode", "agents", "review.md"), specialist("Review"));
    const runtime = await ProjectResourceRuntime.create({
      projectRoot: root,
      profile: loadModelProfile(),
      mastra: new Mastra(),
      mcp: fakeMcpRuntime(),
    });

    expect(Object.keys(runtime.getTools())).toEqual(["mcp_example", "project_specialist"]);
    expect(runtime.snapshot().specialistAgents.has("review")).toBe(true);
  });

  test("rolls MCP back when a later candidate validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-project-mcp-rollback-"));
    await mkdir(join(root, ".github", "agents"), { recursive: true });
    await writeFile(join(root, ".github", "agents", "review.md"), specialist("Review"));
    const mcp = transactionalMcpRuntime();
    const runtime = await ProjectResourceRuntime.create({
      projectRoot: root,
      profile: loadModelProfile(),
      mastra: new Mastra(),
      mcp,
    });

    await writeFile(
      join(root, ".github", "agents", "review.md"),
      `---\ndescription: Review\ntools: [missing_tool]\n---\n\nReview the project.\n`,
    );
    await expect(runtime.reload()).rejects.toThrow(/unknown tool/i);

    expect(Object.keys(mcp.getTools())).toEqual(["mcp_generation_1"]);
    expect(runtime.snapshot().id).toBe(1);
  });
});

function specialist(description: string, model = "code-frontier-high"): string {
  return `---\ndescription: ${description}\nmodel: ${model}\n---\n\nReview the project.\n`;
}

function fakeMcpRuntime(): ProjectMcpRuntime {
  return {
    async reload() {},
    getTools: () => ({ mcp_example: { execute: async () => "ok" } }),
    async close() {},
  };
}

function transactionalMcpRuntime(): ProjectMcpRuntime {
  let generation = 0;
  return {
    async reload() { generation += 1; },
    async rollback() { generation -= 1; },
    getTools: () => ({ [`mcp_generation_${generation}`]: { execute: async () => "ok" } }),
    async close() {},
  };
}
