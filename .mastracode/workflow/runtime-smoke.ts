import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const inputSchema = z.object({ message: z.string().min(1) });
const outputSchema = z.object({
  message: z.string(),
  runtime: z.literal("local"),
});

const confirmLocalRuntime = createStep({
  id: "confirm-local-runtime",
  inputSchema,
  outputSchema,
  execute: async ({ inputData }) => ({ ...inputData, runtime: "local" as const }),
});

export default createWorkflow({
  id: "runtime_smoke",
  inputSchema,
  outputSchema,
}).then(confirmLocalRuntime).commit();

export const agentTool = {
  description: "Run the approved local-runtime smoke workflow and return its in-process result.",
};
