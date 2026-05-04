# Historical Plan: Async Mastra Streaming Card (was Pi TUI)

## Status

Completed. This plan was implemented when the Pi extension lived inside the mastra-system monorepo. The Pi extension has since been extracted to the standalone `pi-mastra-extension` repository.

## Source Issue

GitHub issue #2: `Add async streaming Mastra agent calls routed to Pi TUI`

## User-Facing Problem (Historical)

Async Mastra agent calls should return a `jobId` immediately while the agent output continues to stream live in the client TUI. The async call path showed a mostly static compact widget/card, did not use the rich Mastra card layout, could time out while still receiving stream chunks, and completion did not reliably re-notify/resume the parent agent.

## Desired Behavior

1. `mastra_agent_start` returns immediately with a stable `jobId`.
2. The running async job streams live into the existing Mastra card layout.
3. The card appears just above the editor/input channel.
4. The card is visually right-aligned inside that valid widget area so it feels bottom-right/pinned.
5. New transcript text can continue above the pinned widget while the widget itself updates.
6. On completion, Pi persists a concise custom result message and notifies/resumes the parent agent.
7. Long-running streams do not die because of a wall-clock timeout if chunks are still arriving.
8. Async output artifacts/read tools include useful output even when the agent emits reasoning/tool events instead of `text-delta` chunks.

## Confirmed Client API Constraints

`@mariozechner/pi-coding-agent` only supports these widget placements:

```ts
type WidgetPlacement = "aboveEditor" | "belowEditor";
```

There is no `bottomRight` or `aboveTextChannel` placement. Therefore:

- Use `{ placement: "aboveEditor" }`.
- Implement the bottom-right appearance inside the widget renderer by choosing a bounded card width and left-padding rendered card lines.

`sendMessage` supports:

```ts
{
  deliverAs?: "steer" | "followUp" | "nextTurn";
  triggerTurn?: boolean;
}
```

`triggerTurn: true` is needed when the client is idle and the completion message should resume the parent agent.

## Root Causes

### Root Cause 1: Async UI path does not render the full card

Relevant files:

- `pi/src/mastra/tool.ts`
- `pi/src/tui/index.ts`
- `pi/src/extensions/index.ts`

Sync path:

- `createMastraAgentTool()` streams chunks.
- It calls `onUpdate(makeToolResult(details, params))`.
- Its `renderResult()` returns `new MastraAgentCard(...)`.
- Result: rich card streams live for sync `mastra_agent_call`.

Async path:

- `createMastraAgentStartTool()` starts `MastraAsyncAgentManager` and returns a small receipt immediately.
- Background `MastraAsyncAgentManager.run()` receives stream chunks and calls `activitySink.start/update/finish`.
- `pi/src/extensions/index.ts` wires that sink to `MastraAgentActivityStore`.
- `MastraAgentsWidget` renders only a compact summary list, not `MastraAgentCard`.
- `MastraAgentActivityStore` stores summary/count fields, not the complete `MastraAgentCallDetails` needed by `MastraAgentCard`.

### Root Cause 2: Stream timeout is wall-clock, not idle-based

Relevant file:

- `pi/src/mastra/client.ts`

`MastraHttpClient.streamJsonEvents()` currently creates one timeout before fetch/stream consumption:

```ts
setTimeout(() => controller.abort(new Error("Mastra stream timed out")), timeoutMs)
```

This timeout does not reset when SSE chunks arrive. A healthy long-running async agent can be aborted while actively streaming.

### Root Cause 3: Completion notification may persist but not resume the parent

Relevant file:

- `pi/src/extensions/index.ts`

Current completion path:

```ts
pi.sendMessage(message, { deliverAs: "followUp" })
```

If the client is idle by the time the background job finishes, this can append/persist without triggering a new parent turn. Use `triggerTurn: true` for completion notification semantics.

### Root Cause 4: Async artifact may be empty for reasoning/tool-heavy agents

Relevant file:

- `pi/src/mastra/tool.ts`

`MastraAsyncAgentManager.persistChunk()` only writes `text-delta` text to `output.txt`. Agents that emit mostly `reasoning-delta` and tool events produce a large `events.jsonl` but an empty or missing `output.txt`.

## Vertical Implementation Plan

This is a vertical bug fix: each phase depends on the previous phase and must be validated before moving on.

### Phase 1 — Extend activity store to retain full details

**Files:**

- `pi/src/tui/index.ts`

**Changes:**

1. Add a full details snapshot to `MastraAgentActivity`:

```ts
details: MastraAgentCallDetails;
```

2. In `activityFromDetails()`, clone enough of `MastraAgentCallDetails` to avoid accidental mutation surprises while retaining full card data:

```ts
details: {
  ...details,
  toolCalls: [...details.toolCalls],
  toolResults: [...details.toolResults],
  errors: [...details.errors],
}
```

3. Keep existing summary fields for status/footer/list compatibility.

**Validation:**

- Typecheck passes.
- Existing widget summary behavior can still be derived from `MastraAgentActivity`.
- `activity.details.toolCalls` and `activity.details.toolResults` are available to card rendering.

### Phase 2 — Render `MastraAgentCard` in the async widget

**Files:**

- `pi/src/tui/index.ts`

**Changes:**

1. Update `MastraAgentsWidget.render()` so active async jobs render the real card:

```ts
const card = new MastraAgentCard(activity.details, {
  isPartial: activity.status === "running",
  expanded: false,
}, th);
```

2. Right-align the rendered card lines inside the widget:

```ts
const cardWidth = Math.min(width, 96);
const pad = Math.max(0, width - cardWidth);
return card.render(cardWidth).map((line) => " ".repeat(pad) + line);
```

3. Show at most one full card by default, preferably the newest running job; optionally include a compact `+N more` line if multiple jobs are visible.

4. Preserve the store subscription and 160ms spinner re-render timer.

**Validation:**

- Starting an async job causes the above-editor widget to render a rich Mastra card.
- The card updates as chunks arrive.
- The card uses the same renderer as sync `mastra_agent_call`.
- The card is visually right-aligned without relying on unsupported Pi placement values.

### Phase 3 — Fix stream timeout semantics

**Files:**

- `pi/src/mastra/client.ts`
- Tests in `pi/src/mastra/client.test.ts` or a new focused test.

**Changes:**

1. Convert wall-clock timeout into an idle timeout that resets whenever a stream event arrives.

Pseudo-implementation:

```ts
let timeout: ReturnType<typeof setTimeout> | undefined;
const resetTimeout = () => {
  if (timeout) clearTimeout(timeout);
  timeout = setTimeout(
    () => controller.abort(new Error("Mastra stream timed out")),
    options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
  );
};

resetTimeout();
for await (const event of parseSseDataEvents(response.body)) {
  resetTimeout();
  if (event.data === "[DONE]") return;
  yield parseSseJsonData(event.data);
}
```

2. Consider renaming docs/comments to clarify `timeoutMs` means idle timeout.

**Validation:**

- Add/adjust a test where chunks arrive slower than the old hard timeout would allow cumulatively, but faster than the idle timeout. The stream should not abort.
- Existing timeout behavior still aborts when no chunks arrive for longer than `timeoutMs`.

### Phase 4 — Notify/resume parent on async completion

**Files:**

- `pi/src/extensions/index.ts`

**Changes:**

Change completion callback from:

```ts
{ deliverAs: "followUp" }
```

to:

```ts
{ deliverAs: "followUp", triggerTurn: true }
```

**Validation:**

- Completion still persists a custom `mastra-agent-result` transcript message.
- If parent Pi agent is idle, completion triggers a follow-up turn so the parent sees the result.
- No per-token custom messages are emitted.

### Phase 5 — Improve async output artifacts/read behavior

**Files:**

- `pi/src/mastra/tool.ts`

**Changes:**

1. Continue writing `text-delta` to `output.txt`.
2. Also write useful readable lines for reasoning/tool/error/finish events, or create a separate summary artifact.
3. Avoid advertising `output.txt` as full output when it is empty and only `events.jsonl` has content.
4. Consider making `mastra_agent_read` fall back to:

```txt
details.text || details.reasoning || formatted recent tool events || events artifact notice
```

**Validation:**

- A reasoning/tool-heavy async agent produces useful `mastra_agent_read` output.
- Completion summary is not `(no text output)` when reasoning/tool events are available.

### Phase 6 — Tests and build

**Files:**

- `pi/src/mastra/tool.test.ts`
- `pi/src/mastra/client.test.ts`
- Potentially a new TUI/store unit test if project patterns support it.

**Required commands:**

```bash
npm run typecheck --workspace @mastrasystem/pi
npm run test --workspace @mastrasystem/pi
```

**Validation:**

- Typecheck passes.
- Tests pass.
- Existing sync `mastra_agent_call` rendering remains unchanged.
- Existing async manager start/read/cancel tests still pass.

## Implementation Map: Why Each Element Exists

- `MastraAsyncAgentManager` (`pi/src/mastra/tool.ts`) owns the background stream lifecycle so `mastra_agent_start` can return a `jobId` immediately while work continues.
- `MastraAgentActivityStore` (`pi/src/tui/index.ts`) is the bridge between background streams and TUI rendering. It stores summary fields for status lines and a full `MastraAgentCallDetails` snapshot for rich card rendering.
- `MastraAgentsWidget` (`pi/src/tui/index.ts`) is the live surface. It reuses `MastraAgentCard` so async and sync calls share the same card layout, right-aligns inside Pi's valid `aboveEditor` widget placement, and splits height across up to two cards for concurrent jobs.
- `MastraAgentCardOptions.maxBodyLines` (`pi/src/tui/index.ts`) lets the widget bound each card's body height without changing expanded sync tool-card behavior.
- Empty self-rendering for `mastra_agent_start` (`pi/src/mastra/tool.ts`) hides the static tool card because the live widget is now the authoritative async visual surface. The tool still returns its receipt to the parent model.
- Idle timeout reset (`pi/src/mastra/client.ts`) prevents healthy long-running streams from being killed while SSE chunks are still arriving.
- Completion `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` (`pi/src/extensions/index.ts`) persists one concise final result and wakes the parent agent if it has gone idle.

## Acceptance Criteria

- `mastra_agent_start` returns immediately with `jobId`.
- A live async Mastra card appears above the editor/input channel.
- The card is right-aligned within that widget area.
- The card uses `MastraAgentCard`, matching the sync layout.
- Text/reasoning/tool progress updates during the background stream.
- Async stream does not time out while chunks are actively arriving.
- Completion persists a custom result message.
- Completion triggers/resumes the parent agent via `triggerTurn: true`.
- `mastra_agent_read` returns useful output for reasoning/tool-heavy agents.
- No live token spam is written to the transcript/model context.
- All tests and typecheck pass.

## Risks / Caveats

- `MastraAgentCard` can be tall. The async widget should show only one full card by default, or a bounded compact-card variant should be introduced.
- If multiple async jobs run, prioritize currently running jobs over lingering completed jobs.
- Ensure the card renderer does not exceed the width passed to `render(width)` after padding.
- Do not change Pi widget placement to unsupported values.

## Suggested Implementation Order for Developer Agent

1. Modify `MastraAgentActivityStore` to retain full details.
2. Modify `MastraAgentsWidget` to render one right-aligned `MastraAgentCard`.
3. Update completion `sendMessage` to include `triggerTurn: true`.
4. Fix idle timeout in `MastraHttpClient.streamJsonEvents()`.
5. Improve async artifacts/read fallback.
6. Add/update tests.
7. Run typecheck and tests.
8. Summarize files changed, validation results, and any unresolved issues.
