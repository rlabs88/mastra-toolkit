---
kind: checkpoint-context
version: 1
scope: "packages/factory-github-projects/**"
status: active
---

# Factory GitHub Projects Context

## Past

Mastra Factory owned repository integrations and governed work execution but had no GitHub Projects V2 binding, verified event fan-out, or automation command seam. Issue #127 established GitHub Project fields as desired scheduling state and Factory persistence as operational truth.

## Present

This package owns binding configuration, Project item normalization, eligibility, durable invalidation requests and diagnostics, deployment-wide execution ownership, reconciliation, and status projection. `@rlabs/factory-integration` owns credential injection, provides the narrow GraphQL transport, and composes this integration with the one upstream `GithubIntegration`. Workspace-to-repository mappings are enforced; path, command, and per-workspace concurrency overrides are rejected until the pinned Factory boundary can enforce them.

## Direction

Keep one integration instance for many bindings, one Factory deployment for many logical projects, and one execution owner per GitHub content node. Extend graph sequencing and lifecycle projection through the same durable reconcile protocol without importing agent/runtime definitions or recreating Factory internals.
