import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, test, vi } from "vitest";
import {
  browserActionRequiresApproval,
  createAdhdTool,
  createCommandRunTool,
  createToolAuditHooks,
} from "../src/index.js";

describe("agent tool policies", () => {
  test("requires approval for page mutations but not tab inspection", () => {
    expect(browserActionRequiresApproval("stagehand_tabs", { action: "list" })).toBe(false);
    expect(browserActionRequiresApproval("stagehand_tabs", { action: "close" })).toBe(true);
    expect(browserActionRequiresApproval("stagehand_navigate", {})).toBe(true);
    expect(browserActionRequiresApproval("stagehand_extract", {})).toBe(false);
  });

  test("emits start, completion, and failure audit events", async () => {
    const events: Array<{ phase: string; toolName: string; error?: string }> = [];
    const hooks = createToolAuditHooks(event => events.push(event));

    await hooks.beforeToolCall?.({ toolName: "read" } as never);
    await hooks.afterToolCall?.({ toolName: "read" } as never);
    await hooks.afterToolCall?.({ toolName: "shell", error: new Error("denied") } as never);

    expect(events.map(({ phase, toolName, error }) => ({ phase, toolName, error }))).toEqual([
      { phase: "start", toolName: "read", error: undefined },
      { phase: "complete", toolName: "read", error: undefined },
      { phase: "failed", toolName: "shell", error: "denied" },
    ]);
  });

  test("requests approval when a command batch contains a mutation", async () => {
    const tool = createCommandRunTool({ workspaceRoot: process.cwd() });
    const approval = tool.requireApproval;
    if (typeof approval !== "function") throw new Error("dynamic approval is not configured");

    const readOnly = await approval({ description: "read", commands: [{ command_type: "read", command_line: '{"path":"README.md"}', step: 1 }] }, {} as never);
    const mutating = await approval({ description: "shell", commands: [{ command_type: "shell", command_line: "true", step: 1 }] }, {} as never);

    expect(readOnly).toBe(false);
    expect(mutating).toBe(true);
  });

  test("runs isolated Flux perspectives and preserves the workspace root", async () => {
    const generate = vi.fn(async (_prompt: string, options: { requestContext: RequestContext }) => ({
      text: String(options.requestContext.get("workspaceRoot")),
    }));
    const tool = createAdhdTool(() => ({ generate }) as never);

    const result = await tool.execute?.(
      { problem: "Choose an API", perspectives: ["maintainer", "caller"] },
      { requestContext: new RequestContext([["workspaceRoot", "/workspace"]]) } as never,
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      problem: "Choose an API",
      candidates: [
        { perspective: "maintainer", text: "/workspace" },
        { perspective: "caller", text: "/workspace" },
      ],
    });
  });

  test("rejects nested ADHD exploration", async () => {
    const tool = createAdhdTool(() => ({ generate: vi.fn() }) as never);

    await expect(tool.execute?.(
      { problem: "Choose an API", perspectives: ["maintainer", "caller"] },
      { requestContext: new RequestContext([["adhdDepth", 1]]) } as never,
    )).rejects.toThrow(/Nested adhd_run/);
  });

  test("does not import role, Code SDK, or Factory code", async () => {
    const source = await Promise.all([
      "adhd.ts",
      "audit.ts",
      "browser.ts",
      "index.ts",
    ].map(path => readFile(join(import.meta.dirname, "..", "src", path), "utf8")));
    const commandRun = await readFile(join(import.meta.dirname, "..", "src", "command-run", "index.ts"), "utf8");

    expect([...source, commandRun].join("\n")).not.toMatch(/agents-roles|code-sdk|factory/i);
  });
});
