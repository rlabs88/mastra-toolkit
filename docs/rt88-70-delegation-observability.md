# RT88-70: Delegation observability and workspace ownership notes

## Workspace ownership

Workspace ownership is now explicit at the orchestration boundary:

- `orchestratorAgent` and `supervisorAgent` are configured with the shared `workspace`.
- `createMastraAgentHarness()` is also configured with the same shared `workspace` so harness modes without their own workspace receive it through Mastra's inheritance path.
- Specialist definitions (`scout`, `architect`, `researcher`, `advisor`, `developer`, `validator`) do not declare their own `workspace`; they inherit the active orchestration/harness workspace unless a future design adds a specific override.
- The shared workspace exposes inherited read-only inspection tools under Mastra's default `mastra_workspace_*` names. Write, edit, mkdir, delete, indexing, and shell execution remain disabled there, so role-specific explicit tools remain the write/command permission boundary and snapshot-aware write tools are not overridden.

## Delegation visibility in ACP

Delegation lifecycle events are emitted from orchestration `delegation` hooks and mapped into ACP updates:

- `delegation_start` -> `delegation-event` (status: `started`)
- `delegation_complete` -> `delegation-event` (status: `completed` or `failed`)

The emitted payload includes delegated target, delegated prompt, response/error, run/thread/resource correlation fields, and duration. The async harness stream subscribes to those hook payloads for the current thread/resource pair and forwards them as `delegation-event` chunks.

## Default tool stream events vs hook-style delegation events

- Existing generic tool stream events (`tool-call`, `tool-result`, `tool-error`) are still emitted unchanged.
- New explicit `delegation-event` chunks supplement tool events so ACP can render delegation activity as first-class observable updates.
- Default tool events remain useful for raw tool-call diagnostics, while hook events are the source of delegated target, prompt, response/result, success/failure, and timing data.
