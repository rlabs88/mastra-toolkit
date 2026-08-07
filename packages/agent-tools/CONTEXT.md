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

This private package exposes one root facade over host-neutral browser approval, tool audit, and aggregate run-containment policy. It owns no command execution language or divergent-fan-out tool. Role packages consume these hooks and browser policy; native workspace execution, Mastra Code projections, workflows, and Factory behavior remain outside this boundary.

## Future

Hosts may add request-scoped tools through their own adapters, while the audit and approval semantics here remain stable. New capability families should join this package only when they are role-independent and have package-local containment and failure contracts. Structured orchestration should be introduced as an explicitly published Mastra workflow, not as a general agent tool.
