import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, test, vi } from "vitest";
import {
  browserActionRequiresApproval,
  createAdhdTool,
  createRunBudgetHooks,
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

  test("bounds fan-out and retained candidate payloads", async () => {
    let active = 0;
    let maximumActive = 0;
    const signals: AbortSignal[] = [];
    const generate = vi.fn(async (_prompt: string, options: { abortSignal: AbortSignal }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      signals.push(options.abortSignal);
      await Promise.resolve();
      active -= 1;
      return { text: "x".repeat(20_000) };
    });
    const tool = createAdhdTool(() => ({ generate }) as never);
    const perspectives = ["one", "two", "three", "four", "five", "six"];

    const result = await tool.execute?.(
      { problem: "Bound this run", perspectives },
      { requestContext: new RequestContext() } as never,
    ) as { candidates: Array<{ text: string }> };

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(signals).toHaveLength(6);
    expect(result.candidates.reduce((total, candidate) => total + candidate.text.length, 0))
      .toBeLessThanOrEqual(24_000);
    expect(result.candidates.some(candidate => candidate.text.endsWith("…"))).toBe(true);
  });

  test("rejects duplicate investigation scopes before execution", async () => {
    const tool = createAdhdTool(() => ({ generate: vi.fn() }) as never);
    const result = await tool.execute?.(
      { problem: "Avoid repeated work", perspectives: ["Repository inventory", " repository INVENTORY "] },
      { requestContext: new RequestContext() } as never,
    ) as { message: string };
    expect(result.message).toMatch(/distinct/i);
  });

  test("terminates duplicate scopes and repeated remote writes with a bounded diagnostic", async () => {
    const hooks = createRunBudgetHooks(() => 1_000);
    const requestContext = new RequestContext();
    const context = { requestContext };
    const subagent = { toolName: "subagent", input: { agentType: "flux", task: "inventory" }, context };
    await hooks.beforeToolCall?.(subagent);
    expect(() => hooks.beforeToolCall?.(subagent)).toThrow(/Duplicate in-flight scope/);
    await hooks.afterToolCall?.({ ...subagent, output: "done" });
    expect(() => hooks.beforeToolCall?.(subagent)).toThrow(/No progress detected/);

    const write = { toolName: "create_github_issue", input: { title: "Architecture" }, context };
    await hooks.beforeToolCall?.(write);
    await hooks.afterToolCall?.({ ...write, output: { number: 1 } });
    expect(() => hooks.beforeToolCall?.(write)).toThrow(/No progress detected/);

    const uncertainWrite = { toolName: "github_issue_comment", input: { issue: 1, body: "proposal" }, context };
    await hooks.beforeToolCall?.(uncertainWrite);
    await hooks.afterToolCall?.({ ...uncertainWrite, error: new Error("connection closed") });
    expect(() => hooks.beforeToolCall?.(uncertainWrite)).toThrow(/reconcile before retrying/);
  });

  test("bounds aggregate delegation and retained tool output for one top-level run", async () => {
    const hooks = createRunBudgetHooks(() => 1_000);
    const requestContext = new RequestContext();
    const context = { requestContext };

    for (let index = 0; index < 8; index += 1) {
      const call = { toolName: "subagent", input: { task: `scope-${index}` }, context };
      await hooks.beforeToolCall?.(call);
      await hooks.afterToolCall?.({ ...call, output: "done" });
    }
    expect(() => hooks.beforeToolCall?.({ toolName: "subagent", input: { task: "scope-9" }, context }))
      .toThrow(/delegation limit/);

    const retainedContext = { requestContext: new RequestContext() };
    const retainedCall = {
      toolName: "read",
      input: {},
      context: retainedContext,
    };
    await hooks.beforeToolCall?.(retainedCall);
    expect(() => hooks.afterToolCall?.({
      ...retainedCall,
      output: "x".repeat(256_001),
    })).toThrow(/retained tool output limit/);
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
