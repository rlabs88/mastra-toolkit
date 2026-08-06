---
kind: checkpoint-context
version: 1
scope: "packages/agent-tools/**"
status: active
---

# Agent Tools Package Context

## Past

Command Run, ADHD exploration, browser policy, and tool audit behavior began under the root `src/` tree beside role composition. Extracting them creates a reusable capability boundary without making tools depend on any agent persona or host adapter.

## Present

This private package owns the host-neutral Command Run parser, scheduler, approval, trace, and result contracts plus the factories and policies for ADHD, visible browser use, and tool audit events. The executable Command Run tool belongs to `packages/sandbox`, where execution can require a sandbox workspace. Role packages consume these exports; Mastra Code and Factory behavior remain outside this boundary.

## Future

Hosts may add tools through their own adapters, while the guarded execution and approval semantics here remain stable. New capability families should join this package only when they are role-independent and have package-local containment and failure contracts.
