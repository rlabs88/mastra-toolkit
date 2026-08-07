import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { Workspace } from "@mastra/core/workspace";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateStoredWorkflow } from "@mastra/core/workflows";
import { RUN_BUDGET_CONTEXT_KEY } from "./capabilities.js";

/**
 * Marks a dispatched run so a delegated agent cannot author another graph.
 * The check lives inside `execute`, where it also covers agents invoked by a
 * workflow rather than relying on a particular host's tool resolver.
 */
export const DYNAMIC_WORKFLOW_DEPTH_CONTEXT_KEY = "dynamicWorkflowDepth";

/** Stamped on every definition this tool persists so boot reconciliation can find them. */
export const DYNAMIC_WORKFLOW_ORIGIN = "dynamic_workflow";

const DYNAMIC_WORKFLOW_ID_PATTERN = /^dyn_[0-9a-f]{16}$/;

const MAX_GRAPH_ENTRIES = 16;
const MAX_FAN_OUT = 8;
const MAX_CONCURRENCY = 3;
const MAX_NESTING_DEPTH = 2;
const MAX_SLEEP_MS = 60_000;
const MAX_ROW_CHARS = 2_000;
const MAX_RETAINED_CHARS = 24_000;

const identifier = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const jsonSchemaObject = z.record(z.string(), z.unknown());

const stepOptionsSchema = z.object({
  retries: z.number().int().min(0).max(3).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const agentEntrySchema = z.object({
  type: z.literal("agent"),
  id: identifier,
  agentId: z.string().min(1).max(64),
  description: z.string().max(400).optional(),
  outputSchema: jsonSchemaObject.optional(),
  options: stepOptionsSchema.optional(),
}).strict();

const mappingEntrySchema = z.object({
  type: z.literal("mapping"),
  id: identifier,
  mapConfig: z.string().min(1).max(8_000),
}).strict();

const workflowEntrySchema = z.object({
  type: z.literal("workflow"),
  id: identifier,
  workflowId: z.string().min(1).max(128),
  description: z.string().max(400).optional(),
}).strict();

const sleepEntrySchema = z.object({
  type: z.literal("sleep"),
  id: identifier,
  duration: z.number().int().min(1).max(MAX_SLEEP_MS),
}).strict();

/** Suspension inside `foreach` wedges on the second resume, so fan-out bodies are agents only. */
const foreachEntrySchema = z.object({
  type: z.literal("foreach"),
  step: agentEntrySchema,
  opts: z.object({ concurrency: z.number().int().min(1) }).strict().optional(),
}).strict();

/** `.parallel` is an unbounded `Promise.all`, so width is the only available cap. */
const parallelEntrySchema = z.object({
  type: z.literal("parallel"),
  steps: z.array(agentEntrySchema).min(1).max(MAX_CONCURRENCY),
}).strict();

const suspendableInnerSchema = z.discriminatedUnion("type", [agentEntrySchema, workflowEntrySchema]);

const conditionalEntrySchema = z.object({
  type: z.literal("conditional"),
  steps: z.array(suspendableInnerSchema).min(1).max(MAX_CONCURRENCY),
  // Predicates are upstream's declarative language; `validateStoredWorkflow` is their authority.
  predicates: z.array(z.unknown()).min(1),
}).strict();

const graphEntrySchema = z.discriminatedUnion("type", [
  agentEntrySchema,
  mappingEntrySchema,
  workflowEntrySchema,
  sleepEntrySchema,
  foreachEntrySchema,
  parallelEntrySchema,
  conditionalEntrySchema,
]);

export type DynamicWorkflowGraphEntry = z.infer<typeof graphEntrySchema>;

const definitionSchema = z.object({
  description: z.string().min(1).max(2_000).optional(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  stateSchema: jsonSchemaObject.optional(),
  graph: z.array(graphEntrySchema).min(1).max(MAX_GRAPH_ENTRIES),
}).strict();

export type DynamicWorkflowDefinition = z.infer<typeof definitionSchema>;

const singleLine = z.string().min(1).max(400).regex(/^[^\r\n]+$/);

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("run"),
    description: singleLine.describe("Single-line label shown in the approval prompt and the audit trace."),
    definition: definitionSchema.describe(
      "A Mastra workflow graph as data. Agents and nested workflows are referenced by id and resolved against this runtime.",
    ),
    input: z.unknown().default({}).describe("Validated at run time against the definition's own inputSchema."),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
    dryRun: z.boolean().default(false).describe("Validate and content-address only. No approval, no execution, no persistence."),
  }).strict(),
  z.object({
    action: z.literal("resume"),
    description: singleLine,
    workflowId: z.string().regex(DYNAMIC_WORKFLOW_ID_PATTERN),
    runId: z.string().min(1).max(200),
    step: z.array(z.string().min(1)).min(1).max(8).optional(),
    resumeData: z.unknown().default({}),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
  }).strict(),
  z.object({
    action: z.literal("inspect"),
    workflowId: z.string().regex(DYNAMIC_WORKFLOW_ID_PATTERN).optional(),
    runId: z.string().min(1).max(200).optional(),
  }).strict(),
]);

const outputSchema = z.object({
  version: z.literal(1),
  action: z.enum(["run", "resume", "inspect"]),
  workflowId: z.string().optional(),
  graphDigest: z.string().optional(),
  runId: z.string().optional(),
  status: z.enum([
    "validated", "pending", "running", "success", "failed",
    "suspended", "waiting", "canceled", "invalid",
  ]).optional(),
  output: z.unknown().optional(),
  error: z.string().max(2_000).optional(),
  issues: z.array(z.string().max(600)).max(24).optional(),
  suspended: z.array(z.object({ path: z.array(z.string()) }).passthrough()).max(8).optional(),
  steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()).max(32).optional(),
  runs: z.array(z.object({
    workflowId: z.string(),
    runId: z.string(),
    status: z.string(),
  }).passthrough()).max(20).optional(),
  resumable: z.boolean(),
  truncated: z.boolean(),
}).strict();

export interface DynamicWorkflowAuthorizationContext {
  readonly requestContext: RequestContext;
  readonly workspace?: Workspace;
}

export interface DynamicWorkflowToolOptions {
  /** Agent ids a graph may dispatch. Injected so this package stays role-neutral. */
  readonly agents: readonly string[];
  /** Registered workflow ids a graph may nest; all other workflow references fail closed. */
  readonly nestedWorkflows?: readonly string[];
  readonly authorize?: (context: DynamicWorkflowAuthorizationContext) => Promise<void> | void;
  /** Hosts without durable request-context reconstruction may disable resume. */
  readonly resumable?: boolean;
}

/** Structural view of the host runtime, so this package depends on no host type. */
interface DynamicWorkflowHost {
  addStoredWorkflow(definition: unknown): Promise<void>;
  getWorkflow(id: string): unknown;
  removeWorkflow?(id: string): boolean;
  getStorage?(): unknown;
}

interface WorkflowDefinitionRow {
  readonly id: string;
  readonly metadata?: Record<string, unknown>;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly stateSchema?: unknown;
  readonly graph: unknown;
  readonly description?: string;
}

interface WorkflowDefinitionsStore {
  upsert(input: Record<string, unknown>): Promise<unknown>;
  get(id: string): Promise<WorkflowDefinitionRow | null>;
  list(args?: { status?: "active" | "archived" }): Promise<{ definitions: WorkflowDefinitionRow[] }>;
}

interface WorkflowRunsStore {
  listWorkflowRuns(args?: { workflowName?: string; perPage?: number }): Promise<{
    runs: Array<{ workflowName: string; runId: string; snapshot: unknown }>;
  }>;
}

/**
 * Registration is refcounted because the id is content-addressed: two turns
 * submitting the same graph share one id, so unregistering in a `finally`
 * would tear down a registration another in-flight run still depends on.
 */
interface RegistrationState {
  references: number;
  readonly ready: Promise<void>;
}

const registrations = new WeakMap<object, Map<string, RegistrationState>>();

export function createDynamicWorkflowTool(options: DynamicWorkflowToolOptions) {
  const allowedAgents = new Set(options.agents);
  const allowedWorkflows = new Set(options.nestedWorkflows ?? []);
  const resumable = options.resumable ?? true;

  return createTool({
    id: "dynamic_workflow",
    description:
      "Author a Mastra workflow as a declarative graph and run it durably to orchestrate other agents. "
      + "Agents and nested workflows are referenced by id. Use dryRun to validate a graph for free before "
      + "spending an approval; validation issues come back precise enough to repair. Runs are durable: keep "
      + "workflowId and runId to resume a suspended run.",
    inputSchema,
    outputSchema,
    requireApproval: input =>
      input.action === "run" ? !input.dryRun : input.action === "resume",
    background: { enabled: true, timeoutMs: 600_000 },
    mcp: {
      annotations: {
        title: "Dynamic Workflow",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    execute: async (input, context) => {
      if (context.requestContext.get(DYNAMIC_WORKFLOW_DEPTH_CONTEXT_KEY) === 1) {
        throw new Error("Nested dynamic_workflow calls are not allowed");
      }
      await options.authorize?.({
        requestContext: context.requestContext,
        ...(context.workspace ? { workspace: context.workspace } : {}),
      });
      const host = context.mastra as unknown as DynamicWorkflowHost | undefined;
      if (!host?.addStoredWorkflow) throw new Error("dynamic_workflow requires an active Mastra runtime");
      const childRequestContext = dispatchContext(
        context.requestContext,
      );

      if (input.action === "inspect") return inspect(host, input);
      if (input.action === "resume") {
        if (!resumable) {
          return fail("resume", "This host does not support resuming a dynamic workflow run");
        }
        return resume(host, input, context, childRequestContext, allowedAgents, allowedWorkflows);
      }

      const prepared = prepare(input.definition, allowedAgents, allowedWorkflows);
      if (!prepared.ok) {
        return {
          version: 1 as const,
          action: "run" as const,
          status: "invalid" as const,
          issues: prepared.issues.slice(0, 24),
          resumable: false,
          truncated: false,
        };
      }
      if (input.dryRun) {
        return {
          version: 1 as const,
          action: "run" as const,
          workflowId: prepared.workflowId,
          graphDigest: prepared.digest,
          status: "validated" as const,
          resumable: false,
          truncated: false,
        };
      }
      return run(host, prepared, input, context, childRequestContext);
    },
  });
}

/**
 * Archives every definition this tool left active, so a crash between the
 * create and archive writes cannot leave a model-authored graph auto-mounting
 * at `startWorkers()`. Idempotent; a no-op on the happy path.
 */
export async function reconcileDynamicWorkflowDefinitions(mastra: unknown): Promise<number> {
  const store = await definitionsStore(mastra as DynamicWorkflowHost);
  if (!store) return 0;
  const { definitions } = await store.list({ status: "active" });
  let archived = 0;
  for (const definition of definitions) {
    if (definition.metadata?.origin !== DYNAMIC_WORKFLOW_ORIGIN) continue;
    await store.upsert({ id: definition.id, status: "archived" });
    (mastra as DynamicWorkflowHost).removeWorkflow?.(definition.id);
    archived += 1;
  }
  return archived;
}

interface PreparedDefinition {
  readonly ok: true;
  readonly workflowId: string;
  readonly digest: string;
  readonly stored: Record<string, unknown>;
}

type PrepareResult = PreparedDefinition | { readonly ok: false; readonly issues: string[] };

function prepare(
  definition: DynamicWorkflowDefinition,
  allowedAgents: ReadonlySet<string>,
  allowedWorkflows: ReadonlySet<string>,
): PrepareResult {
  const issues: string[] = [];
  const ids = new Set<string>();
  definition.graph.forEach((entry, index) => {
    checkEntry(entry, `graph.${index}`, 0, { allowedAgents, allowedWorkflows, ids, issues, topLevel: true });
  });
  if (issues.length > 0) return { ok: false, issues };

  const graph = definition.graph.map(clampEntry);
  const inputSchema = boundArraySchema(definition.inputSchema);
  const outputSchema = boundArraySchema(definition.outputSchema);
  const digest = createHash("sha256")
    .update(canonicalJson({ inputSchema, outputSchema, stateSchema: definition.stateSchema, graph }))
    .digest("hex");
  const workflowId = `dyn_${digest.slice(0, 16)}`;
  const stored = {
    id: workflowId,
    inputSchema,
    outputSchema,
    ...(definition.stateSchema ? { stateSchema: definition.stateSchema } : {}),
    graph,
    ...(definition.description ? { description: definition.description } : {}),
    metadata: { origin: DYNAMIC_WORKFLOW_ORIGIN, graphDigest: `sha256:${digest}` },
  };
  const upstreamIssues = validateStoredWorkflow(stored as never, {
    agents: Object.fromEntries([...allowedAgents].map(id => [id, {}])),
    workflows: Object.fromEntries([...allowedWorkflows].map(id => [id, {}])),
  });
  if (upstreamIssues.length > 0) {
    return {
      ok: false,
      issues: upstreamIssues.map(issue => `${issue.path}: ${issue.message}`),
    };
  }
  return {
    ok: true,
    workflowId,
    digest: `sha256:${digest}`,
    stored,
  };
}

interface CheckContext {
  readonly allowedAgents: ReadonlySet<string>;
  readonly allowedWorkflows: ReadonlySet<string>;
  readonly ids: Set<string>;
  readonly issues: string[];
  readonly topLevel: boolean;
}

function checkEntry(entry: DynamicWorkflowGraphEntry, path: string, depth: number, check: CheckContext): void {
  if (depth > MAX_NESTING_DEPTH) {
    check.issues.push(`${path}: container nesting exceeds depth ${MAX_NESTING_DEPTH}`);
    return;
  }
  switch (entry.type) {
    case "agent":
      claimId(entry.id, path, check);
      if (!check.allowedAgents.has(entry.agentId)) {
        check.issues.push(
          `${path}.agentId: unknown agent "${entry.agentId}". Allowed: ${[...check.allowedAgents].join(", ")}`,
        );
      }
      return;
    case "mapping":
    case "sleep":
      claimId(entry.id, path, check);
      return;
    case "workflow":
      claimId(entry.id, path, check);
      if (!check.allowedWorkflows.has(entry.workflowId)) {
        check.issues.push(
          `${path}.workflowId: nested workflow "${entry.workflowId}" is not allowlisted for dynamic use`,
        );
      }
      if (!check.topLevel && depth > 0) {
        check.issues.push(`${path}: a nested workflow may only appear at the top level or as a loop body`);
      }
      return;
    case "foreach":
      checkEntry(entry.step, `${path}.step`, depth + 1, { ...check, topLevel: false });
      return;
    case "parallel":
      entry.steps.forEach((step, index) =>
        checkEntry(step, `${path}.steps.${index}`, depth + 1, { ...check, topLevel: false }));
      return;
    case "conditional":
      if (entry.predicates.length !== entry.steps.length) {
        check.issues.push(`${path}: predicates must align one-to-one with steps`);
      }
      entry.steps.forEach((step, index) =>
        checkEntry(step, `${path}.steps.${index}`, depth + 1, { ...check, topLevel: false }));
      return;
  }
}

function claimId(id: string, path: string, check: CheckContext): void {
  if (check.ids.has(id)) check.issues.push(`${path}.id: duplicate step id "${id}"`);
  check.ids.add(id);
}

/** Concurrency is rewritten rather than rejected: the ceiling is ours, never the author's. */
function clampEntry(entry: DynamicWorkflowGraphEntry): DynamicWorkflowGraphEntry {
  if (entry.type === "foreach") {
    const concurrency = Math.min(entry.opts?.concurrency ?? 1, MAX_CONCURRENCY);
    return { ...entry, step: clampAgent(entry.step), opts: { concurrency } };
  }
  if (entry.type === "parallel") return { ...entry, steps: entry.steps.map(clampAgent) };
  if (entry.type === "conditional") {
    return { ...entry, steps: entry.steps.map(step => step.type === "agent" ? clampAgent(step) : step) };
  }
  if (entry.type === "agent") return clampAgent(entry);
  return entry;
}

function clampAgent(entry: z.infer<typeof agentEntrySchema>): z.infer<typeof agentEntrySchema> {
  if (!entry.outputSchema) return entry;
  return { ...entry, outputSchema: boundArraySchema(entry.outputSchema) as Record<string, unknown> };
}

/**
 * A `maxItems` ceiling on every array schema is the only static bound on
 * fan-out width, and `jsonSchemaToZod` enforces it at run time.
 */
function boundArraySchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(boundArraySchema);
  const record = schema as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) mapped[key] = boundArraySchema(value);
  if (record.type !== "array") return mapped;
  const declared = typeof record.maxItems === "number" ? record.maxItems : MAX_FAN_OUT;
  return { ...mapped, maxItems: Math.min(declared, MAX_FAN_OUT) };
}

async function run(
  host: DynamicWorkflowHost,
  prepared: PreparedDefinition,
  input: { description: string; input: unknown; timeoutMs: number },
  context: ToolContext,
  childRequestContext: RequestContext,
): Promise<Output> {
  try {
    await register(host, prepared.workflowId, prepared.stored);
  } catch (error) {
    return {
      version: 1 as const,
      action: "run" as const,
      workflowId: prepared.workflowId,
      graphDigest: prepared.digest,
      status: "invalid" as const,
      issues: validationIssues(error),
      resumable: false,
      truncated: false,
    };
  }
  try {
    const workflow = host.getWorkflow(prepared.workflowId) as WorkflowHandle;
    const workflowRun = await workflow.createRun();
    return await execute(
      () => workflowRun.start({
        inputData: input.input,
        requestContext: childRequestContext,
        ...writerBridge(context),
      }),
      workflowRun,
      { action: "run", workflowId: prepared.workflowId, digest: prepared.digest, timeoutMs: input.timeoutMs },
      context,
    );
  } finally {
    await unregister(host, prepared.workflowId);
  }
}

async function resume(
  host: DynamicWorkflowHost,
  input: {
    workflowId: string;
    runId: string;
    step?: string[] | undefined;
    resumeData: unknown;
    timeoutMs: number;
  },
  context: ToolContext,
  childRequestContext: RequestContext,
  allowedAgents: ReadonlySet<string>,
  allowedWorkflows: ReadonlySet<string>,
): Promise<Output> {
  const store = await definitionsStore(host);
  if (!store) return fail("resume", "This runtime has no workflow definition storage");
  const definition = await store.get(input.workflowId);
  if (!definition) return fail("resume", `No stored definition for ${input.workflowId}`);
  if (definition.metadata?.origin !== DYNAMIC_WORKFLOW_ORIGIN) {
    return fail("resume", "Stored definition is outside dynamic_workflow authority");
  }
  const parsed = definitionSchema.safeParse({
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    ...(definition.stateSchema ? { stateSchema: definition.stateSchema } : {}),
    graph: definition.graph,
    ...(definition.description ? { description: definition.description } : {}),
  });
  if (!parsed.success) return fail("resume", "Stored definition no longer satisfies the authoring contract");
  const prepared = prepare(parsed.data, allowedAgents, allowedWorkflows);
  if (!prepared.ok) return fail("resume", `Stored definition is outside current authority: ${prepared.issues.join("; ")}`);
  if (prepared.workflowId !== input.workflowId || definition.metadata.graphDigest !== prepared.digest) {
    return fail("resume", "Stored definition identity or digest does not match its content");
  }
  try {
    await register(host, input.workflowId, prepared.stored);
  } catch (error) {
    return fail("resume", message(error));
  }
  try {
    const workflow = host.getWorkflow(input.workflowId) as WorkflowHandle;
    const workflowRun = await workflow.createRun({ runId: input.runId });
    return await execute(
      () => workflowRun.resume({
        ...(input.step ? { step: input.step } : {}),
        resumeData: input.resumeData,
        requestContext: childRequestContext,
        ...writerBridge(context),
      }),
      workflowRun,
      { action: "resume", workflowId: input.workflowId, timeoutMs: input.timeoutMs },
      context,
    );
  } finally {
    await unregister(host, input.workflowId);
  }
}

async function inspect(
  host: DynamicWorkflowHost,
  input: { workflowId?: string | undefined; runId?: string | undefined },
): Promise<Output> {
  const store = await definitionsStore(host);
  if (!store) return { version: 1 as const, action: "inspect" as const, runs: [], resumable: false, truncated: false };
  const { definitions } = await store.list({ status: "archived" });
  const workflowIds = new Set(definitions
    .filter(definition => definition.metadata?.origin === DYNAMIC_WORKFLOW_ORIGIN)
    .filter(definition => !input.workflowId || definition.id === input.workflowId)
    .map(definition => definition.id));
  const runsStore = await workflowRunsStore(host);
  if (!runsStore || workflowIds.size === 0) {
    return { version: 1 as const, action: "inspect" as const, runs: [], resumable: false, truncated: false };
  }
  const listed = await runsStore.listWorkflowRuns({
    ...(input.workflowId ? { workflowName: input.workflowId } : {}),
    perPage: 20,
  });
  const runs = listed.runs
    .filter(run => workflowIds.has(run.workflowName))
    .filter(run => !input.runId || run.runId === input.runId)
    .slice(0, 20)
    .map(run => ({ workflowId: run.workflowName, runId: run.runId, status: workflowRunStatus(run.snapshot) }));
  return { version: 1 as const, action: "inspect" as const, runs, resumable: false, truncated: false };
}

interface RunMeta {
  readonly action: "run" | "resume";
  readonly workflowId: string;
  readonly digest?: string;
  readonly timeoutMs: number;
}

async function execute(
  start: () => Promise<WorkflowResultLike>,
  workflowRun: RunHandle,
  meta: RunMeta,
  context: ToolContext,
): Promise<Output> {
  const timeout = AbortSignal.timeout(meta.timeoutMs);
  const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => {
    void workflowRun.cancel().catch(() => undefined);
    rejectAbort?.(new Error(context.abortSignal?.aborted ? "Dynamic workflow was cancelled" : "Dynamic workflow timed out"));
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const result = await Promise.race([start(), aborted]);
    const bounded = boundSteps(result.steps);
    const boundedOutput = boundOutput(result.result);
    return {
      version: 1 as const,
      action: meta.action,
      workflowId: meta.workflowId,
      ...(meta.digest ? { graphDigest: meta.digest } : {}),
      runId: workflowRun.runId,
      status: result.status as Output["status"],
      ...(boundedOutput.output === undefined ? {} : { output: boundedOutput.output }),
      ...(result.error ? { error: String(result.error.message ?? result.error).slice(0, 2_000) } : {}),
      ...(result.suspended ? { suspended: result.suspended.map(path => ({ path })).slice(0, 8) } : {}),
      steps: bounded.steps,
      resumable: result.status === "suspended",
      truncated: bounded.truncated || boundedOutput.truncated,
    };
  } catch (error) {
    return {
      version: 1 as const,
      action: meta.action,
      workflowId: meta.workflowId,
      runId: workflowRun.runId,
      status: "failed" as const,
      error: message(error).slice(0, 2_000),
      resumable: false,
      truncated: false,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * Child runs share the live aggregate budget and the serializable workspace
 * root. Agents resolve live workspace and identity state from their host.
 */
function dispatchContext(
  parent: RequestContext,
): RequestContext {
  const dispatch = new RequestContext();
  dispatch.set(DYNAMIC_WORKFLOW_DEPTH_CONTEXT_KEY, 1);
  const runBudget = parent.get(RUN_BUDGET_CONTEXT_KEY);
  if (runBudget !== undefined) dispatch.set(RUN_BUDGET_CONTEXT_KEY, runBudget);
  const workspaceRoot = parent.get("workspaceRoot");
  if (typeof workspaceRoot === "string") dispatch.set("workspaceRoot", workspaceRoot);
  return dispatch;
}

function writerBridge(context: ToolContext): { outputWriter?: (chunk: unknown) => Promise<void> } {
  if (!context.writer) return {};
  const writer = context.writer;
  return { outputWriter: async chunk => { await writer.write(chunk); } };
}

async function register(host: DynamicWorkflowHost, id: string, stored: Record<string, unknown>): Promise<void> {
  const states = registrations.get(host) ?? new Map<string, RegistrationState>();
  registrations.set(host, states);
  const current = states.get(id);
  if (current) {
    current.references += 1;
    await current.ready;
    return;
  }
  const ready = registerDefinition(host, id, stored);
  const state = { references: 1, ready };
  states.set(id, state);
  try {
    await ready;
  } catch (error) {
    if (states.get(id) === state) states.delete(id);
    throw error;
  }
}

async function unregister(host: DynamicWorkflowHost, id: string): Promise<void> {
  const states = registrations.get(host);
  const state = states?.get(id);
  if (!states || !state) return;
  state.references -= 1;
  if (state.references > 0) return;
  states.delete(id);
  host.removeWorkflow?.(id);
}

async function registerDefinition(
  host: DynamicWorkflowHost,
  id: string,
  stored: Record<string, unknown>,
): Promise<void> {
  try {
    await host.addStoredWorkflow(stored);
    const store = await definitionsStore(host);
    if (!store) throw new Error("dynamic_workflow requires workflow definition storage");
    await store.upsert({ id, status: "archived" });
  } catch (error) {
    host.removeWorkflow?.(id);
    throw error;
  }
}

async function definitionsStore(host: DynamicWorkflowHost): Promise<WorkflowDefinitionsStore | undefined> {
  const storage = host.getStorage?.() as { getStore?: (name: string) => unknown } | undefined;
  if (!storage?.getStore) return undefined;
  const store = await storage.getStore("workflowDefinitions") as WorkflowDefinitionsStore | undefined;
  return store?.upsert ? store : undefined;
}

async function workflowRunsStore(host: DynamicWorkflowHost): Promise<WorkflowRunsStore | undefined> {
  const storage = host.getStorage?.() as { getStore?: (name: string) => unknown } | undefined;
  if (!storage?.getStore) return undefined;
  const store = await storage.getStore("workflows") as WorkflowRunsStore | undefined;
  return store?.listWorkflowRuns ? store : undefined;
}

function workflowRunStatus(snapshot: unknown): string {
  let value = snapshot;
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return "unknown"; }
  }
  if (!value || typeof value !== "object") return "unknown";
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : "unknown";
}

/** Upstream reports every graph problem at once; that list is the repair loop. */
function validationIssues(error: unknown): string[] {
  return message(error)
    .split("\n")
    .map(line => line.replace(/^-\s*/, "").trim())
    .filter(line => line.length > 0 && !line.startsWith("Stored workflow"))
    .slice(0, 24)
    .map(line => line.slice(0, 600));
}

function boundSteps(steps: unknown): { steps: Array<{ id: string; status: string }>; truncated: boolean } {
  if (!steps || typeof steps !== "object") return { steps: [], truncated: false };
  const entries = Object.entries(steps as Record<string, unknown>);
  let remaining = MAX_RETAINED_CHARS;
  let truncated = entries.length > 32;
  const bounded: Array<{ id: string; status: string }> = [];
  for (const [id, value] of entries.slice(0, 32)) {
    const record = (value ?? {}) as { status?: unknown; output?: unknown };
    const serialized = record.output === undefined ? "" : safeJson(record.output);
    const budget = Math.min(MAX_ROW_CHARS, Math.max(0, remaining));
    const output = retainEnds(serialized, budget);
    if (output.length < serialized.length) truncated = true;
    remaining -= output.length;
    bounded.push({
      id,
      status: typeof record.status === "string" ? record.status : "unknown",
      ...(output ? { output } : {}),
    });
  }
  return { steps: bounded, truncated };
}

function boundOutput(output: unknown): { output: unknown; truncated: boolean } {
  if (output === undefined) return { output: undefined, truncated: false };
  const serialized = safeJson(output);
  if (serialized.length <= MAX_RETAINED_CHARS) return { output, truncated: false };
  const metadataReserve = 160;
  return {
    output: {
      truncated: true,
      originalChars: serialized.length,
      preview: retainEnds(serialized, MAX_RETAINED_CHARS - metadataReserve),
    },
    truncated: true,
  };
}

function retainEnds(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n… output truncated …\n";
  if (limit <= marker.length) return marker.slice(0, Math.max(0, limit));
  const retained = Math.max(0, limit - marker.length);
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`;
}

function fail(action: "run" | "resume", error: string): Output {
  return { version: 1 as const, action, status: "failed" as const, error, resumable: false, truncated: false };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** Key-sorted so an identical graph always yields an identical digest. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type Output = z.infer<typeof outputSchema>;

interface ToolContext {
  readonly requestContext: RequestContext;
  readonly abortSignal?: AbortSignal;
  readonly writer?: { write(chunk: unknown): Promise<void> };
}

interface WorkflowHandle {
  createRun(options?: { runId?: string }): Promise<RunHandle>;
}

interface RunHandle {
  readonly runId: string;
  start(options: Record<string, unknown>): Promise<WorkflowResultLike>;
  resume(options: Record<string, unknown>): Promise<WorkflowResultLike>;
  cancel(): Promise<void>;
}

interface WorkflowResultLike {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: { message?: string };
  readonly suspended?: string[][];
  readonly steps?: unknown;
}
