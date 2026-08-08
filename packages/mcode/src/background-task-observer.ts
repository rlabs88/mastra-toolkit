import { inspect } from "node:util";
import { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";

const DYNAMIC_WORKFLOW_TOOL_ID = "dynamic_workflow";
const OBSERVED_EVENT_TYPES = new Set([
  "background-task-running",
  "background-task-output",
  "background-task-completed",
  "background-task-failed",
  "background-task-cancelled",
  "background-task-suspended",
  "background-task-resumed",
]);

interface BackgroundTaskManagerStream {
  stream(options?: {
    resourceId?: string;
    abortSignal?: AbortSignal;
  }): ReadableStream<Record<string, unknown>>;
}

interface HumanInfoEvent {
  readonly type: "info";
  readonly message: string;
}

export interface DynamicWorkflowBackgroundTaskObserverOptions {
  readonly manager: BackgroundTaskManagerStream | undefined;
  readonly resourceId: string;
  readonly emit: (event: HumanInfoEvent) => void;
  readonly waitForActivation?: boolean;
  readonly onError?: (error: unknown) => void;
}

export interface DynamicWorkflowBackgroundTaskObserver {
  activate(): void;
  rebind(resourceId: string, commit?: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

/**
 * Mirrors manager-stream telemetry into MCode's human-only session bus.
 * Session `info` events are rendered live but are not appended to the parent
 * agent transcript, so verbose workflow output cannot inflate a continuation.
 */
export function startDynamicWorkflowBackgroundTaskObserver(
  options: DynamicWorkflowBackgroundTaskObserverOptions,
): DynamicWorkflowBackgroundTaskObserver {
  if (!options.manager) {
    return {
      activate() {},
      async rebind(_resourceId, commit = async () => undefined) { await commit(); },
      async close() {},
    };
  }

  let buffered: Array<{ resourceId: string; event: HumanInfoEvent }> = [];
  let active = options.waitForActivation !== true;
  let closed = false;
  let observedResourceId = options.resourceId;
  let handoff: {
    readonly sourceResourceId: string;
    readonly targetResourceId: string;
    readonly sourceEvents: HumanInfoEvent[];
    readonly targetEvents: HumanInfoEvent[];
  } | undefined;
  const project = (resourceId: string, event: HumanInfoEvent) => {
    if (handoff) {
      if (resourceId === handoff.sourceResourceId) handoff.sourceEvents.push(event);
      else if (resourceId === handoff.targetResourceId) handoff.targetEvents.push(event);
      return;
    }
    if (resourceId !== observedResourceId) return;
    if (active) emit(options, event);
    else buffered.push({ resourceId, event });
  };
  let current = openManagerStream(options, observedResourceId, project);
  let transition = Promise.resolve();

  let closePromise: Promise<void> | undefined;
  return {
    activate(): void {
      if (active || closed) return;
      active = true;
      for (const item of buffered.splice(0)) {
        if (item.resourceId === observedResourceId) emit(options, item.event);
      }
    },
    async rebind(
      resourceId: string,
      commit = async () => undefined,
    ): Promise<void> {
      const nextTransition = transition.then(async () => {
        if (closed) return;
        if (resourceId === observedResourceId) {
          await commit();
          return;
        }

        const sourceResourceId = observedResourceId;
        const previous = current;
        const replacement = openManagerStream(options, resourceId, project);
        const pendingHandoff = {
          sourceResourceId,
          targetResourceId: resourceId,
          sourceEvents: [] as HumanInfoEvent[],
          targetEvents: [] as HumanInfoEvent[],
        };
        handoff = pendingHandoff;
        try {
          await commit();
        } catch (error) {
          handoff = undefined;
          await replacement?.close();
          for (const event of pendingHandoff.sourceEvents) project(sourceResourceId, event);
          throw error;
        }

        observedResourceId = resourceId;
        current = replacement;
        buffered = buffered.filter(item => item.resourceId === resourceId);
        handoff = undefined;
        for (const event of pendingHandoff.targetEvents) project(resourceId, event);
        await previous?.close();
      });
      transition = nextTransition.catch(error => report(options.onError, error));
      await nextTransition;
    },
    async close(): Promise<void> {
      closePromise ??= (async () => {
        closed = true;
        await transition;
        await current?.close();
        buffered.length = 0;
      })();
      await closePromise;
    },
  };
}

interface OpenManagerStream {
  close(): Promise<void>;
}

function openManagerStream(
  options: DynamicWorkflowBackgroundTaskObserverOptions,
  resourceId: string,
  project: (resourceId: string, event: HumanInfoEvent) => void,
): OpenManagerStream | undefined {
  if (!options.manager) return undefined;
  const abortController = new AbortController();
  let reader: ReadableStreamDefaultReader<Record<string, unknown>>;
  try {
    reader = options.manager.stream({
      resourceId,
      abortSignal: abortController.signal,
    }).getReader();
  } catch (error) {
    report(options.onError, error);
    return undefined;
  }

  const pump = (async () => {
    try {
      while (!abortController.signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        if (!isDynamicWorkflowEvent(next.value)) continue;
        project(resourceId, {
          type: "info",
          message: formatEvent(next.value),
        });
      }
    } catch (error) {
      if (!abortController.signal.aborted) report(options.onError, error);
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {
        report(options.onError, error);
      }
    }
  })();

  let closePromise: Promise<void> | undefined;
  return {
    async close(): Promise<void> {
      closePromise ??= (async () => {
        abortController.abort();
        await pump;
      })();
      await closePromise;
    },
  };
}

function isDynamicWorkflowEvent(event: Record<string, unknown>): boolean {
  if (typeof event.type !== "string" || !OBSERVED_EVENT_TYPES.has(event.type)) return false;
  const payload = event.payload;
  return Boolean(
    payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && (payload as Record<string, unknown>).toolName === DYNAMIC_WORKFLOW_TOOL_ID,
  );
}

function emit(
  options: DynamicWorkflowBackgroundTaskObserverOptions,
  event: HumanInfoEvent,
): void {
  try {
    options.emit(event);
  } catch (error) {
    report(options.onError, error);
  }
}

/**
 * Uses MastraTUI's public terminal injection seam as its best available
 * readiness signal. MastraTUI exposes no callback that is causally after its
 * initial chat replay, so callers must treat this as a rendering heuristic.
 */
export function createBackgroundTaskTelemetryTerminal(
  onReady: () => void,
  delegate: Terminal = new ProcessTerminal(),
): Terminal {
  let ready = false;
  let titleSet = false;
  return {
    start: (onInput, onResize) => delegate.start(onInput, onResize),
    stop: () => delegate.stop(),
    drainInput: (maxMs, idleMs) => delegate.drainInput(maxMs, idleMs),
    write(data) {
      delegate.write(data);
      if (ready || !titleSet) return;
      ready = true;
      onReady();
    },
    get columns() { return delegate.columns; },
    get rows() { return delegate.rows; },
    get kittyProtocolActive() { return delegate.kittyProtocolActive; },
    moveBy: lines => delegate.moveBy(lines),
    hideCursor: () => delegate.hideCursor(),
    showCursor: () => delegate.showCursor(),
    clearLine: () => delegate.clearLine(),
    clearFromCursor: () => delegate.clearFromCursor(),
    clearScreen: () => delegate.clearScreen(),
    setTitle(title) {
      delegate.setTitle(title);
      titleSet = true;
    },
    setProgress: active => delegate.setProgress(active),
  };
}

function formatEvent(event: Record<string, unknown>): string {
  return `Dynamic Workflow · ${String(event.type)}\n${inspect(event, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    breakLength: 100,
    compact: false,
    customInspect: false,
    getters: false,
  })}`;
}

function report(listener: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    listener?.(error);
  } catch {
    // Observation is fail-open: even its diagnostic hook cannot affect a task.
  }
}
