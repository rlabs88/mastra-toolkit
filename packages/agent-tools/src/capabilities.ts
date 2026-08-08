import { RequestContext } from "@mastra/core/request-context";

import { type ToolHooks } from "@mastra/core/tools";

import { StagehandBrowser } from "@mastra/stagehand";



export interface ToolAuditEvent {
  readonly phase: "start" | "complete" | "failed";
  readonly toolName: string;
  readonly timestamp: string;
  readonly error?: string;
}

interface RunBudgetState {
  readonly startedAt: number;
  calls: number;
  delegations: number;
  retainedChars: number;
  readonly inFlight: Set<string>;
  readonly completed: Set<string>;
  readonly uncertainWrites: Set<string>;
}

export const RUN_BUDGET_CONTEXT_KEY = "mastraToolkitRunBudget";
export const RUN_CONTAINMENT_POLICY = Object.freeze({
  maxToolCalls: 64,
  maxDelegations: 8,
  maxRetainedOutputChars: 256_000,
  maxWallClockMs: 20 * 60_000,
  duplicateScopes: "reject",
  uncertainRemoteWrites: "reconcile-before-retry",
} as const);
const RUN_MAX_TOOL_CALLS = RUN_CONTAINMENT_POLICY.maxToolCalls;
const RUN_MAX_DELEGATIONS = RUN_CONTAINMENT_POLICY.maxDelegations;
const RUN_MAX_RETAINED_CHARS = RUN_CONTAINMENT_POLICY.maxRetainedOutputChars;
const RUN_MAX_WALL_CLOCK_MS = RUN_CONTAINMENT_POLICY.maxWallClockMs;

export function createRunBudgetHooks(now: () => number = Date.now): ToolHooks {
  return {
    beforeToolCall: context => {
      const requestContext = toolRequestContext(context.context);
      if (!requestContext) return;
      const state = requestContext.get(RUN_BUDGET_CONTEXT_KEY) as RunBudgetState | undefined
        ?? createRunBudgetState(requestContext, now());
      if (now() - state.startedAt > RUN_MAX_WALL_CLOCK_MS) {
        throw new Error("Run budget exhausted: wall-clock limit reached");
      }
      state.calls += 1;
      if (state.calls > RUN_MAX_TOOL_CALLS) {
        throw new Error("Run budget exhausted: aggregate tool-call limit reached");
      }
      if (isDelegationTool(context.toolName)) {
        state.delegations += 1;
        if (state.delegations > RUN_MAX_DELEGATIONS) {
          throw new Error("Run budget exhausted: aggregate delegation limit reached");
        }
      }
      if (!isDeduplicatedTool(context.toolName)) return;
      const signature = toolSignature(context.toolName, context.input);
      if (state.inFlight.has(signature)) {
        throw new Error(`Duplicate in-flight scope rejected: ${context.toolName}`);
      }
      if (state.completed.has(signature)) {
        throw new Error(`No progress detected for repeated scope: ${context.toolName}`);
      }
      if (state.uncertainWrites.has(signature)) {
        throw new Error(`Remote write outcome is uncertain; reconcile before retrying: ${context.toolName}`);
      }
      state.inFlight.add(signature);
    },
    afterToolCall: context => {
      const requestContext = toolRequestContext(context.context);
      const state = requestContext?.get(RUN_BUDGET_CONTEXT_KEY) as RunBudgetState | undefined;
      if (!state) return;
      state.retainedChars += serializedLength(context.output);
      if (state.retainedChars > RUN_MAX_RETAINED_CHARS) {
        throw new Error("Run budget exhausted: aggregate retained tool output limit reached");
      }
      if (!isDeduplicatedTool(context.toolName)) return;
      const signature = toolSignature(context.toolName, context.input);
      state.inFlight.delete(signature);
      if (!context.error) {
        state.completed.add(signature);
      } else if (isExternalWriteTool(context.toolName)) {
        state.uncertainWrites.add(signature);
      }
    },
  };
}

function createRunBudgetState(requestContext: RequestContext, startedAt: number): RunBudgetState {
  const state = {
    startedAt,
    calls: 0,
    delegations: 0,
    retainedChars: 0,
    inFlight: new Set<string>(),
    completed: new Set<string>(),
    uncertainWrites: new Set<string>(),
  };
  requestContext.set(RUN_BUDGET_CONTEXT_KEY, state);
  return state;
}

function toolRequestContext(value: unknown): RequestContext | undefined {
  if (!value || typeof value !== "object" || !("requestContext" in value)) return undefined;
  const requestContext = value.requestContext;
  return requestContext instanceof RequestContext ? requestContext : undefined;
}

function isDeduplicatedTool(toolName: string): boolean {
  return isDelegationTool(toolName)
    || isExternalWriteTool(toolName);
}

/**
 * Tools whose cost is exactly one delegation per call.
 *
 * `dynamic_workflow` is deliberately absent. Its cost is the number of agents
 * its graph dispatches, which is one for a single agent entry and up to the
 * fan-out ceiling for a `foreach`, and that number is known only after the
 * graph has been validated and clamped inside the tool. It charges itself
 * through `chargeRunDelegations` instead of being counted once here.
 */
function isDelegationTool(toolName: string): boolean {
  return toolName === "subagent" || /^agent-[a-z0-9][a-z0-9_-]*$/i.test(toolName);
}

/**
 * Charges delegations against the live run budget from outside the tool hook.
 *
 * `beforeToolCall` sees a tool's name and its authored input, so it can only
 * charge a fixed cost per call. A tool that dispatches a variable number of
 * agents knows its real cost only once it has validated its own request, and
 * the agents it dispatches never pass back through the hook — a workflow's
 * agent steps invoke the agent directly rather than through a tool. Such a
 * tool is the only thing that can report its own cost, so it charges here.
 *
 * No-ops when the host installed no run budget, matching the hook: an
 * unmetered host stays unmetered rather than gaining state from a charge.
 */
export function chargeRunDelegations(requestContext: RequestContext, count: number): void {
  if (count <= 0) return;
  const state = requestContext.get(RUN_BUDGET_CONTEXT_KEY) as RunBudgetState | undefined;
  if (!state) return;
  state.delegations += count;
  if (state.delegations > RUN_MAX_DELEGATIONS) {
    throw new Error("Run budget exhausted: aggregate delegation limit reached");
  }
}

function isExternalWriteTool(toolName: string): boolean {
  return /(create|write|update|comment).*(issue|pull|project)|(issue|pull|project).*(create|write|update|comment)/i.test(toolName);
}

function toolSignature(toolName: string, input: unknown): string {
  return `${toolName}:${stableJson(input)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function serializedLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

export function createToolAuditHooks(write: (event: ToolAuditEvent) => void = defaultWriter): ToolHooks {
  return {
    beforeToolCall: ({ toolName }) => write({ phase: "start", toolName, timestamp: new Date().toISOString() }),
    afterToolCall: ({ toolName, error }) => write({
      phase: error ? "failed" : "complete",
      toolName,
      timestamp: new Date().toISOString(),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    }),
  };
}

function defaultWriter(event: ToolAuditEvent): void {
  process.stderr.write(`${JSON.stringify({ type: "mastra-toolkit.tool-audit", ...event })}\n`);
}

export function createVisibleBrowser(options: { readonly executablePath?: string; readonly userDataDir?: string } = {}): StagehandBrowser {
  return new StagehandBrowser({
    env: "LOCAL",
    headless: false,
    scope: "thread",
    viewport: { width: 1440, height: 960 },
    timeout: 30_000,
    selfHeal: true,
    preserveUserDataDir: Boolean(options.userDataDir),
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.userDataDir ? { profile: options.userDataDir } : {}),
  });
}

export function browserActionRequiresApproval(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "stagehand_tabs") return args.action !== "list";
  return ["stagehand_act", "stagehand_navigate", "stagehand_close"].includes(toolName);
}
