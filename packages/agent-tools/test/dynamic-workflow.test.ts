import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createDynamicWorkflowTool,
  createRunBudgetHooks,
  DYNAMIC_WORKFLOW_DEPTH_CONTEXT_KEY,
  DYNAMIC_WORKFLOW_ORIGIN,
  reconcileDynamicWorkflowDefinitions,
  RUN_CONTAINMENT_POLICY,
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

const largeOutput = createWorkflow({
  id: "large-output",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
}).then(createStep({
  id: "return-large-output",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  execute: async () => ({ value: `head-${"x".repeat(40_000)}-tail` }),
})).commit();

/** Suspends until resumed, so the durable resume path can be exercised end to end. */
const pausing = createWorkflow({
  id: "pausing",
  inputSchema: z.object({ task: z.string() }),
  outputSchema: z.object({ done: z.string() }),
}).then(createStep({
  id: "await-approval",
  inputSchema: z.object({ task: z.string() }),
  outputSchema: z.object({ done: z.string() }),
  resumeSchema: z.object({ approved: z.string() }),
  suspendSchema: z.object({}),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) return await suspend({});
    return { done: `${resumeData.approved}:${inputData.task}` };
  },
})).commit();

/** Preserves agent-entry schema compatibility on both sides of a suspension. */
const pausingAgent = createWorkflow({
  id: "pausing-agent",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ prompt: z.string() }),
}).then(createStep({
  id: "await-agent-approval",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ prompt: z.string() }),
  resumeSchema: z.object({ approved: z.string() }),
  suspendSchema: z.object({}),
  execute: async ({ resumeData, suspend }) => {
    if (!resumeData) return await suspend({});
    return { prompt: resumeData.approved };
  },
})).commit();

/** Streams a chunk through the tool writer so the writer bridge is observable. */
const streaming = createWorkflow({
  id: "streaming",
  inputSchema: z.object({}),
  outputSchema: z.object({ done: z.string() }),
}).then(createStep({
  id: "emit",
  inputSchema: z.object({}),
  outputSchema: z.object({ done: z.string() }),
  execute: async ({ writer }) => {
    await writer?.write({ note: "streamed" });
    return { done: "streamed" };
  },
})).commit();

function harness(toolOptions: { resumable?: boolean } = {}) {
  const flux = new Agent({ id: "flux", name: "flux", instructions: "test", model: "openai/gpt-4o-mini" });
  const mastra = new Mastra({
    agents: { flux },
    workflows: { helper, largeOutput, pausing, streaming },
    storage: new InMemoryStore(),
    logger: false as never,
  });
  const tool = createDynamicWorkflowTool({
    agents: ["flux"],
    nestedWorkflows: ["helper", "large-output", "pausing", "streaming"],
    ...toolOptions,
  });
  const invoke = (
    input: unknown,
    requestContext = new RequestContext(),
    extra: Record<string, unknown> = {},
  ) =>
    (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute(input, { mastra, requestContext, ...extra });
  return { mastra, flux, tool, invoke };
}

const objectSchema = { type: "object", properties: { task: { type: "string" } }, required: ["task"] };
const doneSchema = { type: "object", properties: { done: { type: "string" } }, required: ["done"] };
// `createStep(agent)` pins the step input to `{ prompt }` and its default output
// to `{ text }`, so any fan-out array must carry that element shape.
const promptSchema = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
const textSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

/** Counts real agent dispatches so a ceiling can be proven to bind before one happens. */
function stubAgentStream(agent: Agent): { calls: number; memories: unknown[] } {
  const state: { calls: number; memories: unknown[] } = { calls: 0, memories: [] };
  vi.spyOn(agent, "getModel").mockResolvedValue({ specificationVersion: "v2" } as never);
  vi.spyOn(agent, "stream").mockImplementation((async (...args: unknown[]) => {
    state.calls += 1;
    const options = args[1] as {
      memory?: unknown;
      onFinish?: (result: { text: string }) => void;
    } | undefined;
    state.memories.push(options?.memory);
    const fullStream = (async function* () {
      options?.onFinish?.({ text: "ok" } as never);
    })();
    return { text: Promise.resolve("ok"), fullStream } as never;
  }) as never);
  return state;
}

/** One runtime shared by several tenant-scoped tools, so isolation is observable. */
function scopedHarness() {
  const flux = new Agent({ id: "flux", name: "flux", instructions: "test", model: "openai/gpt-4o-mini" });
  const mastra = new Mastra({
    agents: { flux },
    workflows: { helper, largeOutput, pausing, streaming },
    storage: new InMemoryStore(),
    logger: false as never,
  });
  const toolFor = (scope?: string | (() => string)) => createDynamicWorkflowTool({
    agents: ["flux"],
    nestedWorkflows: ["helper", "large-output", "pausing", "streaming"],
    ...(scope ? { scope: typeof scope === "function" ? scope : () => scope } : {}),
  });
  const invokeWith = (tool: ReturnType<typeof toolFor>, input: unknown) =>
    (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute(input, { mastra, requestContext: new RequestContext() });
  return { mastra, flux, toolFor, invokeWith };
}

const definitionsStoreOf = (mastra: Mastra) => (mastra.getStorage() as unknown as {
  getStore(name: string): Promise<{
    get(id: string): Promise<Record<string, unknown> | null>;
    upsert(input: Record<string, unknown>): Promise<unknown>;
    list(args?: { status?: string }): Promise<{ definitions: Array<{ id: string; metadata?: Record<string, unknown> }> }>;
  }>;
}).getStore("workflowDefinitions");

interface StubRun {
  readonly runId: string;
  readonly snapshot: unknown;
}

/**
 * A runs store that honours `workflowName` the way a real one does, so a test
 * can tell filtering-before-paging apart from paging-then-filtering.
 */
function inspectHarness(runsByWorkflow: Record<string, StubRun[]>) {
  const calls: Array<{ workflowName?: string; perPage?: number }> = [];
  const flat = Object.entries(runsByWorkflow)
    .flatMap(([workflowName, runs]) => runs.map(run => ({ workflowName, ...run })));
  const runsStore = {
    listWorkflowRuns: async (args?: { workflowName?: string; perPage?: number }) => {
      calls.push({ ...args });
      const matching = args?.workflowName
        ? flat.filter(run => run.workflowName === args.workflowName)
        : flat;
      const perPage = typeof args?.perPage === "number" ? args.perPage : matching.length;
      return { runs: matching.slice(0, perPage), total: matching.length };
    },
  };
  const definitionsStore = {
    upsert: async () => undefined,
    get: async () => null,
    list: async () => ({
      definitions: Object.keys(runsByWorkflow)
        .filter(id => id.startsWith("dyn_"))
        .map(id => ({ id, metadata: { origin: DYNAMIC_WORKFLOW_ORIGIN } })),
    }),
  };
  const host = {
    addDynamicWorkflow: async () => undefined,
    getWorkflow: () => { throw new Error("inspect must not execute a graph"); },
    removeWorkflow: () => true,
    getStorage: () => ({
      getStore: async (name: string) => (name === "workflows" ? runsStore : definitionsStore),
    }),
  };
  return { tool: createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] }), host, calls };
}

const fanOutGraph = {
  inputSchema: { type: "array", items: promptSchema },
  outputSchema: { type: "array", items: textSchema },
  graph: [{ type: "foreach", step: { type: "agent", id: "fan", agentId: "flux" } }],
};

const nestedGraph = {
  inputSchema: objectSchema,
  outputSchema: doneSchema,
  graph: [{ type: "workflow", id: "h", workflowId: "helper" }],
};

describe("dynamic_workflow", () => {
  test("advertises one object schema, because providers reject a top-level union", () => {
    const { tool } = harness();
    const advertised = z.toJSONSchema(
      (tool as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input", unrepresentable: "any" },
    ) as Record<string, unknown>;

    // A discriminated union serializes to `oneOf` with no top-level `type`, and
    // OpenAI-compatible function calling rejects the whole request with
    // "schema must be a JSON Schema of 'type: \"object\"'". That fails every
    // request carrying this tool, before the model runs -- so the advertised
    // shape is a contract with the provider, not a style choice.
    expect(advertised.type).toBe("object");
    expect(advertised.oneOf).toBeUndefined();
    expect(advertised.anyOf).toBeUndefined();
    expect(Object.keys(advertised.properties as object)).toEqual(expect.arrayContaining([
      "action", "description", "definition", "input", "workflowId", "runId", "step", "resumeData", "timeoutMs", "dryRun",
    ]));
    // Only the discriminator is universally required; the per-action contract
    // is re-checked at execute time against the strict union.
    expect(advertised.required).toEqual(["action"]);
  });

  test("still enforces the per-action contract the flattened schema cannot express", async () => {
    const { invoke } = harness();

    // `run` without a definition is accepted by the advertised schema and must
    // still be rejected by the union behind it.
    await expect(invoke({ action: "run", description: "no definition" }))
      .rejects.toThrow();
    // `resume` needs both ids.
    await expect(invoke({ action: "resume", description: "d", workflowId: "dyn_0123456789abcdef" }))
      .rejects.toThrow();
  });

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

  test("guides actual runs and resumes to stay backgrounded while read-only actions may run foreground", () => {
    const { tool } = harness();
    const description = (tool as unknown as { description: string }).description;

    expect(description).toContain("run with dryRun:false");
    expect(description).toContain("resume");
    expect(description).toContain("_background.enabled:true");
    expect(description).toContain("Never set _background.enabled:false");
    expect(description).toContain("dryRun and inspect may run in the foreground");
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
    // `tool` executes outside the agent tool-call loop, where its own approval
    // predicate would not protect the containing graph.
    expect(withGraph({ type: "tool", id: "t", toolId: "external_write" })).toBe(false);
    // `sleepUntil` could park a durable run for hours inside one approval.
    expect(withGraph({ type: "sleepUntil", id: "s", date: "2030-01-01T00:00:00Z" })).toBe(false);
    expect(withGraph({ type: "sleep", id: "s", duration: 600_000 })).toBe(false);
    // Stored-workflow loops have no iteration ceiling, so one approval could
    // otherwise authorize an unbounded run.
    expect(withGraph({
      type: "loop",
      step: { type: "agent", id: "a", agentId: "flux" },
      loopType: "dowhile",
      predicate: true,
    })).toBe(false);
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

  test("uses Mastra's validator during dry-run", async () => {
    const { invoke } = harness();
    const result = await invoke({
      action: "run",
      description: "invalid mapping",
      dryRun: true,
      timeoutMs: 1_000,
      input: {},
      definition: {
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        graph: [{ type: "mapping", id: "bad-map", mapConfig: "not valid mapping syntax" }],
      },
    });

    expect(result.status).toBe("invalid");
    expect((result.issues as string[]).join(" ")).toMatch(/map|mapping/i);
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

  test("inspects persisted runs by workflow and run id", async () => {
    const { invoke } = harness();
    const ran = await invoke({
      action: "run",
      description: "inspectable run",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    const inspected = await invoke({
      action: "inspect",
      workflowId: ran.workflowId,
      runId: ran.runId,
    });

    expect(inspected.runs).toEqual([expect.objectContaining({
      workflowId: ran.workflowId,
      runId: ran.runId,
      status: "success",
    })]);
  });

  test("bounds the final workflow output while retaining its beginning and end", async () => {
    const { invoke } = harness();

    const result = await invoke({
      action: "run",
      description: "return a large result",
      definition: {
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { value: { type: "string" } } },
        graph: [{ type: "workflow", id: "large", workflowId: "large-output" }],
      },
      input: {},
      dryRun: false,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("success");
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.output).length).toBeLessThanOrEqual(24_000);
    expect(JSON.stringify(result.output)).toContain("head-");
    expect(JSON.stringify(result.output)).toContain("-tail");
  });

  test("marks step output as truncated when more than 32 entries are omitted", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    const host = {
      addDynamicWorkflow: async () => undefined,
      getStorage: () => ({ getStore: async () => ({ upsert: async () => undefined }) }),
      getWorkflow: () => ({
        createRun: async () => ({
          runId: "many-steps",
          start: async () => ({
            status: "success",
            result: {},
            steps: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
              `step-${index}`,
              { status: "success", output: { value: "x" } },
            ])),
          }),
          cancel: async () => undefined,
        }),
      }),
      removeWorkflow: () => true,
    };
    const result = await (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "many steps",
      definition: {
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        graph: [{ type: "workflow", id: "child", workflowId: "helper" }],
      },
      input: {},
      dryRun: false,
      timeoutMs: 30_000,
    }, { mastra: host, requestContext: new RequestContext() });

    expect(result.status).toBe("success");
    expect(result.steps).toHaveLength(32);
    expect(result.truncated).toBe(true);
  });

  test("rejects resume for a definition outside this tool's current authority", async () => {
    const { mastra, invoke } = harness();
    const store = await (mastra.getStorage() as unknown as {
      getStore(name: string): Promise<{ upsert(input: Record<string, unknown>): Promise<unknown> }>;
    }).getStore("workflowDefinitions");
    await store.upsert({
      id: "dyn_0000000000000000",
      status: "archived",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      graph: [{ type: "agent", id: "outside", agentId: "cortex" }],
      metadata: { origin: "external" },
    });

    const result = await invoke({
      action: "resume",
      description: "resume foreign graph",
      workflowId: "dyn_0000000000000000",
      runId: "run-1",
      resumeData: {},
      timeoutMs: 1_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/authority|origin/i);
  });

  test("removes a live definition when archival fails", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    let removals = 0;
    const host = {
      addDynamicWorkflow: async () => undefined,
      getStorage: () => ({ getStore: async () => ({ upsert: async () => { throw new Error("archive failed"); } }) }),
      getWorkflow: () => { throw new Error("must not execute"); },
      removeWorkflow: () => { removals += 1; return true; },
    };
    const result = await (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "archive failure",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 1_000,
    }, { mastra: host, requestContext: new RequestContext() });

    expect(result.status).toBe("invalid");
    expect(removals).toBe(1);
  });

  test("cancels and returns when a run does not cooperate with its timeout", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    let cancellations = 0;
    const host = {
      addDynamicWorkflow: async () => undefined,
      getStorage: () => ({ getStore: async () => ({ upsert: async () => undefined }) }),
      getWorkflow: () => ({
        createRun: async () => ({
          runId: "stuck-run",
          start: async () => new Promise(() => undefined),
          cancel: async () => { cancellations += 1; },
        }),
      }),
      removeWorkflow: () => true,
    };
    const started = Date.now();
    const result = await (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "timeout",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 1_000,
    }, { mastra: host, requestContext: new RequestContext() });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out/i);
    expect(cancellations).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("keeps a shared registration until concurrent identical runs finish", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    const completions: Array<() => void> = [];
    let additions = 0;
    let removals = 0;
    const host = {
      addDynamicWorkflow: async () => { additions += 1; },
      getStorage: () => ({ getStore: async () => ({ upsert: async () => undefined }) }),
      getWorkflow: () => ({
        createRun: async () => ({
          runId: `run-${completions.length + 1}`,
          start: async () => new Promise(resolve => {
            completions.push(() => resolve({ status: "success", result: {}, steps: {} }));
          }),
          cancel: async () => undefined,
        }),
      }),
      removeWorkflow: () => { removals += 1; return true; },
    };
    const execute = () => (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "concurrent",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    }, { mastra: host, requestContext: new RequestContext() });
    const first = execute();
    const second = execute();
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    completions[0]!();
    await first;
    expect(removals).toBe(0);
    completions[1]!();
    await second;
    expect(additions).toBe(1);
    expect(removals).toBe(1);
  });

  test("shares the parent run budget with an authored canonical agent step", async () => {
    const { flux, invoke } = harness();
    const requestContext = new RequestContext();
    const hooks = createRunBudgetHooks(() => 0);
    await hooks.beforeToolCall?.({
      toolName: "dynamic_workflow",
      input: {},
      context: { requestContext },
    } as never);

    vi.spyOn(flux, "getModel").mockResolvedValue({ specificationVersion: "v2" } as never);
    vi.spyOn(flux, "stream").mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as {
        requestContext?: RequestContext;
        onFinish?: (result: { text: string }) => void;
      } | undefined;
      let failureAt = 0;
      for (let attempt = 1; attempt <= 64; attempt += 1) {
        try {
          await hooks.beforeToolCall?.({
            toolName: `probe-${attempt}`,
            input: {},
            context: { requestContext: options?.requestContext },
          } as never);
        } catch {
          failureAt = attempt;
          break;
        }
      }
      const text = String(failureAt);
      const fullStream = (async function* () {
        options?.onFinish?.({ text } as never);
      })();
      return { text: Promise.resolve(text), fullStream } as never;
    }) as never);

    const result = await invoke({
      action: "run",
      description: "consume the shared budget",
      definition: {
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        graph: [{ type: "agent", id: "budget", agentId: "flux" }],
      },
      input: { prompt: "consume" },
      dryRun: false,
      timeoutMs: 30_000,
    }, requestContext);

    expect(result).toMatchObject({ status: "success", output: { text: "64" } });
  });

  test("runs stored agent entries through the underlying registered durable agent", async () => {
    const flux = new Agent({
      id: "flux",
      name: "flux",
      instructions: "test",
      model: "openai/gpt-4o-mini",
      durable: true,
    });
    const mastra = new Mastra({
      agents: { flux },
      storage: new InMemoryStore(),
      logger: false as never,
    });
    const registered = mastra.getAgent("flux") as unknown as { agent: Agent };
    const stream = stubAgentStream(registered.agent);
    const tool = createDynamicWorkflowTool({ agents: ["flux"] });
    const invoke = (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute.bind(tool);
    const input = {
      action: "run",
      description: "durable agent compatibility",
      definition: {
        inputSchema: promptSchema,
        outputSchema: textSchema,
        graph: [{ type: "agent", id: "durable", agentId: "flux" }],
      },
      input: { prompt: "inspect" },
      dryRun: false,
      timeoutMs: 30_000,
    };
    const result = await invoke(input, { mastra, requestContext: new RequestContext() });
    const repeated = await invoke(input, { mastra, requestContext: new RequestContext() });

    expect(result).toMatchObject({ status: "success", output: { text: "ok" } });
    expect(repeated).toMatchObject({ status: "success", output: { text: "ok" } });
    expect(stream.calls).toBe(2);
    expect(stream.memories).toEqual([
      {
        thread: expect.stringMatching(/^dynamic-workflow:dyn_[0-9a-f]{16}:/),
        resource: expect.stringMatching(/^dynamic-workflow:dyn_[0-9a-f]{16}:/),
      },
      {
        thread: expect.stringMatching(/^dynamic-workflow:dyn_[0-9a-f]{16}:/),
        resource: expect.stringMatching(/^dynamic-workflow:dyn_[0-9a-f]{16}:/),
      },
    ]);
    expect(new Set(stream.memories.map(memory => (memory as { thread: string }).thread)).size).toBe(2);
    expect(new Set(stream.memories.map(memory => (memory as { resource: string }).resource)).size).toBe(2);
  });

  test("keeps same-agent memory isolated across workflow suspension and re-registration", async () => {
    const flux = new Agent({
      id: "flux",
      name: "flux",
      instructions: "test",
      model: "openai/gpt-4o-mini",
      durable: true,
    });
    const mastra = new Mastra({
      agents: { flux },
      workflows: { pausingAgent },
      storage: new InMemoryStore(),
      logger: false as never,
    });
    const registered = mastra.getAgent("flux") as unknown as { agent: Agent };
    const stream = stubAgentStream(registered.agent);
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["pausing-agent"] });
    const invoke = (input: unknown) => (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute(input, { mastra, requestContext: new RequestContext() });
    const definition = {
      inputSchema: promptSchema,
      outputSchema: textSchema,
      graph: [
        { type: "agent", id: "before", agentId: "flux", outputSchema: textSchema },
        { type: "workflow", id: "pause", workflowId: "pausing-agent" },
        { type: "agent", id: "after", agentId: "flux" },
      ],
    };

    const started = await invoke({
      action: "run",
      description: "suspend between two invocations of one agent",
      definition,
      input: { prompt: "before" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    expect(started.status).toBe("suspended");
    const resumed = await invoke({
      action: "resume",
      description: "continue to the second agent invocation",
      workflowId: started.workflowId,
      runId: started.runId,
      resumeData: { approved: "after" },
      timeoutMs: 30_000,
    });

    expect(resumed.status).toBe("success");
    expect(stream.calls).toBe(2);
    expect(new Set(stream.memories.map(memory => (memory as { thread: string }).thread)).size).toBe(2);
    expect(new Set(stream.memories.map(memory => (memory as { resource: string }).resource)).size).toBe(1);
  });

  test("clamps author-supplied fan-out concurrency to the host ceiling", async () => {
    const { mastra, invoke } = harness();

    const result = await invoke({
      action: "run",
      description: "fan out",
      dryRun: false,
      timeoutMs: 30_000,
      input: [],
      definition: {
        ...fanOutGraph,
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
    // The stamped ceiling records the width the definition was admitted under.
    // It does not enforce it — upstream's converter discards `maxItems` — which
    // is why the run-time width check above is the control that binds.
    expect(stored?.inputSchema.maxItems).toBe(8);
  });

  test("refuses a run whose input exceeds the fan-out ceiling before any agent step executes", async () => {
    const { flux, invoke } = harness();
    const stream = stubAgentStream(flux);
    const run = (elements: number) => invoke({
      action: "run",
      description: "fan out",
      dryRun: false,
      timeoutMs: 30_000,
      input: Array.from({ length: elements }, (_, index) => ({ prompt: `p${index}` })),
      definition: fanOutGraph,
    });

    const allowed = await run(8);
    expect(allowed.status).toBe("success");
    expect(stream.calls).toBe(8);

    const refused = await run(9);
    expect(refused.status).toBe("invalid");
    expect((refused.issues as string[]).join(" ")).toContain("8");
    // The ceiling has to bind before dispatch, not by truncating mid-run.
    expect(stream.calls).toBe(8);
  });

  test("rejects a foreach whose declared iteration source exceeds the ceiling", async () => {
    const { invoke } = harness();

    const result = await invoke({
      action: "run",
      description: "wide fan out",
      dryRun: true,
      timeoutMs: 1_000,
      input: [],
      definition: { ...fanOutGraph, inputSchema: { type: "array", items: promptSchema, maxItems: 50 } },
    });

    expect(result.status).toBe("invalid");
    expect((result.issues as string[]).join(" ")).toMatch(/iterat/i);
    expect((result.issues as string[]).join(" ")).toContain("8");
  });

  test("clamps an authored stateSchema and keeps the digest stable across identical submissions", async () => {
    const { mastra, invoke } = harness();
    const definition = {
      ...nestedGraph,
      stateSchema: {
        type: "object",
        properties: { seen: { type: "array", items: { type: "string" }, maxItems: 500 } },
      },
    };

    const first = await invoke({ action: "run", description: "d", definition, input: {}, dryRun: true, timeoutMs: 1_000 });
    const again = await invoke({ action: "run", description: "d", definition, input: {}, dryRun: true, timeoutMs: 1_000 });
    expect(first.graphDigest).toBe(again.graphDigest);
    expect(first.workflowId).toBe(again.workflowId);

    const ran = await invoke({
      action: "run",
      description: "d",
      definition,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    expect(ran.status).toBe("success");

    const store = await (mastra.getStorage() as unknown as {
      getStore(name: string): Promise<{ get(id: string): Promise<{ stateSchema?: Record<string, unknown> } | null> }>;
    }).getStore("workflowDefinitions");
    const stored = await store.get(ran.workflowId as string);
    const seen = (stored?.stateSchema?.properties as { seen?: { maxItems?: number } } | undefined)?.seen;

    expect(seen?.maxItems).toBe(8);
  });

  test("refuses a nested workflow inside a conditional at the schema layer", () => {
    const { tool } = harness();
    const schema = (tool as unknown as {
      inputSchema: { safeParse(value: unknown): { success: boolean } };
    }).inputSchema;
    const withGraph = (entry: unknown) => schema.safeParse({
      action: "run",
      description: "d",
      definition: { ...nestedGraph, graph: [entry] },
    }).success;
    const predicate = { op: "truthy", value: { literal: true } };

    // A nested workflow is a top-level entry only; admitting one here would
    // contradict the graph checker, which has always refused it.
    expect(withGraph({
      type: "conditional",
      steps: [{ type: "workflow", id: "w", workflowId: "helper" }],
      predicates: [predicate],
    })).toBe(false);
    expect(withGraph({
      type: "conditional",
      steps: [{ type: "agent", id: "a", agentId: "flux" }],
      predicates: [predicate],
    })).toBe(true);
  });

  test("keeps a timed-out definition registered until its cancellation settles", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    const order: string[] = [];
    let releaseCancel: (() => void) | undefined;
    const host = {
      addDynamicWorkflow: async () => undefined,
      getStorage: () => ({ getStore: async () => ({ upsert: async () => undefined }) }),
      getWorkflow: () => ({
        createRun: async () => ({
          runId: "stuck-run",
          start: async () => new Promise(() => undefined),
          cancel: async () => {
            order.push("cancel:start");
            await new Promise<void>(resolve => {
              releaseCancel = () => { order.push("cancel:end"); resolve(); };
            });
          },
        }),
      }),
      removeWorkflow: () => { order.push("unregister"); return true; },
    };

    const pending = (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "timeout race",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 1_000,
    }, { mastra: host, requestContext: new RequestContext() });

    await vi.waitFor(() => expect(releaseCancel).toBeTypeOf("function"), { timeout: 5_000 });
    // The live workflow must not leave the registry while it is still running.
    expect(order).toEqual(["cancel:start"]);
    releaseCancel?.();

    const result = await pending;
    expect(result.status).toBe("failed");
    expect(order).toEqual(["cancel:start", "cancel:end", "unregister"]);
  });

  test("inspects a dynamic run that a busier workflow's runs would otherwise displace", async () => {
    const { tool, host, calls } = inspectHarness({
      "dyn_1111111111111111": [{ runId: "wanted", snapshot: { status: "success" } }],
      noise: Array.from({ length: 20 }, (_, index) => ({ runId: `n${index}`, snapshot: { status: "success" } })),
    });

    const result = await (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({ action: "inspect" }, { mastra: host, requestContext: new RequestContext() });

    expect(result.runs).toEqual([
      expect.objectContaining({ workflowId: "dyn_1111111111111111", runId: "wanted", status: "success" }),
    ]);
    // Paging the whole runs table and filtering afterwards drops dynamic runs
    // behind any busier workflow, so the filter has to reach the store.
    expect(calls.every(call => call.workflowName !== undefined)).toBe(true);
  });

  test("reports inspect truncation honestly and surfaces suspended step paths", async () => {
    const { tool, host } = inspectHarness({
      "dyn_1111111111111111": Array.from({ length: 21 }, (_, index) => ({
        runId: `r${index}`,
        snapshot: {
          status: "suspended",
          suspendedPaths: { paused: [0] },
          context: { paused: { status: "suspended" } },
        },
      })),
    });

    const result = await (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({ action: "inspect" }, { mastra: host, requestContext: new RequestContext() });

    expect(result.truncated).toBe(true);
    expect(result.resumable).toBe(true);
    expect((result.runs as Array<{ suspended?: string[][] }>)[0]?.suspended).toEqual([["paused"]]);
  });

  test("suspends a durable run and resumes it to completion", async () => {
    const { invoke } = harness();
    const definition = {
      inputSchema: objectSchema,
      outputSchema: doneSchema,
      graph: [{ type: "workflow", id: "p", workflowId: "pausing" }],
    };

    const started = await invoke({
      action: "run",
      description: "await approval",
      definition,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });

    expect(started.status).toBe("suspended");
    expect(started.resumable).toBe(true);
    const suspended = started.suspended as Array<{ path: string[] }>;
    expect(suspended.length).toBeGreaterThan(0);

    const resumed = await invoke({
      action: "resume",
      description: "approve",
      workflowId: started.workflowId,
      runId: started.runId,
      step: suspended[0]?.path,
      resumeData: { approved: "yes" },
      timeoutMs: 30_000,
    });

    expect(resumed.status).toBe("success");
    expect(resumed.output).toEqual({ done: "yes:ship" });
  });

  test("refuses to resume a run id that does not belong to the workflow", async () => {
    const { invoke } = harness();
    const started = await invoke({
      action: "run",
      description: "await approval",
      definition: {
        inputSchema: objectSchema,
        outputSchema: doneSchema,
        graph: [{ type: "workflow", id: "p", workflowId: "pausing" }],
      },
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    expect(started.status).toBe("suspended");

    const result = await invoke({
      action: "resume",
      description: "resume a stranger",
      workflowId: started.workflowId,
      runId: "never-existed",
      resumeData: { approved: "yes" },
      timeoutMs: 1_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/does not exist/i);
  });

  test("names the ceiling policy when a suspended run outlives it", async () => {
    const { mastra, invoke } = harness();
    const started = await invoke({
      action: "run",
      description: "await approval",
      definition: {
        inputSchema: objectSchema,
        outputSchema: doneSchema,
        graph: [{ type: "workflow", id: "p", workflowId: "pausing" }],
      },
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    expect(started.status).toBe("suspended");

    const store = await (mastra.getStorage() as unknown as {
      getStore(name: string): Promise<{
        get(id: string): Promise<Record<string, unknown> | null>;
        upsert(input: Record<string, unknown>): Promise<unknown>;
      }>;
    }).getStore("workflowDefinitions");
    const stored = await store.get(started.workflowId as string);
    const metadata = stored?.metadata as { ceilingPolicy?: Record<string, unknown> };
    // The definition records the ceilings it was admitted under.
    expect(metadata.ceilingPolicy).toMatchObject({ version: 1, maxFanOut: 8 });
    // Stands in for a runtime that lowered a ceiling while the run was
    // suspended, and did so without remembering to bump the policy version.
    await store.upsert({
      ...stored,
      status: "archived",
      metadata: { ...metadata, ceilingPolicy: { ...metadata.ceilingPolicy, maxFanOut: 64 } },
    });

    const result = await invoke({
      action: "resume",
      description: "approve",
      workflowId: started.workflowId,
      runId: started.runId,
      resumeData: { approved: "yes" },
      timeoutMs: 1_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("ceiling_policy_mismatch");
    expect(result.error).toContain("maxFanOut");
    // The opaque content mismatch was what orphaned suspended runs before.
    expect(result.error).not.toMatch(/digest does not match/i);
  });

  test("runs a conditional branch and a parallel fan-out over authored agents", async () => {
    const { flux, invoke } = harness();
    const stream = stubAgentStream(flux);
    const predicate = { op: "truthy", value: { literal: true } };

    const conditional = await invoke({
      action: "run",
      description: "conditional",
      dryRun: false,
      timeoutMs: 30_000,
      input: { prompt: "go" },
      definition: {
        inputSchema: promptSchema,
        outputSchema: { type: "object" },
        graph: [{
          type: "conditional",
          steps: [{ type: "agent", id: "branch", agentId: "flux" }],
          predicates: [predicate],
        }],
      },
    });

    expect(conditional.status).toBe("success");
    expect(stream.calls).toBe(1);

    const parallel = await invoke({
      action: "run",
      description: "parallel",
      dryRun: false,
      timeoutMs: 30_000,
      input: { prompt: "go" },
      definition: {
        inputSchema: promptSchema,
        outputSchema: { type: "object" },
        graph: [{
          type: "parallel",
          steps: [
            { type: "agent", id: "left", agentId: "flux" },
            { type: "agent", id: "right", agentId: "flux" },
          ],
        }],
      },
    });

    expect(parallel.status).toBe("success");
    expect(stream.calls).toBe(3);
  });

  test("bridges workflow chunks to the caller's writer", async () => {
    const { invoke } = harness();
    const chunks: unknown[] = [];

    const result = await invoke({
      action: "run",
      description: "stream",
      dryRun: false,
      timeoutMs: 30_000,
      input: {},
      definition: {
        inputSchema: { type: "object" },
        outputSchema: doneSchema,
        graph: [{ type: "workflow", id: "s", workflowId: "streaming" }],
      },
    }, new RequestContext(), {
      writer: { write: async (chunk: unknown) => { chunks.push(chunk); } },
    });

    expect(result.status).toBe("success");
    // Chunks arrive in the workflow's own step-output envelope, not raw.
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "workflow-step-output",
      payload: expect.objectContaining({ stepName: "emit", output: { note: "streamed" } }),
    }));
    // Raw observer/workflow telemetry belongs to the human stream, not the
    // bounded result that is injected into the parent agent's continuation.
    expect(result).not.toHaveProperty("note");
    expect(JSON.stringify(result)).not.toContain("workflow-step-output");
  });

  test("cancels when the caller aborts rather than when the timeout expires", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    let cancellations = 0;
    const host = {
      addDynamicWorkflow: async () => undefined,
      getStorage: () => ({ getStore: async () => ({ upsert: async () => undefined }) }),
      getWorkflow: () => ({
        createRun: async () => ({
          runId: "aborted-run",
          start: async () => new Promise(() => undefined),
          cancel: async () => { cancellations += 1; },
        }),
      }),
      removeWorkflow: () => true,
    };
    const controller = new AbortController();
    const pending = (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "caller abort",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      // Far beyond the abort, so a timeout cannot be mistaken for the cause.
      timeoutMs: 300_000,
    }, { mastra: host, requestContext: new RequestContext(), abortSignal: controller.signal });

    controller.abort();
    const result = await pending;

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/cancelled/i);
    expect(cancellations).toBe(1);
  });

  test("refuses a graph with more entries than the ceiling allows", () => {
    const { tool } = harness();
    const schema = (tool as unknown as {
      inputSchema: { safeParse(value: unknown): { success: boolean } };
    }).inputSchema;
    const graphOf = (entries: number) => Array.from({ length: entries }, (_, index) => ({
      type: "agent",
      id: `a${index}`,
      agentId: "flux",
    }));
    const parse = (entries: number) => schema.safeParse({
      action: "run",
      description: "d",
      definition: { ...nestedGraph, graph: graphOf(entries) },
    }).success;

    expect(parse(16)).toBe(true);
    expect(parse(17)).toBe(false);
  });

  test("truncates a single oversized step row and still reports later rows", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    const host = {
      addDynamicWorkflow: async () => undefined,
      getStorage: () => ({ getStore: async () => ({ upsert: async () => undefined }) }),
      getWorkflow: () => ({
        createRun: async () => ({
          runId: "wide-rows",
          start: async () => ({
            status: "success",
            result: {},
            steps: {
              wide: { status: "success", output: { value: "w".repeat(5_000) } },
              narrow: { status: "success", output: { value: "n" } },
            },
          }),
          cancel: async () => undefined,
        }),
      }),
      removeWorkflow: () => true,
    };

    const result = await (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "wide rows",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    }, { mastra: host, requestContext: new RequestContext() });

    const steps = result.steps as Array<{ id: string; output?: string }>;
    const wide = steps.find(step => step.id === "wide");
    const narrow = steps.find(step => step.id === "narrow");

    expect(result.truncated).toBe(true);
    expect(wide?.output?.length).toBeLessThanOrEqual(2_000);
    expect(wide?.output).toContain("output truncated");
    // The per-row cap must not consume the aggregate budget of later rows.
    expect(narrow?.output).toBe(JSON.stringify({ value: "n" }));
  });

  test("stops spending step-row output once the aggregate budget is exhausted", async () => {
    const tool = createDynamicWorkflowTool({ agents: ["flux"], nestedWorkflows: ["helper"] });
    const host = {
      addDynamicWorkflow: async () => undefined,
      getStorage: () => ({ getStore: async () => ({ upsert: async () => undefined }) }),
      getWorkflow: () => ({
        createRun: async () => ({
          runId: "budget",
          start: async () => ({
            status: "success",
            result: {},
            steps: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
              `step-${index}`,
              { status: "success", output: { value: "x".repeat(3_000) } },
            ])),
          }),
          cancel: async () => undefined,
        }),
      }),
      removeWorkflow: () => true,
    };

    const result = await (tool as unknown as {
      execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
    }).execute({
      action: "run",
      description: "aggregate budget",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    }, { mastra: host, requestContext: new RequestContext() });

    const steps = result.steps as Array<{ id: string; output?: string }>;
    const spent = steps.reduce((total, step) => total + (step.output?.length ?? 0), 0);

    expect(result.truncated).toBe(true);
    expect(steps).toHaveLength(20);
    expect(spent).toBeLessThanOrEqual(24_000);
    // Every row is still reported by id and status once the budget runs out.
    expect(steps.at(-1)?.output ?? "").toBe("");
  });

  test("pins the authored timeout inside the harness deadline and the run budget", () => {
    const { tool } = harness();
    const { inputSchema, background } = tool as unknown as {
      inputSchema: { safeParse(value: unknown): { success: boolean } };
      background: { timeoutMs: number };
    };
    const accepts = (timeoutMs: number) => inputSchema.safeParse({
      action: "run",
      description: "d",
      definition: nestedGraph,
      timeoutMs,
    }).success;

    // The largest timeout a caller can author.
    expect(accepts(600_000)).toBe(true);
    expect(accepts(600_001)).toBe(false);
    // It must expire before the harness reclaims the call, or cancellation
    // never runs and the workflow is never contained.
    expect(background.timeoutMs).toBeGreaterThan(600_000);
    // And the harness bound must fit inside the aggregate run budget, or one
    // dynamic workflow can outlive the wall clock containing the whole run.
    expect(background.timeoutMs).toBeLessThanOrEqual(RUN_CONTAINMENT_POLICY.maxWallClockMs);
  });

  test("leaves an active definition this tool did not author alone", async () => {
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
      metadata: { origin: "external" },
    });

    await expect(reconcileDynamicWorkflowDefinitions(mastra)).resolves.toBe(0);
    expect((await store.list({ status: "active" })).definitions.map(row => row.id))
      .toEqual(["dyn_0000000000000000"]);
  });

  test("charges a dynamic workflow's agent fan-out against the delegation ceiling", async () => {
    const { flux, invoke } = harness();
    stubAgentStream(flux);
    const hooks = createRunBudgetHooks(() => 0);
    const requestContext = new RequestContext();
    const enter = (toolName: string, input: unknown) =>
      hooks.beforeToolCall?.({ toolName, input, context: { requestContext } } as never);

    enter("dynamic_workflow", { action: "run" });
    const result = await invoke({
      action: "run",
      description: "fan out",
      dryRun: false,
      timeoutMs: 30_000,
      input: Array.from({ length: 8 }, (_, index) => ({ prompt: `p${index}` })),
      definition: fanOutGraph,
    }, requestContext);

    expect(result.status).toBe("success");
    // Eight agents ran under one approval. The aggregate ceiling is eight, so
    // the run has spent it and no further delegation may follow.
    expect(() => enter("subagent", { task: "one more" })).toThrow(/delegation limit/);
  });

  test("charges each dispatching graph position, not one per tool call", async () => {
    const { flux, invoke } = harness();
    stubAgentStream(flux);
    const hooks = createRunBudgetHooks(() => 0);
    const requestContext = new RequestContext();
    const enter = (toolName: string, input: unknown) =>
      hooks.beforeToolCall?.({ toolName, input, context: { requestContext } } as never);

    enter("dynamic_workflow", { action: "run" });
    const result = await invoke({
      action: "run",
      description: "parallel fan-out",
      dryRun: false,
      timeoutMs: 30_000,
      input: { prompt: "go" },
      definition: {
        inputSchema: promptSchema,
        outputSchema: { type: "object" },
        graph: [{
          type: "parallel",
          steps: [
            { type: "agent", id: "a", agentId: "flux" },
            { type: "agent", id: "b", agentId: "flux" },
            { type: "agent", id: "c", agentId: "flux" },
          ],
        }],
      },
    }, requestContext);

    expect(result.status).toBe("success");
    // Three agents ran, so five of the eight delegations remain.
    for (let index = 0; index < 5; index += 1) {
      expect(() => enter("subagent", { task: `scope-${index}` })).not.toThrow();
    }
    expect(() => enter("subagent", { task: "over" })).toThrow(/delegation limit/);
  });

  test("charges a resume, which re-enters the graph under the same approval", async () => {
    const { invoke } = harness();
    const hooks = createRunBudgetHooks(() => 0);
    const requestContext = new RequestContext();
    const enter = (toolName: string, input: unknown) =>
      hooks.beforeToolCall?.({ toolName, input, context: { requestContext } } as never);
    const definition = {
      inputSchema: objectSchema,
      outputSchema: doneSchema,
      graph: [{ type: "workflow", id: "p", workflowId: "pausing" }],
    };

    enter("dynamic_workflow", { action: "run" });
    const started = await invoke({
      action: "run",
      description: "await approval",
      definition,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    }, requestContext);
    expect(started.status).toBe("suspended");

    for (let index = 0; index < 7; index += 1) {
      enter("subagent", { task: `scope-${index}` });
    }

    enter("dynamic_workflow", { action: "resume" });
    await expect(invoke({
      action: "resume",
      description: "approve",
      workflowId: started.workflowId,
      runId: started.runId,
      resumeData: { approved: "yes" },
      timeoutMs: 1_000,
    }, requestContext)).rejects.toThrow(/delegation limit/);
  });

  test("charges nothing for actions that dispatch no agent", async () => {
    const { invoke } = harness();
    const hooks = createRunBudgetHooks(() => 0);
    const requestContext = new RequestContext();
    const enter = (toolName: string, input: unknown) =>
      hooks.beforeToolCall?.({ toolName, input, context: { requestContext } } as never);

    for (let index = 0; index < 8; index += 1) {
      enter("subagent", { task: `scope-${index}` });
    }

    // Validation and inspection run no agent, so neither may spend the last
    // of an already-exhausted delegation budget.
    enter("dynamic_workflow", { action: "run" });
    const validated = await invoke({
      action: "run",
      description: "validate only",
      definition: nestedGraph,
      input: {},
      dryRun: true,
      timeoutMs: 1_000,
    }, requestContext);
    expect(validated.status).toBe("validated");

    enter("dynamic_workflow", { action: "inspect" });
    const inspected = await invoke({ action: "inspect" }, requestContext);
    expect(inspected.runs).toEqual([]);
  });

  test("derives a different id for the same graph under a different scope", async () => {
    const { toolFor, invokeWith } = scopedHarness();
    const validate = (tool: ReturnType<typeof toolFor>) => invokeWith(tool, {
      action: "run",
      description: "d",
      definition: nestedGraph,
      input: {},
      dryRun: true,
      timeoutMs: 1_000,
    });

    const a = await validate(toolFor("project-a"));
    const b = await validate(toolFor("project-b"));
    const againA = await validate(toolFor("project-a"));

    expect(a.workflowId).toMatch(/^dyn_[0-9a-f]{16}$/);
    // Two tenants authoring the same graph must not collapse onto one id.
    expect(b.workflowId).not.toBe(a.workflowId);
    expect(b.graphDigest).not.toBe(a.graphDigest);
    // Still content-addressed within a scope.
    expect(againA.workflowId).toBe(a.workflowId);
  });

  test("keeps an unscoped host byte-identical to its pre-scope behaviour", async () => {
    const { mastra, invoke } = harness();

    const validated = await invoke({
      action: "run",
      description: "d",
      definition: nestedGraph,
      input: {},
      dryRun: true,
      timeoutMs: 1_000,
    });
    // Pinned literal: a host that supplies no scope must derive exactly the id
    // it derived before scoping existed, or every MCode and Studio run in
    // flight is orphaned by this change.
    expect(validated.workflowId).toBe("dyn_7a37e1229cc6d39f");

    const ran = await invoke({
      action: "run",
      description: "d",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    const store = await definitionsStoreOf(mastra);
    const stored = await store.get(ran.workflowId as string);

    expect(ran.workflowId).toBe("dyn_7a37e1229cc6d39f");
    expect(stored?.metadata).not.toHaveProperty("scopeDigest");
  });

  test("never lists another scope's runs from inspect", async () => {
    const { toolFor, invokeWith } = scopedHarness();
    const toolA = toolFor("project-a");
    const toolB = toolFor("project-b");
    const run = (tool: ReturnType<typeof toolFor>) => invokeWith(tool, {
      action: "run",
      description: "shared graph",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });

    const ranA = await run(toolA);
    const ranB = await run(toolB);
    expect(ranA.status).toBe("success");
    expect(ranB.status).toBe("success");

    const seenByA = await invokeWith(toolA, { action: "inspect" });
    const seenByB = await invokeWith(toolB, { action: "inspect" });

    expect((seenByA.runs as Array<{ workflowId: string }>).map(run => run.workflowId))
      .toEqual([ranA.workflowId]);
    expect((seenByB.runs as Array<{ workflowId: string }>).map(run => run.workflowId))
      .toEqual([ranB.workflowId]);
  });

  test("rejects a resume whose caller scope differs from the stored one", async () => {
    const { toolFor, invokeWith } = scopedHarness();
    const toolA = toolFor("project-a");
    const toolB = toolFor("project-b");

    const started = await invokeWith(toolA, {
      action: "run",
      description: "await approval",
      definition: {
        inputSchema: objectSchema,
        outputSchema: doneSchema,
        graph: [{ type: "workflow", id: "p", workflowId: "pausing" }],
      },
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    expect(started.status).toBe("suspended");

    const stolen = await invokeWith(toolB, {
      action: "resume",
      description: "resume another tenant's run",
      workflowId: started.workflowId,
      runId: started.runId,
      resumeData: { approved: "yes" },
      timeoutMs: 1_000,
    });

    expect(stolen.status).toBe("failed");
    expect(stolen.error).toContain("scope_mismatch");
    // A cross-tenant attempt is not a ceiling change and not corruption.
    expect(stolen.error).not.toContain("ceiling_policy_mismatch");
    expect(stolen.error).not.toMatch(/digest does not match/i);
    // The owning scope's key must not leak to the caller that guessed the id.
    expect(stolen.error).not.toContain("project-a");

    // The rightful owner is unaffected.
    const resumed = await invokeWith(toolA, {
      action: "resume",
      description: "approve",
      workflowId: started.workflowId,
      runId: started.runId,
      resumeData: { approved: "yes" },
      timeoutMs: 30_000,
    });
    expect(resumed.status).toBe("success");
  });

  test("hides a legacy unscoped definition from every scoped caller", async () => {
    const { mastra, toolFor, invokeWith } = scopedHarness();
    const unscoped = await invokeWith(toolFor(), {
      action: "run",
      description: "legacy row",
      definition: nestedGraph,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });
    expect(unscoped.status).toBe("success");

    const scoped = toolFor("project-a");
    const seen = await invokeWith(scoped, { action: "inspect" });
    // A row written before scoping existed carries no scopeDigest, and must
    // not become readable from every scope by default.
    expect(seen.runs).toEqual([]);

    const resumed = await invokeWith(scoped, {
      action: "resume",
      description: "resume a legacy row",
      workflowId: unscoped.workflowId,
      runId: unscoped.runId,
      resumeData: {},
      timeoutMs: 1_000,
    });
    expect(resumed.status).toBe("failed");
    expect(resumed.error).toContain("scope_mismatch");
  });

  test("fails closed when the host cannot derive a scope", async () => {
    const { toolFor, invokeWith } = scopedHarness();
    const unbound = toolFor(() => { throw new Error("no project session bound"); });

    await expect(invokeWith(unbound, {
      action: "run",
      description: "unbound",
      definition: nestedGraph,
      input: {},
      dryRun: true,
      timeoutMs: 1_000,
    })).rejects.toThrow("no project session bound");

    const empty = toolFor(() => "");
    await expect(invokeWith(empty, { action: "inspect" })).rejects.toThrow(/scope/i);
  });

  test("archives every scope's stray definitions at boot", async () => {
    const { mastra, toolFor, invokeWith } = scopedHarness();
    const store = await definitionsStoreOf(mastra);
    const validated = await Promise.all(["project-a", "project-b"].map(scope =>
      invokeWith(toolFor(scope), {
        action: "run",
        description: "d",
        definition: nestedGraph,
        input: {},
        dryRun: true,
        timeoutMs: 1_000,
      })));
    // Stand in for definitions left active by a crash between write and archive.
    for (const row of validated) {
      await store.upsert({
        id: row.workflowId,
        inputSchema: objectSchema,
        outputSchema: doneSchema,
        graph: [],
        metadata: { origin: DYNAMIC_WORKFLOW_ORIGIN },
      });
    }
    expect((await store.list({ status: "active" })).definitions).toHaveLength(2);

    // Boot recovery is host-wide. Scoping it would strand one tenant's
    // crashed definition auto-mounting at startWorkers().
    await expect(reconcileDynamicWorkflowDefinitions(mastra)).resolves.toBe(2);
    expect((await store.list({ status: "active" })).definitions).toHaveLength(0);
  });

  test("reports a suspended run as resumable only when the host permits resume", async () => {
    const suspending = {
      inputSchema: objectSchema,
      outputSchema: doneSchema,
      graph: [{ type: "workflow", id: "p", workflowId: "pausing" }],
    };
    const start = (invoke: ReturnType<typeof harness>["invoke"]) => invoke({
      action: "run",
      description: "await approval",
      definition: suspending,
      input: { task: "ship" },
      dryRun: false,
      timeoutMs: 30_000,
    });

    const permitted = await start(harness().invoke);
    expect(permitted.status).toBe("suspended");
    expect(permitted.resumable).toBe(true);
    expect(permitted.error).toBeUndefined();

    const restricted = harness({ resumable: false });
    const refused = await start(restricted.invoke);

    expect(refused.status).toBe("suspended");
    // The host has resume disabled, so this runId can never be used. Saying
    // otherwise makes the model hold state for a recovery it cannot perform.
    expect(refused.resumable).toBe(false);
    expect(refused.error).toMatch(/cannot be continued/i);
    // Step paths still explain where the graph stopped, which is what a
    // re-author needs even though recovery is impossible.
    expect(refused.suspended).toBeTruthy();

    const attempted = await restricted.invoke({
      action: "resume",
      description: "approve",
      workflowId: refused.workflowId,
      runId: refused.runId,
      resumeData: { approved: "yes" },
      timeoutMs: 1_000,
    });
    expect(attempted.status).toBe("failed");
    expect(attempted.error).toMatch(/does not support resuming/i);
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
