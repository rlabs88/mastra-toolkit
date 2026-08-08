import type { AgentControllerEvent } from "@mastra/core/agent-controller";

interface SessionEventSource {
  subscribe(listener: (event: AgentControllerEvent) => void | Promise<void>): () => void;
}

interface HumanInfoEvent {
  readonly type: "info";
  readonly message: string;
}

export interface ForegroundToolFeedbackObserverOptions {
  readonly session: SessionEventSource;
  readonly emit: (event: HumanInfoEvent) => void;
  readonly now?: () => number;
  readonly defer?: (callback: () => void) => void;
  readonly onError?: (error: unknown) => void;
}

export interface ForegroundToolFeedbackObserver {
  close(): Promise<void>;
}

interface ToolTiming {
  readonly name: string;
  readonly startedAt: number;
}

/**
 * Projects foreground tool and provider-wait timings onto the human-only
 * session channel. `info` events render in MCode but are not stored in the
 * parent agent transcript, so feedback cannot alter the continuation.
 */
export function startForegroundToolFeedbackObserver(
  options: ForegroundToolFeedbackObserverOptions,
): ForegroundToolFeedbackObserver {
  const now = options.now ?? Date.now;
  const defer = options.defer ?? queueMicrotask;
  const tools = new Map<string, ToolTiming>();
  let waitingForModelSince: number | undefined;
  let closed = false;

  const schedule = (message: string): void => {
    defer(() => {
      if (closed) return;
      try {
        options.emit({ type: "info", message });
      } catch (error) {
        report(options.onError, error);
      }
    });
  };

  const reportContinuation = (continuedAt: number): void => {
    if (waitingForModelSince === undefined) return;
    const duration = Math.max(0, continuedAt - waitingForModelSince);
    waitingForModelSince = undefined;
    schedule(`Model continued after ${formatDuration(duration)}.`);
  };

  const unsubscribe = options.session.subscribe(event => {
    if (closed || !event || typeof event !== "object") return;
    try {
      switch (event.type) {
        case "agent_start":
          tools.clear();
          waitingForModelSince = undefined;
          break;
        case "tool_start": {
          const timestamp = now();
          reportContinuation(timestamp);
          if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
            tools.set(event.toolCallId, { name: event.toolName, startedAt: timestamp });
          }
          break;
        }
        case "tool_end": {
          if (typeof event.toolCallId !== "string") break;
          const timing = tools.get(event.toolCallId);
          if (!timing) break;
          tools.delete(event.toolCallId);
          const completedAt = now();
          const outcome = event.isError === true ? "failed" : "completed";
          const suffix = tools.size > 0
            ? `${tools.size} ${tools.size === 1 ? "tool" : "tools"} still running…`
            : "waiting for model continuation…";
          if (tools.size === 0) waitingForModelSince = completedAt;
          schedule(
            `Tool · ${timing.name} ${outcome} in ${formatDuration(completedAt - timing.startedAt)} · ${suffix}`,
          );
          break;
        }
        case "message_update":
          if (hasAssistantText(event.message)) reportContinuation(now());
          break;
        case "agent_end":
          tools.clear();
          waitingForModelSince = undefined;
          break;
      }
    } catch (error) {
      report(options.onError, error);
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    async close(): Promise<void> {
      closePromise ??= Promise.resolve().then(() => {
        closed = true;
        tools.clear();
        waitingForModelSince = undefined;
        unsubscribe();
      });
      await closePromise;
    },
  };
}

function hasAssistantText(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return false;
  if (typeof record.content === "string") return record.content.trim().length > 0;
  if (!record.content || typeof record.content !== "object" || Array.isArray(record.content)) return false;
  const parts = (record.content as Record<string, unknown>).parts;
  return Array.isArray(parts) && parts.some(part => Boolean(
    part
    && typeof part === "object"
    && !Array.isArray(part)
    && (part as Record<string, unknown>).type === "text"
    && typeof (part as Record<string, unknown>).text === "string"
    && ((part as Record<string, unknown>).text as string).trim(),
  ));
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

function report(listener: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    listener?.(error);
  } catch {
    // Human feedback is fail-open and cannot affect the agent run.
  }
}
