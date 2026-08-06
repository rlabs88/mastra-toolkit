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

This private package exposes one root facade over three deep modules: host-neutral capabilities, the Command Run contract, and Command Run execution. It owns parsing, scheduling, approval, trace, and result behavior plus ADHD, visible-browser, and audit policies. The executable Command Run tool belongs to `packages/sandbox`, where execution requires a sandbox workspace. Role packages consume the root facade; Mastra Code and Factory behavior remain outside this boundary.

## Future

Hosts may add tools through their own adapters, while the guarded execution and approval semantics here remain stable. New capability families should join this package only when they are role-independent and have package-local containment and failure contracts.
