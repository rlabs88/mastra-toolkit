import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { commandRequiresApproval, executeAdapter, executionClass } from "./adapters.js";
import { parseCommands } from "./parser.js";
import { runCommandSchedule } from "./scheduler.js";
import { COMMAND_TYPES, type CommandInput, type CommandRunTrace } from "./types.js";

const MAX_RESULT_CHARS = 20_000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 20 * 1_048_576;

const inputSchema = z.object({
  description: z.string().min(1).max(4_000).regex(/^[^\r\n]+$/),
  commands: z.array(z.object({
    command_type: z.enum(COMMAND_TYPES),
    command_line: z.string().min(1),
    step: z.number().int().positive(),
    timeout_ms: z.number().int().min(100).max(300_000).optional(),
  }).strict()).min(1).max(20),
});

export function createCommandRunTool(options: { readonly workspaceRoot: string }) {
  return createTool({
    id: "command_run",
    description: "Run 1–20 permission-gated repository commands grouped by positive-integer dependency steps. Independent reads in one step run concurrently; mutations are serial.",
    inputSchema,
    requireApproval: input => parseCommands(input.commands).some(commandRequiresApproval),
    background: { enabled: true },
    mcp: { annotations: { title: "Command Run", readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    execute: async (input, context) => {
      const root = context.requestContext.get<string, string>("workspaceRoot") || options.workspaceRoot;
      const commands = parseCommands(input.commands as CommandInput[]);
      let latestTrace: CommandRunTrace | undefined;
      const results = await runCommandSchedule(commands, {
        signal: context.abortSignal ?? new AbortController().signal,
        ask: async () => undefined,
        execute: (command, signal, update) => executeAdapter(command, root, signal, {}, update),
        executionClass,
        onTrace: trace => { latestTrace = trace; },
        maxOutputChars: MAX_RESULT_CHARS,
        maxAttachments: MAX_ATTACHMENTS,
        maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      });
      return {
        version: 1 as const,
        description: input.description,
        commandRun: latestTrace,
        results,
        attachments: results.flatMap(result => result.attachments ?? []).map(({ byteLength: _, ...attachment }) => attachment),
      };
    },
  });
}
