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

This private package exposes one root facade over four deep modules: host-neutral capabilities, the Command Run contract, Command Run execution, and dynamic workflow authoring. It owns parsing, scheduling, approval, trace, and result behavior plus ADHD, visible-browser, and audit policies. The executable Command Run tool belongs to `packages/sandbox`, where execution requires a sandbox workspace. Role packages consume the root facade; Mastra Code and Factory behavior remain outside this boundary.

`dynamic_workflow` earns its own module because it carries a versioned authoring schema, a retention policy over persisted definitions, an action-dependent approval predicate, and a content-addressed audit identity — four lifecycles that change independently of the capabilities module. It accepts a declarative graph rather than source, so nothing it admits is executable in its own right; the host injects which agents and nested workflows a graph may reference. Authored definitions are archived immediately because only active definitions load at `startWorkers()`, and discovery must never grant execution authority.

## Future

Hosts may add tools through their own adapters, while the guarded execution and approval semantics here remain stable. New capability families should join this package only when they are role-independent and have package-local containment and failure contracts.

`dynamic_workflow` is the sanctioned replacement path for `adhd_run` fan-out. Retirement waits until a parity contract test covers bounded concurrency, index-stable ordering, retained-output limits, and the depth guard, and until the approval and read-only differences between the two are deliberately resolved rather than dropped.
