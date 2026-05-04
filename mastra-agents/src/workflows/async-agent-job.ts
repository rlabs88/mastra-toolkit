import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { PostgresStore } from "@mastra/pg";
import { z } from "zod";

import {
  createMastraAgentHarness,
  formatMastraAgentHarnessModePrompt,
  REQUEST_CONTEXT_ACTIVE_AGENT_ID_KEY,
  REQUEST_CONTEXT_HARDNESS_MODE_KEY,
  REQUEST_CONTEXT_HARNESS_MODE_ID_KEY,
  REQUEST_CONTEXT_HARNESS_MODE_KEY,
  REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY,
  resolveMastraAgentHarnessMode,
  type ResolvedMastraAgentHarnessMode,
} from "../agents/harness.js";
import { captureTurnSnapshot, initializeSessionSnapshot, type SnapshotCapture } from "../tools/snapshots.js";
import { resolveWorkspacePath } from "../workspace.js";
import { setSessionId } from "../session.js";

const inputArgsSchema = z.record(z.string()).optional();
const modePromptTrackerStore = new PostgresStore({
  id: "mastra-agent-mode-prompt-tracker",
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://mastra:mastra@mastra-postgres:5432/mastra",
});
let modePromptTrackerStoreInit: Promise<void> | undefined;
const inMemoryModePromptTracker = new Map<string, string>();

const asyncAgentJobInputSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  clientSessionId: z.string().optional(),
  runId: z.string().optional(),
  agentRunId: z.string().optional(),
  agentId: z.string(),
  harnessMode: z.string().optional(),
  harnessModeId: z.string().optional(),
  hardnessMode: z.string().optional(),
  message: z.string(),
  threadId: z.string(),
  resourceId: z.string(),
  requestContext: z.record(z.unknown()).optional(),
  includeToolResults: z.boolean().optional(),
  includeReasoning: z.boolean().optional(),
  input_args: inputArgsSchema,
  timeoutMs: z.number().optional(),
});

const asyncAgentJobOutputSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  clientSessionId: z.string().optional(),
  runId: z.string().optional(),
  agentRunId: z.string().optional(),
  agentId: z.string(),
  harnessMode: z.string().optional(),
  harnessModeId: z.string().optional(),
  hardnessMode: z.string().optional(),
  threadId: z.string(),
  resourceId: z.string(),
  status: z.enum(["done", "error"]),
  text: z.string(),
  artifactPath: z.string(),
  eventsPath: z.string(),
  errors: z.array(z.string()),
  snapshotRepoPath: z.string().optional(),
  sessionSnapshotPath: z.string().optional(),
  turnSnapshotPath: z.string().optional(),
  sessionDiffPath: z.string().optional(),
  turnDiffPath: z.string().optional(),
  latestRef: z.string().optional(),
  sessionRef: z.string().optional(),
  turnRef: z.string().optional(),
  turnNumber: z.number().int().optional(),
  snapshotReminder: z.string().optional(),
  snapshot: z.object({
    type: z.literal("git_snapshot"),
    agentId: z.string(),
    sessionId: z.string(),
    runId: z.string(),
    snapshotRepoPath: z.string(),
    baselineRef: z.string(),
    latestRef: z.string(),
    turnRef: z.string(),
    turnNumber: z.number().int(),
    commands: z.object({
      listTurns: z.string(),
      turnDiff: z.string(),
      sessionDiff: z.string(),
    }),
  }).optional(),
});

export const runAsyncAgentJobStep = createStep({
  id: "run-async-agent-job",
  inputSchema: asyncAgentJobInputSchema,
  outputSchema: asyncAgentJobOutputSchema,
  execute: async ({ inputData, mastra, writer, abortSignal }) => {
    const artifactDir = resolveWorkspacePath(
      process.env.MASTRA_ASYNC_AGENT_JOB_DIR ??
        path.join(
          "apps/mastra-control/.mastra/async-agent-jobs",
          safePathPart(inputData.clientSessionId ?? "local-session"),
          safePathPart(inputData.jobId),
        ),
    );
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, "output.txt");
    const eventsPath = path.join(artifactDir, "events.jsonl");
    const errors: string[] = [];
    let text = "";
    let snapshotCapture: SnapshotCapture | undefined;
    const snapshotOwner = {
      agentId: inputData.agentId,
      sessionId: inputData.clientSessionId ?? inputData.resourceId,
      runId: inputData.runId ?? inputData.jobId,
      childId: inputData.jobId,
    };
    let resolvedHarnessMode = inputData.harnessMode;
    let resolvedHarnessModeId = inputData.harnessModeId ?? inputData.harnessMode ?? inputData.hardnessMode;

    try {
      const harness = resolveHarness(mastra);
      const resolvedMode = resolveMastraAgentHarnessMode({
        agentId: inputData.agentId,
        harnessMode: inputData.harnessMode ?? inputData.harnessModeId,
        hardnessMode: inputData.hardnessMode,
      });
      resolvedHarnessMode = resolvedMode.harnessMode;
      resolvedHarnessModeId = resolvedMode.harnessModeId;
      setSessionId(`${snapshotOwner.sessionId ?? "local-session"}-${snapshotOwner.runId ?? snapshotOwner.childId ?? "local-run"}`);
      const initialSnapshot = await initializeSessionSnapshot(snapshotOwner);
      const requestContext = {
        ...(inputData.requestContext ?? {}),
        [REQUEST_CONTEXT_ACTIVE_AGENT_ID_KEY]: resolvedMode.activeAgentId,
        [REQUEST_CONTEXT_HARNESS_MODE_KEY]: resolvedMode.harnessMode,
        [REQUEST_CONTEXT_HARNESS_MODE_ID_KEY]: resolvedMode.harnessModeId,
        [REQUEST_CONTEXT_HARDNESS_MODE_KEY]: resolvedMode.harnessModeId,
        ...(inputData.input_args && Object.keys(inputData.input_args).length > 0 ? { input_args: inputData.input_args } : {}),
        snapshotRepoPath: initialSnapshot.snapshotRepoPath,
        snapshot: initialSnapshot.snapshot,
        sessionSnapshotPath: initialSnapshot.sessionSnapshotPath,
        latestRef: initialSnapshot.latestRef,
        sessionRef: initialSnapshot.sessionRef,
        baselineRef: initialSnapshot.baselineRef,
      };
      text = await streamHarnessMessage({
        harness,
        writer,
        artifactPath,
        eventsPath,
        message: formatPrompt(inputData.message, inputData.input_args),
        threadId: inputData.threadId,
        resourceId: inputData.resourceId,
        resolvedMode,
        requestContext,
        abortSignal,
      });
      snapshotCapture = await captureTurnSnapshot(snapshotOwner);
      await emitSnapshotReminder({ writer, eventsPath, artifactPath, capture: snapshotCapture });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (!snapshotCapture) {
        snapshotCapture = await captureTurnSnapshot(snapshotOwner).catch(() => undefined);
        if (snapshotCapture) await emitSnapshotReminder({ writer, eventsPath, artifactPath, capture: snapshotCapture });
      }
      const chunk = { type: "error", payload: { message }, message };
      await writer.write(chunk);
      await appendJsonLine(eventsPath, { timestamp: Date.now(), chunk });
      await appendFile(artifactPath, `\n[agent job error: ${message}]\n`, "utf8");
      return {
        jobId: inputData.jobId,
        jobName: inputData.jobName,
        clientSessionId: inputData.clientSessionId,
        runId: inputData.runId,
        agentRunId: inputData.agentRunId,
        agentId: inputData.agentId,
        harnessMode: resolvedHarnessMode,
        harnessModeId: resolvedHarnessModeId,
        hardnessMode: resolvedHarnessModeId,
        threadId: inputData.threadId,
        resourceId: inputData.resourceId,
        status: "error" as const,
        text,
        artifactPath,
        eventsPath,
        errors,
        ...snapshotOutput(snapshotCapture),
      };
    }

    return {
      jobId: inputData.jobId,
      jobName: inputData.jobName,
      clientSessionId: inputData.clientSessionId,
      runId: inputData.runId,
      agentRunId: inputData.agentRunId,
      agentId: inputData.agentId,
      harnessMode: resolvedHarnessMode,
      harnessModeId: resolvedHarnessModeId,
      hardnessMode: resolvedHarnessModeId,
      threadId: inputData.threadId,
      resourceId: inputData.resourceId,
      status: "done" as const,
      text,
      artifactPath,
      eventsPath,
      errors,
      ...snapshotOutput(snapshotCapture),
    };
  },
});

const asyncAgentJobWorkflow = createWorkflow({
  id: "async.agent-job",
  description: "Durable async background Mastra agent job runner.",
  inputSchema: asyncAgentJobInputSchema,
  outputSchema: asyncAgentJobOutputSchema,
})
  .then(runAsyncAgentJobStep)
  .commit();

export const asyncAgentJobWorkflows = {
  asyncAgentJob: asyncAgentJobWorkflow,
};

async function emitSnapshotReminder({
  writer,
  eventsPath,
  artifactPath,
  capture,
}: {
  writer: { write(chunk: unknown): Promise<void> };
  eventsPath: string;
  artifactPath: string;
  capture: SnapshotCapture;
}): Promise<void> {
  const chunk = {
    type: "snapshot-audit-context",
    payload: snapshotOutput(capture),
    text: capture.reminder,
  };
  await writer.write(chunk);
  await appendJsonLine(eventsPath, { timestamp: Date.now(), chunk });
  await appendFile(artifactPath, `\n\n${capture.reminder}\n`, "utf8");
}

function snapshotOutput(capture: SnapshotCapture | undefined) {
  if (!capture) return {};
  return {
    snapshot: capture.snapshot,
    snapshotRepoPath: capture.snapshotRepoPath,
    sessionSnapshotPath: capture.sessionSnapshotPath,
    turnSnapshotPath: capture.turnSnapshotPath,
    sessionDiffPath: capture.sessionDiffPath,
    turnDiffPath: capture.turnDiffPath,
    latestRef: capture.latestRef,
    sessionRef: capture.sessionRef,
    turnRef: capture.turnRef,
    turnNumber: capture.turnNumber,
    snapshotReminder: capture.reminder,
  };
}

function formatPrompt(message: string, inputArgs: Record<string, string> | undefined): string {
  if (!inputArgs || Object.keys(inputArgs).length === 0) return message;
  const keys = Object.keys(inputArgs).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  const lines = keys.map((key) => `- ${key}: ${inputArgs[key]}`);
  return `${message}\n\nInput arguments:\n${lines.join("\n")}\n\nWhen the prompt references placeholders like $1, $2, etc., use the corresponding input argument above.`;
}

function resolveHarness(mastra: any): ReturnType<typeof createMastraAgentHarness> {
  if (typeof mastra?.getHarness === "function") {
    return mastra.getHarness();
  }
  if (mastra?.mastraAgentHarness) {
    return mastra.mastraAgentHarness;
  }
  return createMastraAgentHarness();
}

async function shouldSubmitHarnessModePrompt({
  harness,
  threadId,
  resourceId,
  harnessModeId,
}: {
  harness: ReturnType<typeof createMastraAgentHarness>;
  threadId: string;
  resourceId: string;
  harnessModeId: string;
}): Promise<boolean> {
  const lastSubmitted = await readLastSubmittedHarnessModeId({ harness, threadId, resourceId });
  return lastSubmitted !== harnessModeId;
}

async function recordSubmittedHarnessModePrompt({
  harness,
  threadId,
  resourceId,
  harnessModeId,
}: {
  harness: ReturnType<typeof createMastraAgentHarness>;
  threadId: string;
  resourceId: string;
  harnessModeId: string;
}): Promise<void> {
  inMemoryModePromptTracker.set(threadKey(threadId, resourceId), harnessModeId);
  await harness.setState({ lastSubmittedHarnessModeId: harnessModeId as any }).catch(() => undefined);
  await harness.setThreadSetting({ key: REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY, value: harnessModeId }).catch(() => undefined);
  await writeLastSubmittedHarnessModeId({ threadId, resourceId, harnessModeId });
}

async function readLastSubmittedHarnessModeId({
  harness,
  threadId,
  resourceId,
}: {
  harness: ReturnType<typeof createMastraAgentHarness>;
  threadId: string;
  resourceId: string;
}): Promise<string | undefined> {
  const threadMetadataValue = await readHarnessThreadMetadataValue({ harness, threadId });
  return threadMetadataValue ?? (await readStoredThreadMetadataValue({ threadId, resourceId })) ?? inMemoryModePromptTracker.get(threadKey(threadId, resourceId));
}

async function readHarnessThreadMetadataValue({
  harness,
  threadId,
}: {
  harness: ReturnType<typeof createMastraAgentHarness>;
  threadId: string;
}): Promise<string | undefined> {
  try {
    const threads = await harness.listThreads();
    const thread = threads.find((candidate) => candidate.id === threadId);
    return stringField(thread?.metadata, REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY);
  } catch {
    return undefined;
  }
}

async function readStoredThreadMetadataValue({
  threadId,
  resourceId,
}: {
  threadId: string;
  resourceId: string;
}): Promise<string | undefined> {
  try {
    const memoryStore = await modePromptMemoryStore();
    const thread = await memoryStore.getThreadById({ threadId });
    if (!thread) return undefined;
    if (thread.resourceId && thread.resourceId !== resourceId) return undefined;
    return stringField(thread.metadata, REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY);
  } catch {
    return undefined;
  }
}

async function writeLastSubmittedHarnessModeId({
  threadId,
  resourceId,
  harnessModeId,
}: {
  threadId: string;
  resourceId: string;
  harnessModeId: string;
}): Promise<void> {
  inMemoryModePromptTracker.set(threadKey(threadId, resourceId), harnessModeId);
  try {
    const memoryStore = await modePromptMemoryStore();
    const existingThread = await memoryStore.getThreadById({ threadId });
    const now = new Date();
    await memoryStore.saveThread({
      thread: {
        id: threadId,
        resourceId: existingThread?.resourceId ?? resourceId,
        title: existingThread?.title ?? "",
        createdAt: existingThread?.createdAt ?? now,
        updatedAt: now,
        metadata: {
          ...(existingThread?.metadata ?? {}),
          [REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY]: harnessModeId,
        },
      },
    });
  } catch {
    // The in-memory tracker still prevents duplicate mode prompts within this process.
  }
}

async function modePromptMemoryStore() {
  modePromptTrackerStoreInit ??= modePromptTrackerStore.init().catch((error) => {
    modePromptTrackerStoreInit = undefined;
    throw error;
  });
  await modePromptTrackerStoreInit;
  const memoryStore = await modePromptTrackerStore.getStore("memory");
  if (!memoryStore) {
    throw new Error("Mode prompt tracker storage does not expose a memory store.");
  }
  return memoryStore;
}

function threadKey(threadId: string, resourceId: string): string {
  return `${resourceId}:${threadId}`;
}

async function streamHarnessMessage({
  harness,
  writer,
  artifactPath,
  eventsPath,
  message,
  threadId,
  resourceId,
  resolvedMode,
  requestContext,
  abortSignal,
}: {
  harness: ReturnType<typeof createMastraAgentHarness>;
  writer: { write(chunk: unknown): Promise<void> };
  artifactPath: string;
  eventsPath: string;
  message: string;
  threadId: string;
  resourceId: string;
  resolvedMode: ResolvedMastraAgentHarnessMode;
  requestContext: Record<string, unknown>;
  abortSignal?: AbortSignal;
}): Promise<string> {
  let text = "";
  let lastMessageText = "";
  let lastReasoningText = "";
  let writeQueue = Promise.resolve();

  const emitChunk = (chunk: unknown) => {
    writeQueue = writeQueue.then(async () => {
      await writer.write(chunk);
      await appendJsonLine(eventsPath, { timestamp: Date.now(), chunk });
      const delta = textDelta(chunk);
      if (delta) {
        text += delta;
        await appendFile(artifactPath, delta, "utf8");
      }
    });
  };

  const unsubscribe = harness.subscribe((event: any) => {
    if (event.type === "message_update" || event.type === "message_end") {
      const nextText = harnessTextContent(event.message, "text");
      const textDeltaValue = incrementalDelta(lastMessageText, nextText);
      lastMessageText = nextText;
      if (textDeltaValue) emitChunk({ type: "text-delta", text: textDeltaValue });

      const nextReasoning = harnessTextContent(event.message, "thinking");
      const reasoningDelta = incrementalDelta(lastReasoningText, nextReasoning);
      lastReasoningText = nextReasoning;
      if (reasoningDelta) emitChunk({ type: "reasoning-delta", text: reasoningDelta });
      return;
    }

    if (event.type === "tool_input_start") {
      emitChunk({
        type: "tool-call-input-streaming-start",
        payload: { toolCallId: event.toolCallId, toolName: event.toolName },
      });
      return;
    }

    if (event.type === "tool_input_delta") {
      emitChunk({
        type: "tool-call-delta",
        payload: { toolCallId: event.toolCallId, toolName: event.toolName, argsTextDelta: event.argsTextDelta },
      });
      return;
    }

    if (event.type === "tool_input_end") {
      emitChunk({
        type: "tool-call-input-streaming-end",
        payload: { toolCallId: event.toolCallId },
      });
      return;
    }

    if (event.type === "tool_start") {
      emitChunk({
        type: "tool-call",
        payload: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
      });
      return;
    }

    if (event.type === "tool_end") {
      emitChunk({
        type: event.isError ? "tool-error" : "tool-result",
        payload: { toolCallId: event.toolCallId, result: event.result, error: event.isError ? event.result : undefined },
      });
      return;
    }

    if (event.type === "error") {
      emitChunk({
        type: "error",
        message: event.error instanceof Error ? event.error.message : String(event.error ?? "Harness error"),
      });
    }
  });

  const onAbort = () => harness.abort();
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    await harness.init();
    harness.setResourceId({ resourceId });
    await harness.switchThread({ threadId });
    if (harness.getCurrentModeId() !== resolvedMode.harnessModeId) {
      await harness.switchMode({ modeId: resolvedMode.harnessModeId });
    }
    await harness.setState({
      activeAgentId: resolvedMode.activeAgentId,
      harnessMode: resolvedMode.harnessMode,
      harnessModeId: resolvedMode.harnessModeId,
      hardnessMode: resolvedMode.harnessModeId,
    });
    const shouldSubmitModePrompt = await shouldSubmitHarnessModePrompt({
      harness,
      threadId,
      resourceId,
      harnessModeId: resolvedMode.harnessModeId,
    });
    const mastraRequestContext = requestContextFromRecord(requestContext, threadId, resourceId);
    const content = shouldSubmitModePrompt
      ? `${formatMastraAgentHarnessModePrompt(resolvedMode)}\n\n${message}`
      : message;
    await harness.sendMessage({
      content,
      requestContext: mastraRequestContext,
    });
    if (shouldSubmitModePrompt) {
      await recordSubmittedHarnessModePrompt({
        harness,
        threadId,
        resourceId,
        harnessModeId: resolvedMode.harnessModeId,
      });
    }
    emitChunk({
      type: "finish",
      payload: {
        activeAgentId: resolvedMode.activeAgentId,
        harnessMode: resolvedMode.harnessMode,
        harnessModeId: resolvedMode.harnessModeId,
        hardnessMode: resolvedMode.harnessModeId,
      },
    });
    await writeQueue;
    return text;
  } finally {
    await writeQueue;
    abortSignal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

function requestContextFromRecord(
  values: Record<string, unknown>,
  threadId: string,
  resourceId: string,
): RequestContext {
  const context = new RequestContext<unknown>();
  for (const [key, value] of Object.entries(values)) {
    context.set(key, value);
  }
  context.set(MASTRA_THREAD_ID_KEY, threadId);
  context.set(MASTRA_RESOURCE_ID_KEY, resourceId);
  return context;
}

function harnessTextContent(message: unknown, kind: "text" | "thinking"): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (kind === "text" && part.type === "text" && typeof part.text === "string") return part.text;
      if (kind === "thinking" && part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
      return "";
    })
    .join("");
}

function incrementalDelta(previous: string, next: string): string {
  if (!next) return "";
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function textDelta(chunk: unknown): string {
  if (!isRecord(chunk)) return "";
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.delta === "string") return chunk.delta;
  if (isRecord(chunk.payload) && typeof chunk.payload.text === "string") return chunk.payload.text;
  return "";
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[key];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8").catch(() => undefined);
}

function safePathPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
