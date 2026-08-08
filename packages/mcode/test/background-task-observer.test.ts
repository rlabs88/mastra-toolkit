import { describe, expect, test, vi } from "vitest";
import {
  createBackgroundTaskTelemetryTerminal,
  startDynamicWorkflowBackgroundTaskObserver,
} from "../src/background-task-observer.js";

interface StreamHarness {
  readonly manager: {
    stream(options?: Record<string, unknown>): ReadableStream<Record<string, unknown>>;
  };
  readonly options: Array<Record<string, unknown> | undefined>;
  push(event: Record<string, unknown>): void;
  close(): void;
}

function streamHarness(): StreamHarness {
  const options: Array<Record<string, unknown> | undefined> = [];
  const controllers = new Map<string, ReadableStreamDefaultController<Record<string, unknown>>>();
  return {
    options,
    manager: {
      stream(input) {
        options.push(input);
        return new ReadableStream({
          start(streamController) {
            const resourceId = String(input?.resourceId ?? "");
            controllers.set(resourceId, streamController);
            const signal = input?.abortSignal as AbortSignal | undefined;
            signal?.addEventListener("abort", () => {
              controllers.delete(resourceId);
              streamController.close();
            }, { once: true });
          },
        });
      },
    },
    push(event) {
      const eventResourceId = (event.payload as Record<string, unknown> | undefined)?.resourceId;
      if (typeof eventResourceId === "string") controllers.get(eventResourceId)?.enqueue(event);
    },
    close() {
      for (const controller of controllers.values()) controller.close();
      controllers.clear();
    },
  };
}

const event = (
  type: string,
  toolName = "dynamic_workflow",
  payload: Record<string, unknown> = {},
  resourceId = "resource-1",
): Record<string, unknown> => ({
  type,
  payload: {
    taskId: "task-1",
    toolName,
    toolCallId: "call-1",
    agentId: "cortex",
    runId: "run-1",
    resourceId,
    ...payload,
  },
});

describe("dynamic_workflow background task observer", () => {
  test("buffers and then projects every supported lifecycle event in arrival order", async () => {
    const stream = streamHarness();
    const humanEvents: Array<{ type: string; message?: string }> = [];
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager: stream.manager,
      resourceId: "resource-1",
      waitForActivation: true,
      emit: emitted => humanEvents.push(emitted),
    });

    const lifecycleTypes = [
      "background-task-running",
      "background-task-output",
      "background-task-completed",
      "background-task-failed",
      "background-task-cancelled",
      "background-task-suspended",
      "background-task-resumed",
    ];
    for (const type of lifecycleTypes) stream.push(event(type));

    await Promise.resolve();
    expect(humanEvents).toEqual([]);
    observer.activate();
    await vi.waitFor(() => expect(humanEvents).toHaveLength(lifecycleTypes.length));
    expect(humanEvents.map(item => item.type)).toEqual(lifecycleTypes.map(() => "info"));
    expect(humanEvents.map(item => item.message?.split("\n", 1)[0])).toEqual(
      lifecycleTypes.map(type => `Dynamic Workflow · ${type}`),
    );

    await observer.close();
  });

  test("activates buffered telemetry only after the TUI terminal title is set", () => {
    const titles: string[] = [];
    let activations = 0;
    const delegate = {
      start: () => undefined,
      stop: () => undefined,
      drainInput: async () => undefined,
      write: () => undefined,
      get columns() { return 120; },
      get rows() { return 40; },
      get kittyProtocolActive() { return false; },
      moveBy: () => undefined,
      hideCursor: () => undefined,
      showCursor: () => undefined,
      clearLine: () => undefined,
      clearFromCursor: () => undefined,
      clearScreen: () => undefined,
      setTitle: (title: string) => titles.push(title),
      setProgress: () => undefined,
    };
    const terminal = createBackgroundTaskTelemetryTerminal(
      () => { activations += 1; },
      delegate,
    );

    expect(activations).toBe(0);
    terminal.setTitle("RLabs MCode");
    terminal.setTitle("RLabs MCode - project");

    expect(titles).toEqual(["RLabs MCode", "RLabs MCode - project"]);
    expect(activations).toBe(0);
    terminal.write("first complete frame");
    terminal.write("later frame");
    expect(activations).toBe(1);
  });

  test("renders the complete provider-emitted nested payload without entering an agent channel", async () => {
    const stream = streamHarness();
    const emitted: Array<{ type: "info"; message: string }> = [];
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager: stream.manager,
      resourceId: "resource-1",
      emit: item => emitted.push(item),
    });
    const nested = {
      type: "workflow-step-output",
      payload: {
        stepName: "agent-research",
        output: {
          type: "agent-execution-event",
          payload: {
            text: "nested agent response",
            reasoning: "provider emitted reasoning summary",
            toolCall: { name: "web_search", args: { query: "markets" } },
            toolResult: { headlines: ["one", "two"] },
            error: { message: "visible nested error" },
            finalResponse: "market summary",
          },
        },
      },
    };

    stream.push(event("background-task-output", "dynamic_workflow", { payload: nested }));

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.type).toBe("info");
    for (const visible of [
      "workflow-step-output",
      "agent-research",
      "nested agent response",
      "provider emitted reasoning summary",
      "web_search",
      "markets",
      "headlines",
      "visible nested error",
      "market summary",
    ]) {
      expect(emitted[0]?.message).toContain(visible);
    }

    await observer.close();
  });

  test("rebinds resources without releasing stale buffered or handoff events", async () => {
    const stream = streamHarness();
    const emitted: Array<{ type: "info"; message: string }> = [];
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager: stream.manager,
      resourceId: "resource-1",
      waitForActivation: true,
      emit: item => emitted.push(item),
    });

    expect(stream.options).toHaveLength(1);
    expect(stream.options[0]).toMatchObject({ resourceId: "resource-1" });
    expect(stream.options[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    stream.push(event("background-task-running", "another_tool"));
    stream.push(event("background-task-output", "dynamic_workflow", { marker: "buffered-old" }));
    const rebind = observer.rebind("resource-2");
    stream.push(event("background-task-output", "dynamic_workflow", { marker: "handoff-old" }));
    await rebind;
    await vi.waitFor(() => expect(stream.options).toHaveLength(2));
    expect(stream.options[1]).toMatchObject({ resourceId: "resource-2" });
    stream.push(event("background-task-output", "dynamic_workflow", { marker: "new" }, "resource-2"));
    await Promise.resolve();
    expect(emitted).toEqual([]);

    observer.activate();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.message).toContain("resource-2");
    expect(emitted[0]?.message).toContain("new");
    expect(emitted[0]?.message).not.toContain("buffered-old");
    expect(emitted[0]?.message).not.toContain("handoff-old");

    await observer.close();
  });

  test("holds replacement-resource telemetry until the session switch commits", async () => {
    const stream = streamHarness();
    const emitted: Array<{ type: "info"; message: string }> = [];
    let commit!: () => void;
    const commitGate = new Promise<void>(resolve => { commit = resolve; });
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager: stream.manager,
      resourceId: "resource-1",
      emit: item => emitted.push(item),
    });

    const rebind = observer.rebind("resource-2", async () => commitGate);
    await vi.waitFor(() => expect(stream.options).toHaveLength(2));
    stream.push(event("background-task-output", "dynamic_workflow", {
      marker: "replacement-before-commit",
    }, "resource-2"));
    await Promise.resolve();
    expect(emitted).toEqual([]);

    commit();
    await rebind;
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.message).toContain("replacement-before-commit");

    await observer.close();
  });

  test("restores old-resource delivery when the session switch fails", async () => {
    const stream = streamHarness();
    const emitted: Array<{ type: "info"; message: string }> = [];
    const diagnostics: unknown[] = [];
    let rejectCommit!: (error: Error) => void;
    const commitGate = new Promise<void>((_resolve, reject) => { rejectCommit = reject; });
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager: stream.manager,
      resourceId: "resource-1",
      emit: item => emitted.push(item),
      onError: error => diagnostics.push(error),
    });

    const rebind = observer.rebind("resource-2", async () => commitGate);
    await vi.waitFor(() => expect(stream.options).toHaveLength(2));
    stream.push(event("background-task-output", "dynamic_workflow", {
      marker: "old-during-failed-commit",
    }));
    stream.push(event("background-task-output", "dynamic_workflow", {
      marker: "new-during-failed-commit",
    }, "resource-2"));
    const commitError = new Error("resource switch failed");
    rejectCommit(commitError);

    await expect(rebind).rejects.toBe(commitError);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.message).toContain("old-during-failed-commit");
    expect(emitted[0]?.message).not.toContain("new-during-failed-commit");
    await vi.waitFor(() => expect(diagnostics).toEqual([commitError]));

    stream.push(event("background-task-completed", "dynamic_workflow", {
      marker: "old-after-failed-commit",
    }));
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(emitted[1]?.message).toContain("old-after-failed-commit");

    await observer.close();
  });

  test("aborts and awaits the manager reader during shutdown", async () => {
    let streamController: ReadableStreamDefaultController<Record<string, unknown>> | undefined;
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager: {
        stream: options => new ReadableStream({
          start(controller) {
            streamController = controller;
            signal = options?.abortSignal;
            signal?.addEventListener("abort", () => {
              void gate.then(() => controller.close());
            }, { once: true });
          },
        }),
      },
      resourceId: "resource-1",
      emit: () => undefined,
    });

    expect(signal?.aborted).toBe(false);
    let closed = false;
    const closePromise = observer.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(streamController).toBeDefined();

    release();
    await closePromise;
    expect(closed).toBe(true);
  });

  test("keeps stream and rendering failures fail-open", async () => {
    const stream = streamHarness();
    const diagnostics: unknown[] = [];
    let attempts = 0;
    const observer = startDynamicWorkflowBackgroundTaskObserver({
      manager: stream.manager,
      resourceId: "resource-1",
      emit: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("render failed");
      },
      onError: error => diagnostics.push(error),
    });

    stream.push(event("background-task-running"));
    stream.push(event("background-task-completed"));

    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(diagnostics).toHaveLength(1);
    await expect(observer.close()).resolves.toBeUndefined();

    const streamFailure = new Error("stream failed");
    const failedDiagnostics: unknown[] = [];
    const failedObserver = startDynamicWorkflowBackgroundTaskObserver({
      manager: {
        stream: () => new ReadableStream({
          start(controller) {
            controller.error(streamFailure);
          },
        }),
      },
      resourceId: "resource-1",
      emit: () => undefined,
      onError: error => failedDiagnostics.push(error),
    });

    await vi.waitFor(() => expect(failedDiagnostics).toEqual([streamFailure]));
    await expect(failedObserver.close()).resolves.toBeUndefined();

    const startupFailure = new Error("subscription failed");
    const startupDiagnostics: unknown[] = [];
    const startupObserver = startDynamicWorkflowBackgroundTaskObserver({
      manager: {
        stream() {
          throw startupFailure;
        },
      },
      resourceId: "resource-1",
      emit: () => undefined,
      onError(error) {
        startupDiagnostics.push(error);
        throw new Error("diagnostic failed");
      },
    });

    expect(startupDiagnostics).toEqual([startupFailure]);
    await expect(startupObserver.close()).resolves.toBeUndefined();
  });
});
