import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, test } from "vitest";
import {
  browserActionRequiresApproval,
  createRunBudgetHooks,
  createToolAuditHooks,
  RUN_CONTAINMENT_POLICY,
} from "../src/index.js";

describe("agent tool policies", () => {
  test("exports the canonical run containment policy used by host descriptors", () => {
    expect(RUN_CONTAINMENT_POLICY).toEqual({
      maxToolCalls: 64,
      maxDelegations: 8,
      maxRetainedOutputChars: 256_000,
      maxWallClockMs: 1_200_000,
      duplicateScopes: "reject",
      uncertainRemoteWrites: "reconcile-before-retry",
    });
  });

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

    const supervisorHooks = createRunBudgetHooks(() => 1_000);
    const supervisorContext = { requestContext: new RequestContext() };
    const supervisorCall = {
      toolName: "agent-cortex",
      input: { task: "inspect the canonical registry" },
      context: supervisorContext,
    };
    await supervisorHooks.beforeToolCall?.(supervisorCall);
    expect(() => supervisorHooks.beforeToolCall?.(supervisorCall)).toThrow(/Duplicate in-flight scope/);
    await supervisorHooks.afterToolCall?.({ ...supervisorCall, output: "done" });
    expect(() => supervisorHooks.beforeToolCall?.(supervisorCall)).toThrow(/No progress detected/);

    const supervisorBudgetContext = { requestContext: new RequestContext() };
    for (let index = 0; index < 8; index += 1) {
      const call = { toolName: "agent-flux", input: { task: `scope-${index}` }, context: supervisorBudgetContext };
      await supervisorHooks.beforeToolCall?.(call);
      await supervisorHooks.afterToolCall?.({ ...call, output: "done" });
    }
    expect(() => supervisorHooks.beforeToolCall?.({
      toolName: "agent-zen",
      input: { task: "scope-9" },
      context: supervisorBudgetContext,
    })).toThrow(/delegation limit/);

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
      "index.ts",
    ].map(path => readFile(join(import.meta.dirname, "..", "src", path), "utf8")));
    expect(source.join("\n")).not.toMatch(/agents-roles|code-sdk|factory/i);
  });
});
