import { randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import {
  SANDBOX_PROJECT_WORKFLOW_RESULT_PREFIX,
  SANDBOX_PROJECT_WORKFLOW_RUNNER,
  SANDBOX_PROJECT_WORKFLOW_STREAM_PREFIX,
} from "@rlabs/project-mounting-manager";

const projectWorkflowInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({
    action: z.literal("run"),
    workflowId: z.string().min(1).max(200),
    input: z.record(z.string(), z.unknown()),
  }).strict(),
]);

export function createFactoryProjectWorkflowTool() {
  return createTool({
    id: "project_workflow",
    description: "List or run workflows explicitly published by the active Factory project. Workflow source and execution stay inside the session sandbox.",
    inputSchema: projectWorkflowInputSchema,
    // Listing imports project modules, so it needs the same approval boundary as execution.
    requireApproval: true,
    execute: async (input, context) => {
      const workspace = context.workspace;
      if (!workspace) throw new Error("Project workflows require an active Factory session workspace");
      const [filesystem, sandbox] = await Promise.all([
        workspace.resolveFilesystem({ requestContext: context.requestContext }),
        workspace.resolveSandbox({ requestContext: context.requestContext }),
      ]);
      if (filesystem?.provider !== "sandbox" || !filesystem.basePath || !sandbox?.executeCommand) {
        throw new Error("Project workflows require a sandbox-backed Factory session workspace");
      }
      const args = ["--eval", SANDBOX_PROJECT_WORKFLOW_RUNNER, "--", input.action];
      const cancellationPath = input.action === "run"
        ? `.mastracode/.factory-runtime/cancel-${randomUUID()}`
        : undefined;
      if (input.action === "run") {
        args.push(
          input.workflowId,
          Buffer.from(JSON.stringify(input.input)).toString("base64url"),
          cancellationPath!,
        );
      }
      const forcedCancellation = new AbortController();
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let cancellationWrite = Promise.resolve();
      const cancel = () => {
        if (!cancellationPath) {
          forcedCancellation.abort();
          return;
        }
        cancellationWrite = filesystem.writeFile(cancellationPath, "", { recursive: true })
          .catch(() => forcedCancellation.abort());
        forceTimer = setTimeout(() => forcedCancellation.abort(), 2_000);
      };
      if (context.abortSignal?.aborted) cancel();
      else context.abortSignal?.addEventListener("abort", cancel, { once: true });
      let result;
      const output = createRunnerOutputForwarder(context.writer);
      try {
        result = await sandbox.executeCommand("tsx", args, {
          cwd: filesystem.basePath,
          timeout: 300_000,
          abortSignal: forcedCancellation.signal,
          onStdout: output.push,
        });
      } catch (error) {
        if (context.abortSignal?.aborted) {
          throw new Error("Project workflow execution was cancelled", { cause: error });
        }
        throw error;
      } finally {
        context.abortSignal?.removeEventListener("abort", cancel);
        if (forceTimer) clearTimeout(forceTimer);
        await cancellationWrite;
        if (cancellationPath) {
          await filesystem.deleteFile(cancellationPath, { force: true }).catch(() => undefined);
        }
      }
      if (context.abortSignal?.aborted) throw new Error("Project workflow execution was cancelled");
      if (!output.received) output.push(result.stdout);
      await output.finish();
      if (result.exitCode !== 0) {
        if (result.exitCode === 127 || /tsx: (?:command )?not found/i.test(result.stderr)) {
          throw new Error("The sandbox mcode-runtime layer must provide the tsx project workflow runner");
        }
        const output = parseRunnerOutput(result.stdout, false);
        const detail = output && typeof output.error === "string"
          ? output.error
          : result.stderr.trim() || `sandbox command exited ${result.exitCode}`;
        throw new Error(`Project workflow execution failed inside the sandbox: ${detail}`);
      }
      return parseRunnerOutput(result.stdout, true)!;
    },
  });
}

function createRunnerOutputForwarder(
  writer: { write(chunk: unknown): Promise<unknown> | unknown } | undefined,
): {
  readonly received: boolean;
  push(data: string): void;
  finish(): Promise<void>;
} {
  let received = false;
  let tail = "";
  let writes = Promise.resolve();
  const forwardLine = (line: string) => {
    if (!writer || !line.startsWith(SANDBOX_PROJECT_WORKFLOW_STREAM_PREFIX)) return;
    const encoded = line.slice(SANDBOX_PROJECT_WORKFLOW_STREAM_PREFIX.length);
    const chunk = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    writes = writes.then(async () => { await writer.write(chunk); });
  };
  return {
    get received() { return received; },
    push(data) {
      received = true;
      const lines = `${tail}${data}`.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) forwardLine(line);
    },
    async finish() {
      if (tail) forwardLine(tail);
      await writes;
    },
  };
}

function parseRunnerOutput(stdout: string, required: boolean): Record<string, unknown> | undefined {
  const marker = stdout.lastIndexOf(SANDBOX_PROJECT_WORKFLOW_RESULT_PREFIX);
  if (marker < 0) {
    if (required) throw new Error("Project workflow runner returned no structured result");
    return undefined;
  }
  const serialized = stdout.slice(marker + SANDBOX_PROJECT_WORKFLOW_RESULT_PREFIX.length).trim().split("\n", 1)[0];
  if (!serialized) throw new Error("Project workflow runner returned an empty result");
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Project workflow runner returned an invalid result");
  }
  return parsed as Record<string, unknown>;
}

import { RequestContext } from "@mastra/core/request-context";
import type { ApiRoute } from "@mastra/core/server";
import type { FactoryIntegration, IntegrationContext, IntegrationTools } from "@mastra/factory";
import { getFactoryAuthUserId, type FactoryAuthUser } from "@mastra/factory/auth";
import { getFactorySessionAddress } from "@mastra/factory/rules/binding-context";
import {
  type ToolkitAgents,
  type ToolkitAgentsOptions,
} from "@rlabs/agents-roles";
import {
  createToolkitRuntimeContract,
  type ToolkitRuntimeBinding,
  type ToolkitRuntimeContract,
} from "@rlabs/mastra-primitives-export";
import { loadModelProfile, type RuntimeDefaultsV1 } from "@rlabs/runtime-config";
import { z } from "zod";

const FACTORY_CONTROLLER_PROJECTION = Symbol("factory-controller-projection");

/**
 * Exactly the canonical agents a Factory-authored graph may dispatch.
 *
 * A hand-maintained literal, deliberately **not** derived from the canonical
 * role list. This is a security boundary, and the value of writing it out is
 * that a fifth canonical role cannot join it by the canonical list merely
 * growing — admitting one stays a deliberate edit with a deliberate reviewer.
 * Do not "simplify" this to `ROLE_IDS`; that would silently widen the boundary.
 *
 * Ayra is in it because the user widened it by hand: Ayra authors dynamic
 * workflows on every other host, so excluding it would make Factory the one
 * host where the orchestration role cannot orchestrate.
 *
 * Factory's own controller agent, per-project mounted specialists, and
 * scheduler workers stay outside it. Admitting any of them is a separate
 * decision, not a consequence of this one.
 */
export const FACTORY_DYNAMIC_WORKFLOW_AGENT_IDS = Object.freeze(
  ["cortex", "flux", "zen", "ayra"] as const,
);

/**
 * What the Factory projection can prove about its dynamic orchestration seam.
 *
 * `enforced` lists the checks that hold today. `residual` lists the isolation
 * gaps that survive them and cannot be closed from this package, because the
 * tool content-addresses its workflow id over graph bytes alone and neither its
 * stored definitions nor its run rows carry a tenant column.
 */
export interface FactoryOrchestrationCapability {
  readonly tool: "dynamic-workflow/v1";
  readonly seam: "integration-agent-tools";
  readonly stage: "execution-session";
  readonly agents: typeof FACTORY_DYNAMIC_WORKFLOW_AGENT_IDS;
  readonly resumable: false;
  readonly tenantIsolation: {
    readonly scope: "project-user-session";
    readonly enforced: readonly [
      "authorize-requires-execution-session",
      "scoped-workflow-identity",
      "scoped-inspect",
      "resume-disabled",
    ];
    readonly residual: readonly ["dispatched-runs-carry-no-factory-session"];
    readonly residualClosedBy: "durable-request-context-reconstruction";
  };
}

export interface FactoryControllerProjection {
  readonly agents: ToolkitAgents;
  readonly binding: ToolkitRuntimeBinding;
  readonly tools: {
    readonly dynamic_workflow: NonNullable<ToolkitAgentsOptions["dynamicWorkflow"]>;
  };
  readonly runtime: {
    readonly defaults: RuntimeDefaultsV1;
  };
  readonly capability: {
    readonly projection: "factory";
    readonly contractDigest: `sha256:${string}`;
    readonly controllerConstruction: {
      readonly owner: "@mastra/factory";
      readonly count: 1;
      readonly canonicalModesAndSubagents: "upstream-blocked";
      readonly missingConstructionInputs: readonly ["modes", "subagents", "controller-construction callback"];
    };
    readonly orchestration: FactoryOrchestrationCapability;
  };
  readonly [FACTORY_CONTROLLER_PROJECTION]: true;
};

export type FactoryAgentBundle = FactoryControllerProjection;

export interface FactoryControllerProjectionOptions
  extends Omit<ToolkitAgentsOptions, "profile" | "dynamicWorkflow"> {}

export class ToolkitFactoryIntegration implements FactoryIntegration {
  readonly id = "mastra-toolkit";

  constructor(
    private readonly bundle: FactoryControllerProjection,
    _runtimeDefaults?: RuntimeDefaultsV1,
  ) {
    if (bundle[FACTORY_CONTROLLER_PROJECTION] !== true) {
      throw new Error("Factory controller projections must be created with createFactoryControllerProjection");
    }
  }

  routes(_context: IntegrationContext): ApiRoute[] {
    return [];
  }

  async agentTools(): Promise<IntegrationTools> {
    return {
      project_workflow: createFactoryProjectWorkflowTool(),
      // Contributing a tool is a supported integration seam; the upstream
      // blocker gates controller ingredients, which this is not.
      dynamic_workflow: this.bundle.tools.dynamic_workflow,
    } as IntegrationTools;
  }

  diagnostics(): Record<string, unknown> {
    return {
      configured: true,
      // Derived from what this projection actually registers. Diagnostics
      // describe reality rather than police it, so unlike the dispatch
      // allowlist this must never be a literal that can drift.
      agents: Object.keys(this.bundle.agents),
      recursionGuarded: true,
      runtimeDefaults: {
        source: "@rlabs/runtime-config/models.yaml",
        version: this.bundle.runtime.defaults.version,
        factoryMemory: this.bundle.runtime.defaults.factory,
        persistedPrecedence: "memory-settings-over-startup-defaults",
        fillPolicy: "null-fields-only",
        thresholdFillAtomicity: "unsupported-upstream",
        sessionDisplayConvergence: {
          status: "upstream-blocked",
          issue: "#129",
        },
      },
      agentBoundary: {
        source: "@rlabs/mastra-primitives-export",
        contractDigest: this.bundle.capability.contractDigest,
        controllerConstruction: this.bundle.capability.controllerConstruction,
        orchestration: this.bundle.capability.orchestration,
        repositoryConfiguration: {
          verified: ["published-workflows"],
          upstreamUnverified: ["skills"],
          unsupported: ["instructions", "hooks", "commands", "plugins", "mcp", "specialists"],
        },
      },
    };
  }
}

export function createFactoryAgentBundle(
  options: FactoryControllerProjectionOptions & { readonly profile?: ToolkitAgentsOptions["profile"] },
): FactoryAgentBundle {
  const contract = createToolkitRuntimeContract({
    profile: options.profile ?? loadModelProfile(),
  });
  return createFactoryControllerProjection(contract, createFactoryRuntimeBinding(), options);
}

export function createFactoryControllerProjection(
  contract: ToolkitRuntimeContract,
  binding: ToolkitRuntimeBinding,
  options: FactoryControllerProjectionOptions,
): FactoryControllerProjection {
  // The host owns the allowlist, the authorization boundary, and the resume
  // posture; the canonical tool package owns no Factory identity.
  const dynamicWorkflow = contract.tools.createDynamicWorkflow({
    agents: FACTORY_DYNAMIC_WORKFLOW_AGENT_IDS,
    authorize: authorizeFactoryDynamicWorkflow,
    scope: factoryDynamicWorkflowScope,
    // Still false, and not because of tenancy: the scope now proves a resume
    // comes from the session that authored the run. What remains is that a
    // dispatched run receives a fresh request context carrying no Factory
    // session, so its steps cannot resolve the project workspace they were
    // authorized against. For a `run` that is bounded — the graph executes
    // inside the authorizing turn, under its abort signal. A suspended run
    // outlives that turn, so resuming it would be the only path where a
    // Factory graph executes against a workspace no live authorization ever
    // validated. Flipping this needs durable request-context reconstruction,
    // not more scoping.
    resumable: false,
  });
  return {
    binding,
    agents: contract.roles.createAgents({
      ...options,
      dynamicWorkflow,
      profile: contract.runtime.profile,
    }),
    tools: { dynamic_workflow: dynamicWorkflow },
    runtime: { defaults: contract.runtime.defaults },
    capability: {
      projection: "factory",
      contractDigest: contract.capability.digest,
      controllerConstruction: {
        owner: "@mastra/factory",
        count: 1,
        canonicalModesAndSubagents: "upstream-blocked",
        missingConstructionInputs: ["modes", "subagents", "controller-construction callback"],
      },
      orchestration: {
        tool: "dynamic-workflow/v1",
        seam: "integration-agent-tools",
        stage: "execution-session",
        agents: FACTORY_DYNAMIC_WORKFLOW_AGENT_IDS,
        resumable: false,
        tenantIsolation: {
          scope: "project-user-session",
          enforced: [
            "authorize-requires-execution-session",
            "scoped-workflow-identity",
            "scoped-inspect",
            "resume-disabled",
          ],
          residual: ["dispatched-runs-carry-no-factory-session"],
          residualClosedBy: "durable-request-context-reconstruction",
        },
      },
    },
    [FACTORY_CONTROLLER_PROJECTION]: true,
  };
}

/**
 * Gates every `dynamic_workflow` action on the binding that only exists while
 * Factory is executing work inside a project — a persisted project session, an
 * authenticated user, and that session's sandbox-backed workspace. Intake,
 * planning, scheduling, control-plane routes, and workers hold none of those,
 * so the tool is unreachable outside the execution stage without reading
 * governed work-item status from a tool boundary.
 *
 * This is also the only isolation seam the tool currently offers: it runs
 * before any action dispatch, but it receives neither the parsed input nor a
 * post-run hook, so it cannot tell a `resume` or `inspect` naming another
 * project's rows from one naming this project's own.
 */
async function authorizeFactoryDynamicWorkflow(
  context: { readonly requestContext: RequestContext; readonly workspace?: unknown },
): Promise<void> {
  const requestContext = context.requestContext;
  if (!getFactorySessionAddress(requestContext)) {
    throw new Error("Dynamic workflows require a persisted Factory project session");
  }
  requireFactoryUserId(requestContext);
  await requireFactoryProjectSession({
    requestContext,
    ...(context.workspace
      ? { workspace: context.workspace as NonNullable<FactoryProjectSessionContext["workspace"]> }
      : {}),
  });
}

/**
 * The tenant key every dynamic workflow id, stored definition, and `inspect`
 * listing is scoped by.
 *
 * The same `project-user-session` triple the approval binding already declares,
 * so orchestration cannot be isolated more loosely than the approvals that
 * authorize it. Session-level rather than project-level because Factory sessions
 * are the durable unit that owns a checkout and a sandbox: two sessions of one
 * project hold different mutable state, and a graph authored against one has no
 * claim on the other.
 *
 * Derived independently of `authorize` rather than passed down from it, so a
 * host that ever drops the authorize hook still cannot produce an unscoped id.
 * The consuming package hashes this and never stores or echoes it.
 */
function factoryDynamicWorkflowScope(
  context: { readonly requestContext: RequestContext },
): string {
  const address = getFactorySessionAddress(context.requestContext);
  if (!address) {
    throw new Error("Dynamic workflows require a persisted Factory project session");
  }
  return [
    "factory",
    address.factoryProjectId,
    requireFactoryUserId(context.requestContext),
    address.sessionId,
  ].join(":");
}

export function createFactoryRuntimeBinding(): ToolkitRuntimeBinding {
  return {
    identity: {
      resolve: context => {
        const requestContext = asRecord(context)?.requestContext as RequestContext | undefined;
        const address = getFactorySessionAddress(requestContext);
        if (!address) throw new Error("Factory identity requires a persisted project session");
        return {
          projectId: address.factoryProjectId,
          userId: requireFactoryUserId(requestContext),
          sessionId: address.sessionId,
        };
      },
    },
    workspace: {
      resolve: context => {
        const workspace = asRecord(context)?.workspace;
        if (!workspace) throw new Error("Factory workspace requires a persisted project session");
        return workspace;
      },
    },
    sandbox: {
      resolve: async context => {
        const record = asRecord(context);
        const workspace = record?.workspace as FactoryProjectSessionContext["workspace"];
        const requestContext = record?.requestContext as RequestContext | undefined;
        if (!workspace || !requestContext) {
          throw new Error("Factory sandbox requires a persisted project session");
        }
        await requireFactoryProjectSession({ requestContext, workspace });
        return workspace.resolveSandbox({ requestContext });
      },
    },
    approval: { context: { host: "factory", scope: "project-user-session" } },
  };
}

function requireFactoryUserId(requestContext: RequestContext | undefined): string {
  const userId = getFactoryAuthUserId(requestContext?.get("user") as FactoryAuthUser | undefined);
  if (!userId) {
    throw new Error("Factory identity requires an authenticated user");
  }
  return userId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function requireFactoryProjectSession(
  context: FactoryProjectSessionContext,
): Promise<void> {
  const workspace = context.workspace;
  if (!getFactorySessionAddress(context.requestContext) || !workspace?.id.startsWith("mfw-")) {
    throw new Error("Factory execution requires a persisted Factory project session");
  }
  const [filesystem, sandbox] = await Promise.all([
    workspace.resolveFilesystem(context.requestContext ? { requestContext: context.requestContext } : {}),
    workspace.resolveSandbox(context.requestContext ? { requestContext: context.requestContext } : {}),
  ]);
  if (filesystem?.provider !== "sandbox" || !filesystem.basePath || !sandbox?.executeCommand) {
    throw new Error("Factory execution requires a persisted Factory project session sandbox");
  }
}

interface FactoryProjectSessionContext {
  readonly requestContext?: RequestContext;
  readonly workspace?: {
    readonly id: string;
    resolveFilesystem(input: { requestContext?: RequestContext }): Promise<{
      readonly provider?: string;
      readonly basePath?: string;
    } | undefined>;
    resolveSandbox(input: { requestContext?: RequestContext }): Promise<{
      executeCommand?: (...args: any[]) => Promise<unknown>;
    } | undefined>;
  };
}
