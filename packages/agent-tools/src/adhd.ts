import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { Agent } from "@mastra/core/agent";
import { z } from "zod";

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
