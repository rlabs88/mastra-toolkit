import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ProjectGenerationState } from "./generation.js";

const specialistInputSchema = z.object({
  specialist: z.string().min(1),
  task: z.string().min(1),
});

const specialistOutputSchema = z.object({
  specialist: z.string(),
  generation: z.number().int().nonnegative(),
  text: z.string(),
});

export function createProjectSpecialistTool(
  getGeneration: () => ProjectGenerationState,
): ReturnType<typeof createTool> {
  return createTool({
    id: "project_specialist",
    description: "Delegate a bounded task to a mounted project specialist.",
    inputSchema: specialistInputSchema,
    outputSchema: specialistOutputSchema,
    execute: async (input, context) => {
      const generation = getGeneration();
      const specialist = generation.specialists.get(input.specialist);
      if (!specialist) throw new Error(`Unknown project specialist: ${input.specialist}`);
      if (specialist.disableModelInvocation) {
        throw new Error(`Project specialist is disabled for model invocation: ${input.specialist}`);
      }
      const agent = generation.specialistAgents.get(input.specialist);
      if (!agent) throw new Error(`Project specialist is unavailable: ${input.specialist}`);
      const result = await agent.generate(input.task, { requestContext: context.requestContext });
      return { specialist: specialist.id, generation: generation.id, text: result.text };
    },
  });
}
