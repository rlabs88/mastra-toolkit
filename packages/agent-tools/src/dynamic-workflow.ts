import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { Workspace } from "@mastra/core/workspace";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateStoredWorkflow } from "@mastra/core/workflows";
import { RUN_BUDGET_CONTEXT_KEY, RUN_CONTAINMENT_POLICY } from "./capabilities.js";

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
const MAX_SLEEP_MS = 60_000;
const MAX_ROW_CHARS = 2_000;
const MAX_RETAINED_CHARS = 24_000;
const MAX_INSPECT_RUNS = 20;

/**
 * Bumped whenever any ceiling above changes. The value is digested with the
 * graph, so a definition stored under one policy can never be mistaken for the
 * same graph clamped under another, and `resume` can say which policy a
 * suspended run belongs to instead of reporting a bare digest mismatch.
 */
const CEILING_POLICY_VERSION = 1;

export const DYNAMIC_WORKFLOW_CEILING_POLICY = Object.freeze({
  version: CEILING_POLICY_VERSION,
  maxGraphEntries: MAX_GRAPH_ENTRIES,
  maxFanOut: MAX_FAN_OUT,
  maxConcurrency: MAX_CONCURRENCY,
  maxSleepMs: MAX_SLEEP_MS,
});

const CEILING_POLICY = DYNAMIC_WORKFLOW_CEILING_POLICY;

/** Named so a model that cannot resume learns why, and that the run is unrecoverable rather than mistyped. */
export const DYNAMIC_WORKFLOW_CEILING_POLICY_MISMATCH = "ceiling_policy_mismatch";

/**
 * Three bounds used to be set independently and could not all hold at once.
 *
 * The tool's own `timeoutMs` must expire strictly before the background
 * harness reclaims the call, or the harness kills the invocation while
 * `cancel()` is still in flight and the run is never contained. The harness
 * bound in turn has to fit inside the aggregate run budget, or a single
 * dynamic workflow can outlive the wall clock that is supposed to contain the
 * whole agent run. `timeBoundsInvariant` is the executable statement of that
 * ordering.
 */
const MAX_TIMEOUT_MS = 600_000;
const CANCELLATION_GRACE_MS = 30_000;
const BACKGROUND_TIMEOUT_MS = MAX_TIMEOUT_MS + CANCELLATION_GRACE_MS;

export const DYNAMIC_WORKFLOW_TIME_BOUNDS = Object.freeze({
  maxTimeoutMs: MAX_TIMEOUT_MS,
  cancellationGraceMs: CANCELLATION_GRACE_MS,
  backgroundTimeoutMs: BACKGROUND_TIMEOUT_MS,
  runBudgetWallClockMs: RUN_CONTAINMENT_POLICY.maxWallClockMs,
});

/** True only while every authored timeout can still be cancelled and reported inside the run budget. */
export function timeBoundsInvariant(): boolean {
  return MAX_TIMEOUT_MS < BACKGROUND_TIMEOUT_MS
    && BACKGROUND_TIMEOUT_MS <= RUN_CONTAINMENT_POLICY.maxWallClockMs;
}

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

/**
 * Branch bodies are agents only, matching `foreach` and `parallel`. Every
 * container therefore holds leaf entries exclusively, so a container can never
 * hold another container and graph nesting is bounded by the union itself
 * rather than by a depth counter that has to be trusted and kept in sync.
 */
const conditionalEntrySchema = z.object({
  type: z.literal("conditional"),
  steps: z.array(agentEntrySchema).min(1).max(MAX_CONCURRENCY),
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
    timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(300_000),
    dryRun: z.boolean().default(false).describe("Validate and content-address only. No approval, no execution, no persistence."),
  }).strict(),
  z.object({
    action: z.literal("resume"),
    description: singleLine,
    workflowId: z.string().regex(DYNAMIC_WORKFLOW_ID_PATTERN),
    runId: z.string().min(1).max(200),
    step: z.array(z.string().min(1)).min(1).max(8).optional(),
    resumeData: z.unknown().default({}),
    timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(300_000),
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
    /** Resumable step paths, so a caller can resume from `inspect` alone. */
    suspended: z.array(z.array(z.string())).max(8).optional(),
  }).passthrough()).max(MAX_INSPECT_RUNS).optional(),
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

interface WorkflowRunRow {
  readonly workflowName: string;
  readonly runId: string;
  readonly snapshot: unknown;
}

interface WorkflowRunsStore {
  listWorkflowRuns(args?: { workflowName?: string; perPage?: number }): Promise<{
    runs: WorkflowRunRow[];
    total?: number;
  }>;
  getWorkflowRunById?(args: { runId: string; workflowName?: string }): Promise<WorkflowRunRow | null>;
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
    background: { enabled: true, timeoutMs: BACKGROUND_TIMEOUT_MS },
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
      // Width is checked on the dry-run path too, so a graph validated for free
      // with its real input cannot still be refused once an approval is spent.
      const widthIssues: string[] = [];
      checkInputWidth(prepared.stored.inputSchema, input.input, "input", widthIssues);
      if (widthIssues.length > 0) {
        return {
          version: 1 as const,
          action: "run" as const,
          workflowId: prepared.workflowId,
          graphDigest: prepared.digest,
          status: "invalid" as const,
          issues: widthIssues.slice(0, 24),
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
    checkEntry(entry, `graph.${index}`, { allowedAgents, allowedWorkflows, ids, issues });
  });
  checkForeachSources(definition, issues);
  if (issues.length > 0) return { ok: false, issues };

  const graph = definition.graph.map(clampEntry);
  const inputSchema = boundArraySchema(definition.inputSchema);
  const outputSchema = boundArraySchema(definition.outputSchema);
  const stateSchema = definition.stateSchema ? boundArraySchema(definition.stateSchema) : undefined;
  const digest = createHash("sha256")
    .update(canonicalJson({ ceilingPolicy: CEILING_POLICY, inputSchema, outputSchema, stateSchema, graph }))
    .digest("hex");
  const workflowId = `dyn_${digest.slice(0, 16)}`;
  const stored = {
    id: workflowId,
    inputSchema,
    outputSchema,
    ...(stateSchema ? { stateSchema } : {}),
    graph,
    ...(definition.description ? { description: definition.description } : {}),
    metadata: {
      origin: DYNAMIC_WORKFLOW_ORIGIN,
      graphDigest: `sha256:${digest}`,
      ceilingPolicy: CEILING_POLICY,
    },
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
}

function checkEntry(entry: DynamicWorkflowGraphEntry, path: string, check: CheckContext): void {
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
      return;
    case "foreach":
      checkEntry(entry.step, `${path}.step`, check);
      return;
    case "parallel":
    case "conditional":
      if (entry.type === "conditional" && entry.predicates.length !== entry.steps.length) {
        check.issues.push(`${path}: predicates must align one-to-one with steps`);
      }
      entry.steps.forEach((step, index) => checkEntry(step, `${path}.steps.${index}`, check));
      return;
  }
}

/**
 * Rejects rather than clamps. Concurrency is a scheduling knob the host may
 * silently rewrite, but the iteration source is the author's declared unit of
 * work: quietly reducing a declared `maxItems: 50` to 8 would run a twelfth of
 * the requested fan-out and report success, so an over-wide source is refused
 * with the ceiling named instead.
 */
function checkForeachSources(definition: DynamicWorkflowDefinition, issues: string[]): void {
  definition.graph.forEach((entry, index) => {
    if (entry.type !== "foreach") return;
    const source = foreachSourceSchema(definition, index);
    const declared = declaredMaxItems(source);
    if (declared === undefined || declared <= MAX_FAN_OUT) return;
    issues.push(
      `graph.${index}: foreach iterates a source declaring maxItems ${declared}, `
      + `above the ${MAX_FAN_OUT}-iteration ceiling. Narrow the source or split the work across runs.`,
    );
  });
}

/**
 * The schema feeding a `foreach`, for the positions where it is statically
 * knowable. A nested workflow's or mapping's output shape lives outside this
 * definition, so those predecessors yield `undefined` and the run-time width
 * check in `checkInputWidth` remains the binding control.
 */
function foreachSourceSchema(definition: DynamicWorkflowDefinition, index: number): unknown {
  if (index === 0) return definition.inputSchema;
  const previous = definition.graph[index - 1];
  if (previous?.type === "agent") return previous.outputSchema;
  return undefined;
}

function declaredMaxItems(schema: unknown): number | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const record = schema as Record<string, unknown>;
  if (record.type !== "array") return undefined;
  return typeof record.maxItems === "number" ? record.maxItems : undefined;
}

/**
 * Counts elements at every array-typed path of the clamped input schema.
 *
 * This is the fan-out ceiling. Upstream's `jsonSchemaToZod` builds array
 * schemas as `z.array(walk(items))` and never reads `maxItems` — the keyword
 * is not even in its `UNSUPPORTED_SCHEMA_KEYS`, so a stamped ceiling is
 * silently discarded rather than rejected. Nothing downstream of `start()`
 * counts elements, so an unchecked 200-element input would turn one approval
 * into 200 agent invocations.
 */
function checkInputWidth(schema: unknown, value: unknown, path: string, issues: string[]): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.type === "array" && Array.isArray(value)) {
    const limit = typeof record.maxItems === "number" ? Math.min(record.maxItems, MAX_FAN_OUT) : MAX_FAN_OUT;
    if (value.length > limit) {
      issues.push(
        `${path}: ${value.length} elements exceeds the ${limit}-element fan-out ceiling. `
        + "Split the work across runs.",
      );
      return;
    }
    value.forEach((element, index) => checkInputWidth(record.items, element, `${path}[${index}]`, issues));
    return;
  }
  if (record.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const properties = record.properties;
    if (!properties || typeof properties !== "object") return;
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      if (!(key in (value as Record<string, unknown>))) continue;
      checkInputWidth(child, (value as Record<string, unknown>)[key], `${path}.${key}`, issues);
    }
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
 * Stamps a `maxItems` ceiling on every array schema, so the persisted
 * definition states the width it was admitted under.
 *
 * This is documentation, not enforcement. Upstream's `jsonSchemaToZod` builds
 * `z.array(walk(items))` and never reads `maxItems`, and the keyword is absent
 * from its `UNSUPPORTED_SCHEMA_KEYS`, so a rehydrated definition drops the
 * ceiling silently rather than refusing it. `checkInputWidth` is what actually
 * binds, before `start()`.
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
  // Checked before re-preparing, because lowering any ceiling changes the
  // digest of every graph clamped under the old one. Without this the run
  // would fail as a content mismatch, which reads as corruption rather than as
  // a deliberate policy change nobody can resume across.
  const drift = ceilingPolicyDrift(definition.metadata.ceilingPolicy);
  if (drift) {
    return fail(
      "resume",
      `${DYNAMIC_WORKFLOW_CEILING_POLICY_MISMATCH}: run was suspended under ceiling policy `
      + `v${drift.storedVersion ?? "unversioned"}, and this runtime enforces v${CEILING_POLICY_VERSION} `
      + `(${drift.changed.join(", ")}). Ceilings changed while the run was suspended, so it cannot be `
      + "resumed under them. Author the graph again.",
    );
  }
  const prepared = prepare(parsed.data, allowedAgents, allowedWorkflows);
  if (!prepared.ok) return fail("resume", `Stored definition is outside current authority: ${prepared.issues.join("; ")}`);
  if (prepared.workflowId !== input.workflowId || definition.metadata.graphDigest !== prepared.digest) {
    return fail("resume", "Stored definition identity or digest does not match its content");
  }
  const owned = await runBelongsToWorkflow(host, input.workflowId, input.runId);
  if (!owned.ok) return fail("resume", owned.error);
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

/**
 * Compares the whole stored policy rather than its version alone, so lowering
 * a ceiling without remembering to bump `CEILING_POLICY_VERSION` still yields
 * the named error instead of an opaque digest mismatch. Returns `undefined`
 * when the stored policy matches this runtime's exactly.
 */
function ceilingPolicyDrift(
  value: unknown,
): { storedVersion: number | undefined; changed: string[] } | undefined {
  const stored = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const storedVersion = typeof stored.version === "number" ? stored.version : undefined;
  const changed = Object.entries(CEILING_POLICY)
    .filter(([key, current]) => stored[key] !== current)
    .map(([key, current]) => `${key}: ${String(stored[key] ?? "absent")} -> ${String(current)}`);
  const extra = Object.keys(stored).filter(key => !(key in CEILING_POLICY));
  if (changed.length === 0 && extra.length === 0) return undefined;
  return { storedVersion, changed: [...changed, ...extra.map(key => `${key}: removed`)] };
}

/**
 * `createRun({ runId })` mints a fresh run for an id it does not recognise, so
 * an unverified resume would silently start a second run of the graph under
 * the caller's chosen id instead of continuing the suspended one. Fails closed
 * when the runtime cannot answer, because an unverifiable id is exactly the
 * case this guards.
 */
async function runBelongsToWorkflow(
  host: DynamicWorkflowHost,
  workflowId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const runsStore = await workflowRunsStore(host);
  if (!runsStore?.getWorkflowRunById) {
    return { ok: false, error: "This runtime cannot verify run ownership, so resume is refused" };
  }
  const row = await runsStore.getWorkflowRunById({ runId, workflowName: workflowId });
  if (!row || row.workflowName !== workflowId) {
    return { ok: false, error: `Run ${runId} does not exist for ${workflowId}` };
  }
  const status = workflowRunStatus(row.snapshot);
  if (status !== "suspended") {
    return { ok: false, error: `Run ${runId} is ${status}, not suspended, so there is nothing to resume` };
  }
  return { ok: true };
}

function emptyInspect(truncated = false): Output {
  return { version: 1 as const, action: "inspect" as const, runs: [], resumable: false, truncated };
}

/**
 * Pages per dynamic workflow id rather than paging the whole runs table and
 * filtering afterwards: a shared table's first page belongs to whichever
 * workflow ran most recently, so a dynamic run behind any busier workflow used
 * to be silently absent from its own inspection.
 */
async function inspect(
  host: DynamicWorkflowHost,
  input: { workflowId?: string | undefined; runId?: string | undefined },
): Promise<Output> {
  const store = await definitionsStore(host);
  if (!store) return emptyInspect();
  const { definitions } = await store.list({ status: "archived" });
  const workflowIds = definitions
    .filter(definition => definition.metadata?.origin === DYNAMIC_WORKFLOW_ORIGIN)
    .filter(definition => !input.workflowId || definition.id === input.workflowId)
    .map(definition => definition.id);
  const runsStore = await workflowRunsStore(host);
  if (!runsStore || workflowIds.length === 0) return emptyInspect();

  const collected: WorkflowRunRow[] = [];
  let pageTruncated = false;
  for (const workflowId of workflowIds) {
    const listed = await runsStore.listWorkflowRuns({ workflowName: workflowId, perPage: MAX_INSPECT_RUNS });
    // Defensive: a store that ignores `workflowName` must not widen the result.
    const owned = listed.runs.filter(run => run.workflowName === workflowId);
    if (typeof listed.total === "number" && listed.total > owned.length) pageTruncated = true;
    collected.push(...owned);
  }

  const matching = input.runId ? collected.filter(run => run.runId === input.runId) : collected;
  const runs = matching.slice(0, MAX_INSPECT_RUNS).map(run => {
    const suspended = suspendedStepPaths(run.snapshot);
    return {
      workflowId: run.workflowName,
      runId: run.runId,
      status: workflowRunStatus(run.snapshot),
      ...(suspended.length > 0 ? { suspended: suspended.slice(0, 8) } : {}),
    };
  });
  return {
    version: 1 as const,
    action: "inspect" as const,
    runs,
    resumable: runs.some(run => run.status === "suspended"),
    // A located run is a complete answer; otherwise a cut page may have hidden it.
    truncated: input.runId
      ? matching.length === 0 && pageTruncated
      : pageTruncated || matching.length > MAX_INSPECT_RUNS,
  };
}

/**
 * The resumable step paths upstream derives from a suspended snapshot, so a
 * model that lost its transcript can pass one straight back as `step`.
 */
function suspendedStepPaths(snapshot: unknown): string[][] {
  const parsed = parseSnapshot(snapshot);
  const suspendedPaths = parsed?.suspendedPaths;
  if (!suspendedPaths || typeof suspendedPaths !== "object") return [];
  const context = (parsed.context ?? {}) as Record<string, unknown>;
  const paths: string[][] = [];
  for (const stepId of Object.keys(suspendedPaths as Record<string, unknown>)) {
    const stepResult = context[stepId] as {
      status?: unknown;
      suspendPayload?: { __workflow_meta?: { path?: unknown } };
    } | undefined;
    if (stepResult?.status !== "suspended") continue;
    const nested = stepResult.suspendPayload?.__workflow_meta?.path;
    paths.push(Array.isArray(nested) ? [stepId, ...nested.map(String)] : [stepId]);
  }
  return paths;
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
  // Held so the caller's `finally` can wait for containment to settle before
  // unregistering. Cancelling and unregistering concurrently would drop a live
  // workflow out of the registry while it is still executing.
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= workflowRun.cancel().catch(() => undefined);
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
    // Bounded, because an upstream `cancel()` that never settles must not pin
    // the tool call open past the harness deadline. A stale registration is
    // the lesser failure once the grace has elapsed.
    if (cancellation) await Promise.race([cancellation, grace(CANCELLATION_GRACE_MS)]);
  }
}

function grace(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
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

interface RunSnapshot {
  readonly status?: unknown;
  readonly suspendedPaths?: unknown;
  readonly context?: unknown;
}

/** Snapshots arrive as objects from some stores and as JSON text from others. */
function parseSnapshot(snapshot: unknown): RunSnapshot | undefined {
  let value = snapshot;
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  return value && typeof value === "object" ? value as RunSnapshot : undefined;
}

function workflowRunStatus(snapshot: unknown): string {
  const status = parseSnapshot(snapshot)?.status;
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
