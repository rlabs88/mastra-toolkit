# RT88-70: Delegation observability and workspace ownership notes

## Workspace ownership

Current agent definitions do not assign explicit per-agent workspace instances. Workspace access remains centralized via shared workspace tools exposed by orchestration agents (`orchestrator` and `supervisor`) and inherited by specialist delegation context.

## Delegation visibility in ACP

Delegation lifecycle events are emitted from harness streaming and mapped into ACP updates:

- `delegation_start` -> `delegation-event` (status: `started`)
- `delegation_complete` -> `delegation-event` (status: `completed` or `failed`)

The emitted payload includes delegated target, delegated prompt, response/error, run/thread/resource correlation fields, and duration.

## Default tool stream events vs hook-style delegation events

- Existing generic tool stream events (`tool-call`, `tool-result`, `tool-error`) are still emitted unchanged.
- New explicit `delegation-event` chunks supplement tool events so ACP can render delegation activity as first-class observable updates.
