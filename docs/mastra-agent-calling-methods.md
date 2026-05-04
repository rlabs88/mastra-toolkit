# Mastra Agent Calling Methods

This note documents how clients call Mastra agents in this workspace and how conversation memory identifiers are chosen by default.

## Call Surface

The client exposes one primary Mastra agent query tool:

| Tool | Use | Continuity behavior |
|---|---|---|
| `agent_query` | Async-by-default Mastra agent query. Pass `synchronous: true` only when the caller needs final output before continuing. | Sends a resolved `memory.thread` and `memory.resource` with the request. |

Supporting tools:

| Tool | Use |
|---|---|
| `agent_read` | Read output from a background job. |
| `agent_async_status` | Check background job state. |
| `agent_cancel` | Cancel a background job. |
| `agent_list` / `agent_status` / `agent_inspect` | Discover and inspect registered Mastra agents. |

## Async output handoff

After an async `agent_query` job completes, the parent agent should call `agent_read` for that job before finalizing so it can incorporate the async agent output. The only exception is when the user's initial prompt explicitly opted out with wording such as `pass the output` or `don't read the output`.

## Default memory identifiers

When the caller does not pass explicit memory IDs, the client derives them deterministically from the current process context:

```ts
resourceId = `client:${sha256(cwd).slice(0, 12)}`
threadId   = `client:${sha256(`${cwd}:${process.pid}`).slice(0, 12)}:${agentId}`
```

Source:

- `src/mastra/memory.ts` defines `defaultResourceId()` and `defaultThreadId()`.
- `src/mastra/tool.ts` resolves `params.resourceId ?? defaultResourceId()` and `params.threadId ?? defaultThreadId(params.agentId)` before creating the stream request. Async `agent_query` jobs use the job id as a default thread suffix so concurrent jobs for the same agent do not share a live stream thread.

## Default reuse behavior

For repeated synchronous calls with no explicit `threadId` or `resourceId`:

| Scenario | Default `resourceId` | Default `threadId` |
|---|---|---|
| Same client process, same working directory, same agent | Reused | Reused |
| Same client process, same working directory, different agent | Reused | Different, because `agentId` is part of the thread ID |
| Client restart, same working directory, same agent | Reused | New, because `process.pid` changes |
| Different working directory | New | New |

This means synchronous `agent_query` does **not** create a fresh default thread for every call within the same running client process. Async `agent_query` jobs use `defaultThreadId(agentId):jobId` by default so concurrent background jobs stay isolated; pass an explicit `threadId` to opt into shared continuity.

## Starting a new conversation intentionally

Pass a new `threadId` explicitly when you want a fresh conversation thread while keeping the same project/resource memory:

```json
{
  "agentId": "scout-agent",
  "message": "Inspect the workspace layout.",
  "resourceId": "client:f2ade5464497",
  "threadId": "manual:scout:workspace-layout-001"
}
```

Pass both a new `resourceId` and a new `threadId` when you want fully isolated memory.

## Practical guidance

- Use no explicit IDs for normal same-session continuation.
- Use a stable explicit `threadId` if the conversation must survive client restarts.
- Use a new explicit `threadId` for a clean task thread under the same project/resource.
- Use a new explicit `resourceId` only when memory should be isolated from the current project/user context.
