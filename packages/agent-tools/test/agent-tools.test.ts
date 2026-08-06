import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, test, vi } from "vitest";
import {
  browserActionRequiresApproval,
  createAdhdTool,
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

  test("runs isolated Flux perspectives and preserves the parent request context", async () => {
    const generate = vi.fn(async (_prompt: string, options: { requestContext: RequestContext }) => ({
      text: JSON.stringify({
        workspaceRoot: options.requestContext.get("workspaceRoot"),
        factoryDelegation: options.requestContext.get("mastraToolkitFactoryDelegation"),
        workspace: options.requestContext.get("mastraToolkitWorkspace"),
        depth: options.requestContext.get("adhdDepth"),
      }),
    }));
    const tool = createAdhdTool(() => ({ generate }) as never);
    const workspace = { id: "sandbox-workspace" };

    const result = await tool.execute?.(
      { problem: "Choose an API", perspectives: ["maintainer", "caller"] },
      {
        requestContext: new RequestContext([
          ["workspaceRoot", "/workspace"],
          ["mastraToolkitFactoryDelegation", true],
          ["mastraToolkitWorkspace", workspace],
        ]),
      } as never,
    );

    expect(generate).toHaveBeenCalledTimes(2);
    const context = JSON.stringify({
      workspaceRoot: "/workspace",
      factoryDelegation: true,
      workspace,
      depth: 1,
    });
    expect(result).toEqual({
      problem: "Choose an API",
      candidates: [
        { perspective: "maintainer", text: context },
        { perspective: "caller", text: context },
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
      "capabilities.ts",
      "command-run-contract.ts",
      "command-run.ts",
      "index.ts",
    ].map(path => readFile(join(import.meta.dirname, "..", "src", path), "utf8")));
    expect(source.join("\n")).not.toMatch(/agents-roles|code-sdk|factory/i);
  });
});
