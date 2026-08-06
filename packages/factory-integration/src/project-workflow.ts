import { randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import {
  SANDBOX_PROJECT_WORKFLOW_RESULT_PREFIX,
  SANDBOX_PROJECT_WORKFLOW_RUNNER,
  SANDBOX_PROJECT_WORKFLOW_STREAM_PREFIX,
} from "@rlabs/project-mounting-manager";
import { z } from "zod";

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
