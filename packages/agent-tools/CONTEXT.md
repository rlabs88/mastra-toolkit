---
kind: checkpoint-context
version: 1
scope: "packages/agent-tools/**"
status: active
---

# Agent Tools Package Context

## Past

Command Run, exploratory fan-out, browser policy, and tool audit behavior began under the root `src/` tree beside role composition. Extracting them creates a reusable capability boundary without making tools depend on any agent persona or host adapter.

## Present

This private package exposes one root facade over three deep modules: host-neutral browser/audit/run-containment capabilities, dynamic workflow authoring, and the public facade. It owns no command execution language or divergent-fan-out tool. Role packages consume these hooks and tools; native workspace execution, Mastra Code projections, and Factory behavior remain outside this boundary.

`dynamic_workflow` earns its own module because it carries a versioned authoring schema, a retention policy over persisted definitions, an action-dependent approval predicate, and a content-addressed audit identity — four lifecycles that change independently of the capabilities module. It accepts a declarative graph rather than source, so nothing it admits is executable in its own right; the host injects which agents and nested workflows a graph may reference. Authored definitions are removed from the live registry after their last in-flight run and archived immediately; boot reconciliation closes the crash window before worker discovery.

## Future

Hosts may add tools through their own adapters, while the guarded execution and approval semantics here remain stable. New capability families should join this package only when they are role-independent and have package-local containment and failure contracts. `dynamic_workflow` is the sanctioned durable orchestration path; the removed compatibility tools must not be restored as alternate execution surfaces.
