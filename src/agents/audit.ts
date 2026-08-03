import type { ToolHooks } from "@mastra/core/tools";

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
