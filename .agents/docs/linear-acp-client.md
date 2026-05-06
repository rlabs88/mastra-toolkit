# Linear ACP Adapter Extraction

The direct Linear Agent Session to ACP bridge now lives in the private `EugeneChan00/linear-acp-adapter` repo.

This repo keeps the Mastra ACP agent/server surface in `mastra-agents/acp/*` and the Palmer Chat SDK Linear channel under `mastra-agents/src/adapters/channels/linear/*`. The extracted adapter owns Linear OAuth, webhook verification, Linear Agent Activity rendering, adapter state, and ACP client transport configuration.

## Deployment Boundary

```txt
Linear Agent Session
  -> linear-acp-adapter
  -> Mastra ACP target by stdio command/args or future ACP URL
  -> Mastra runtime
```

Use `LINEAR_ACP_ADAPTER_*` env keys in the adapter repo. Do not add another first-class Linear ACP app config surface to `mastra-system`.

## Mastra Integration

The adapter should be coupled as a deployment neighbor to `mastra-server`, not imported into Mastra code. In local Docker, the adapter can launch:

```txt
node compiled/mastra-agents/acp/stdio.js --agent-id supervisor-agent --mastra-base-url http://mastra-server:4111
```

## Interface Boundaries

Linear Agent Session is the durable Linear runtime surface for a user interaction with the extracted adapter. It maps one-to-one to an adapter-owned session binding and carries the ACP session id once created.

ACP session is the durable agent execution surface. The adapter reuses the ACP session id attached to a Linear Agent Session when a later `prompted` webhook arrives, subject to the target ACP server's advertised `loadSession` support.

Linear Agent Activity is the streaming runtime surface. The adapter writes tool calls as `action`, agent replies as `response`, thoughts as ephemeral `thought`, and failures as `error`.

Linear comment is the issue-visible observability surface. The adapter creates one comment per Linear issue/session binding and updates it as observable ACP events arrive.

Mastra thread and resource ids remain owned by the Mastra ACP target. The adapter should pass through ACP session identity and avoid inventing Mastra memory identifiers unless the ACP target explicitly exposes them.

## Observability Event Contract

Layer 1 already exists in the ACP adapter: Mastra runtime event to ACP runtime event.

Layer 2 is owned by the extracted adapter: ACP runtime event to Linear runtime event.

| ACP update | adapter event | Linear surface |
| --- | --- | --- |
| `agent_message_chunk` | `agent.response.delta` | response buffer, issue observability comment |
| `agent_thought_chunk` | `agent.thought.delta` | ephemeral thought activity, issue observability comment buffer |
| `tool_call` / `tool_call_update` pending | `tool.updated` | action activity, issue observability comment |
| `tool_call` / `tool_call_update` in progress | `tool.started` | action activity, issue observability comment |
| `tool_call` / `tool_call_update` completed | `tool.completed` | action activity with result, issue observability comment |
| `tool_call` / `tool_call_update` failed | `tool.failed` | action activity with error/result, issue observability comment |
| `plan` | `plan.updated` | persisted event only for now |
| `usage_update` | `usage.updated` | persisted event only for now |
| prompt start | `turn.started` | external session URLs when configured |
| prompt finish | `turn.completed` | response activity |
| prompt error | `turn.failed` | error activity |

The issue-visible comment must account for payload content by case:

- Tool call payloads include `toolCallId`, status, title, raw input, and raw output or content.
- Agent response payloads append text chunks by turn id and render the completed response.
- Thought payloads are retained in session state but shown only as ephemeral Linear activity unless the renderer is extended to expose them in the issue comment.

## State

`FileLinearAcpClientStateStore` persists session bindings and webhook idempotency to JSON. It records:

- Linear Agent Session id.
- Linear issue/comment/source comment ids.
- Linear session URL.
- ACP session id.
- Observability comment id.
- Processed webhook ids.
- Emitted adapter event ids.
- Per-turn response and thought text.
- Latest snapshot for each tool call.
