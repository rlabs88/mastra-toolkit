# linear-acp-client

linear-acp-client is the new Linear app path for direct Linear Agent Session integration. Palmer remains the legacy Chat SDK Linear channel during migration.

## Route

linear-acp-client registers one webhook route when explicitly enabled:

```txt
POST /api/linear-acp-client/linear/webhook
```

Required runtime env:

```txt
ENABLE_LINEAR_ACP_CLIENT=true
LINEAR_ACP_CLIENT_WEBHOOK_SECRET=<linear webhook secret>
LINEAR_ACP_CLIENT_API_KEY=<linear api key>
```

`LINEAR_ACP_CLIENT_ACCESS_TOKEN` can be used instead of `LINEAR_ACP_CLIENT_API_KEY`.

For a real app install, create a separate Linear OAuth app for `linear-acp-client`, enable Agent session events, request app actor scopes, and install with `actor=app`. This bridge currently accepts the resulting app actor token through env for smoke testing; durable OAuth callback and token storage should be added before multi-workspace production use.

Optional env:

```txt
LINEAR_ACP_CLIENT_WEBHOOK_PATH=/api/linear-acp-client/linear/webhook
LINEAR_ACP_CLIENT_STATE_FILE=.mastra/linear-acp-client-state.json
LINEAR_ACP_CLIENT_CREATE_AS_USER=linear-acp-client
LINEAR_ACP_CLIENT_ACP_COMMAND=node
LINEAR_ACP_CLIENT_ACP_ARGS='["compiled/mastra-agents/acp/stdio.js","--agent-id","supervisor-agent"]'
LINEAR_ACP_CLIENT_ACP_CWD=/container/shared/workspace/projects/mastra-system-rt88-90-acp-linear
LINEAR_ACP_CLIENT_ACP_AGENT_ID=supervisor-agent
LINEAR_ACP_CLIENT_MASTRA_BASE_URL=http://localhost:4111
LINEAR_ACP_CLIENT_EXTERNAL_URLS='Runtime|https://example.test/session'
```

## Interface Boundaries

Linear Agent Session is the durable Linear runtime surface for a user interaction with linear-acp-client. It maps one-to-one to a persisted linear-acp-client session binding and carries the ACP session id once created.

ACP session is the durable agent execution surface. linear-acp-client reuses the ACP session id attached to a Linear Agent Session when a later `prompted` webhook arrives.

Linear Agent Activity is the streaming runtime surface. linear-acp-client writes tool calls as `action`, agent replies as `response`, thoughts as ephemeral `thought`, and failures as `error`.

Linear comment is the issue-visible observability surface. linear-acp-client creates one comment per Linear issue/session binding and updates it as observable ACP events arrive.

Thread remains owned by the legacy Palmer Chat SDK adapter. linear-acp-client does not depend on Chat SDK thread state.

## Observability Event Contract

Layer 1 already exists in the ACP adapter: Mastra runtime event to ACP runtime event.

Layer 2 is owned by linear-acp-client: ACP runtime event to Linear runtime event.

| ACP update | linear-acp-client event | Linear surface |
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
- Emitted linear-acp-client event ids.
- Per-turn response and thought text.
- Latest snapshot for each tool call.
