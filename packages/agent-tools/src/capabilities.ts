import { RequestContext } from "@mastra/core/request-context";

import { createTool, type ToolHooks } from "@mastra/core/tools";

import { type Agent } from "@mastra/core/agent";

import { z } from "zod";

import { StagehandBrowser } from "@mastra/stagehand";



const inputSchema = z.object({
  problem: z.string().min(1).max(12_000),
  perspectives: z.array(z.string().min(1).max(500)).min(2).max(6),
}).superRefine((input, context) => {
  const normalized = input.perspectives.map(perspective => perspective.trim().toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: "custom", path: ["perspectives"], message: "Perspectives must be distinct" });
  }
});

const ADHD_MAX_CONCURRENCY = 2;
const ADHD_MAX_WALL_CLOCK_MS = 60_000;
const ADHD_MAX_CANDIDATE_CHARS = 8_000;
const ADHD_MAX_RETAINED_CHARS = 24_000;

export function createAdhdTool(resolveFlux: () => Agent) {
  return createTool({
    id: "adhd_run",
    description: "Explore one open problem from 2–6 isolated perspectives, then return the candidate evidence for Flux to synthesize.",
    inputSchema,
    background: { enabled: true, timeoutMs: 180_000 },
    mcp: { annotations: { title: "Flux ADHD", readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    execute: async (input, context) => {
      if (context.requestContext.get("adhdDepth") === 1) throw new Error("Nested adhd_run calls are not allowed");
      const normalized = input.perspectives.map(perspective => perspective.trim().toLocaleLowerCase());
      if (new Set(normalized).size !== normalized.length) throw new Error("Perspectives must be distinct");
      const flux = resolveFlux();
      const budgetSignal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(ADHD_MAX_WALL_CLOCK_MS)])
        : AbortSignal.timeout(ADHD_MAX_WALL_CLOCK_MS);
      const candidates = new Array<{ perspective: string; text: string }>(input.perspectives.length);
      let nextIndex = 0;
      let retainedChars = 0;
      const runCandidate = async () => {
        while (nextIndex < input.perspectives.length) {
          const index = nextIndex++;
          const perspective = input.perspectives[index]!;
          if (budgetSignal.aborted) throw budgetSignal.reason;
          const requestContext = new RequestContext(context.requestContext.entries());
          requestContext.set("adhdDepth", 1);
          const result = await flux.generate(
            `Independently investigate this framing. Do not call adhd_run.\n\nProblem: ${input.problem}\n\nPerspective: ${perspective}`,
            { maxSteps: 8, modelSettings: { temperature: 0.9 }, requestContext, abortSignal: budgetSignal },
          );
          const remaining = Math.max(0, ADHD_MAX_RETAINED_CHARS - retainedChars);
          const text = compactCandidate(result.text, Math.min(ADHD_MAX_CANDIDATE_CHARS, remaining));
          retainedChars += text.length;
          candidates[index] = { perspective, text };
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(ADHD_MAX_CONCURRENCY, input.perspectives.length) },
        runCandidate,
      ));
      return { problem: input.problem, candidates };
    },
  });
}

function compactCandidate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…".slice(0, maximum);
  return `${value.slice(0, maximum - 1)}…`;
}

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

const RUN_BUDGET_CONTEXT_KEY = "mastraToolkitRunBudget";
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
      if (context.toolName === "subagent") {
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
  return toolName === "subagent"
    || toolName === "adhd_run"
    || isExternalWriteTool(toolName);
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
