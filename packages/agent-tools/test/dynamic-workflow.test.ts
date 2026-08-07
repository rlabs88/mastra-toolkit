import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createDynamicWorkflowTool,
  DYNAMIC_WORKFLOW_DEPTH_CONTEXT_KEY,
  DYNAMIC_WORKFLOW_ORIGIN,
  reconcileDynamicWorkflowDefinitions,
} from "../src/index.js";

const helper = createWorkflow({
  id: "helper",
  inputSchema: z.object({ task: z.string() }),
  outputSchema: z.object({ done: z.string() }),
}).then(createStep({
  id: "run-helper",
  inputSchema: z.object({ task: z.string() }),
  outputSchema: z.object({ done: z.string() }),
  execute: async ({ inputData }) => ({ done: `handled:${inputData.task}` }),
})).commit();

function harness() {
  const mastra = new Mastra({
    agents: {
      flux: new Agent({ id: "flux", name: "flux", instructions: "test", model: "openai/gpt-4o-mini" }),
    },
    workflows: { helper },
    storage: new InMemoryStore(),
    logger: false as never,
  });
  const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
  const invoke = (input: unknown, requestContext = new RequestContext()) =>
    (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute(input, { mastra, requestContext });
  return { mastra, tool, invoke };
}

const objectSchema = { type: "object", properties: { task: { type: "string" } }, required: ["task"] };
const doneSchema = { type: "object", properties: { done: { type: "string" } }, required: ["done"] };

const nestedGraph = {
  inputSchema: objectSchema,
  outputSchema: doneSchema,
  graph: [{ type: "workflow", id: "h", workflowId: "helper" }],
};

describe("dynamic_workflow", () => {
  test("requires approval to run or resume but not to validate or inspect", () => {
    const { tool } = harness();
    const requireApproval = (tool as unknown as {
      requireApproval: (input: unknown) => boolean;
    }).requireApproval;

    expect(requireApproval({ action: "run", dryRun: false })).toBe(true);
    expect(requireApproval({ action: "run", dryRun: true })).toBe(false);
    expect(requireApproval({ action: "resume" })).toBe(true);
    expect(requireApproval({ action: "inspect" })).toBe(false);
  });

  test("derives a content-addressed id so an identical graph is idempotent", async () => {
    const { invoke } = harness();

    const first = await invoke({ action: "run", description: "d", definition: nestedGraph, input: {}, dryRun: true, timeoutMs: 1_000 });
    const again = await invoke({ action: "run", description: "d", definition: nestedGraph, input: {}, dryRun: true, timeoutMs: 1_000 });
    const other = await invoke({
      action: "run",
      description: "d",
      dryRun: true,
      timeoutMs: 1_000,
      input: {},
      definition: { ...nestedGraph, graph: [{ type: "workflow", id: "different", workflowId: "helper" }] },
    });

    expect(first.status).toBe("validated");
    expect(first.workflowId).toMatch(/^dyn_[0-9a-f]{16}$/);
    expect(again.workflowId).toBe(first.workflowId);
    expect(other.workflowId).not.toBe(first.workflowId);
  });

  test("rejects an agent outside the injected allowlist", async () => {
    const { invoke } = harness();

    const result = await invoke({
      action: "run",
      description: "d",
      dryRun: true,
      timeoutMs: 1_000,
      input: {},
      definition: { ...nestedGraph, graph: [{ type: "agent", id: "a", agentId: "cortex" }] },
    });

    expect(result.status).toBe("invalid");
    expect((result.issues as string[]).join(" ")).toContain('unknown agent "cortex"');
  });

  test("rejects a nested workflow outside the injected allowlist", async () => {
    const { invoke } = harness();

    const result = await invoke({
      action: "run",
      description: "d",
      dryRun: true,
      timeoutMs: 1_000,
      input: {},
      definition: { ...nestedGraph, graph: [{ type: "workflow", id: "x", workflowId: "helper-2" }] },
    });

    expect(result.status).toBe("invalid");
    expect((result.issues as string[]).join(" ")).toContain("not allowlisted");
  });

  test("rejects duplicate step ids", async () => {
    const { invoke } = harness();

    const result = await invoke({
      action: "run",
      description: "d",
      dryRun: true,
      timeoutMs: 1_000,
      input: {},
      definition: {
        ...nestedGraph,
        graph: [
          { type: "agent", id: "same", agentId: "flux" },
          { type: "agent", id: "same", agentId: "flux" },
        ],
      },
    });

    expect(result.status).toBe("invalid");
    expect((result.issues as string[]).join(" ")).toContain('duplicate step id "same"');
  });

  test("admits no code-carrying or unbounded step type", () => {
    const { tool } = harness();
    const schema = (tool as unknown as {
      inputSchema: { safeParse(value: unknown): { success: boolean } };
    }).inputSchema;
    const withGraph = (entry: unknown) => schema.safeParse({
      action: "run",
      description: "d",
      definition: { ...nestedGraph, graph: [entry] },
    }).success;

    // `step` carries a live Step object and is not reference-checked upstream.
    expect(withGraph({ type: "step", step: { id: "x" } })).toBe(false);
    // `tool` executes outside the agent tool-call loop, so command_run's own
    // approval predicate would never fire.
    expect(withGraph({ type: "tool", id: "t", toolId: "command_run" })).toBe(false);
    // `sleepUntil` could park a durable run for hours inside one approval.
    expect(withGraph({ type: "sleepUntil", id: "s", date: "2030-01-01T00:00:00Z" })).toBe(false);
    expect(withGraph({ type: "sleep", id: "s", duration: 600_000 })).toBe(false);
    // A suspendable body inside foreach wedges on the second resume.
    expect(withGraph({ type: "foreach", step: { type: "workflow", id: "w", workflowId: "helper" } })).toBe(false);
    expect(withGraph({ type: "agent", id: "a", agentId: "flux" })).toBe(true);
  });

  test("refuses to run when a delegated agent authored the call", async () => {
    const { invoke } = harness();
    const delegated = new RequestContext();
    delegated.set(DYNAMIC_WORKFLOW_DEPTH_CONTEXT_KEY, 1);

    await expect(invoke(
      { action: "run", description: "d", definition: nestedGraph, input: {}, dryRun: true, timeoutMs: 1_000 },
      delegated,
    )).rejects.toThrow("Nested dynamic_workflow calls are not allowed");
  });

  test("runs an authored graph and leaves its definition archived, not auto-mounting", async () => {
    const { mastra, invoke } = harness();

    const result = await invoke({
      action: "run",
      description: "run the helper",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("success");
    expect(result.output).toEqual({ done: "handled:ship" });
    expect(result.runId).toBeTruthy();

    const store = await (mastra.getStorage() as unknown as {
      getStore(name: string): Promise<{
        list(args?: { status?: string }): Promise<{ definitions: Array<{ id: string; metadata?: Record<string, unknown> }> }>;
      }>;
    }).getStore("workflowDefinitions");
    const active = await store.list({ status: "active" });
    const archived = await store.list({ status: "archived" });

    expect(active.definitions).toHaveLength(0);
    expect(archived.definitions.map(definition => definition.id)).toEqual([result.workflowId]);
    expect(archived.definitions[0]?.metadata?.origin).toBe(DYNAMIC_WORKFLOW_ORIGIN);
    // Registration is released once no run holds it, so Studio's HTTP surface
    // never carries a model-authored graph beyond its in-flight runs.
    const lookup = mastra as unknown as { getWorkflow(id: string): unknown };
    expect(() => lookup.getWorkflow(result.workflowId as string)).toThrow();
  });

  test("clamps author-supplied fan-out concurrency to the host ceiling", async () => {
    const { mastra, invoke } = harness();
    // `createStep(agent)` pins the step input to `{ prompt }` and its default
    // output to `{ text }`, so a fan-out array must carry that element shape.
    const promptSchema = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
    const textSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

    const result = await invoke({
      action: "run",
      description: "fan out",
      dryRun: false,
      timeoutMs: 30_000,
      input: [],
      definition: {
        inputSchema: { type: "array", items: promptSchema },
        outputSchema: { type: "array", items: textSchema },
        graph: [{
          type: "foreach",
          step: { type: "agent", id: "fan", agentId: "flux" },
          opts: { concurrency: 9 },
        }],
      },
    });

    expect(result.status).toBe("success");

    const store = await (mastra.getStorage() as unknown as {
      getStore(name: string): Promise<{ get(id: string): Promise<{ graph: Array<Record<string, unknown>>; inputSchema: Record<string, unknown> } | null> }>;
    }).getStore("workflowDefinitions");
    const stored = await store.get(result.workflowId as string);

    expect((stored?.graph[0] as { opts?: { concurrency?: number } })?.opts?.concurrency).toBe(3);
    // A maxItems ceiling is the only static bound on fan-out width.
    expect(stored?.inputSchema.maxItems).toBe(8);
  });

  test("archives a stray active definition at boot", async () => {
    const { mastra } = harness();
    const store = await (mastra.getStorage() as unknown as {
      getStore(name: string): Promise<{
        upsert(input: Record<string, unknown>): Promise<unknown>;
        list(args?: { status?: string }): Promise<{ definitions: Array<{ id: string }> }>;
      }>;
    }).getStore("workflowDefinitions");
    await store.upsert({
      id: "dyn_0000000000000000",
      inputSchema: objectSchema,
      outputSchema: doneSchema,
      graph: [],
      metadata: { origin: DYNAMIC_WORKFLOW_ORIGIN },
    });

    expect((await store.list({ status: "active" })).definitions).toHaveLength(1);
    await expect(reconcileDynamicWorkflowDefinitions(mastra)).resolves.toBe(1);
    expect((await store.list({ status: "active" })).definitions).toHaveLength(0);
  });
});
