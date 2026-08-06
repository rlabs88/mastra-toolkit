import { RequestContext } from "@mastra/core/request-context";

import { createTool, type ToolHooks } from "@mastra/core/tools";

import { type Agent } from "@mastra/core/agent";

import { z } from "zod";

import { StagehandBrowser } from "@mastra/stagehand";



const inputSchema = z.object({
  problem: z.string().min(1).max(12_000),
  perspectives: z.array(z.string().min(1).max(500)).min(2).max(6),
});

export function createAdhdTool(resolveFlux: () => Agent) {
  return createTool({
    id: "adhd_run",
    description: "Explore one open problem from 2–6 isolated perspectives, then return the candidate evidence for Flux to synthesize.",
    inputSchema,
    background: { enabled: true, timeoutMs: 180_000 },
    mcp: { annotations: { title: "Flux ADHD", readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    execute: async (input, context) => {
      if (context.requestContext.get("adhdDepth") === 1) throw new Error("Nested adhd_run calls are not allowed");
      const flux = resolveFlux();
      const candidates = await Promise.all(input.perspectives.map(async perspective => {
        const requestContext = new RequestContext(context.requestContext.entries());
        requestContext.set("adhdDepth", 1);
        const result = await flux.generate(
          `Independently investigate this framing. Do not call adhd_run.\n\nProblem: ${input.problem}\n\nPerspective: ${perspective}`,
          { maxSteps: 8, modelSettings: { temperature: 0.9 }, requestContext },
        );
        return { perspective, text: result.text };
      }));
      return { problem: input.problem, candidates };
    },
  });
}

export interface ToolAuditEvent {
  readonly phase: "start" | "complete" | "failed";
  readonly toolName: string;
  readonly timestamp: string;
  readonly error?: string;
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
