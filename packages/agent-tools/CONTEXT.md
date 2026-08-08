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

This private package exposes one root facade over three deep modules: host-neutral browser/audit/run-containment capabilities, dynamic workflow authoring, and the public facade. It owns no command execution language or divergent-fan-out tool. Role packages consume these hooks and tools; native workspace execution, Mastra Code projections, and Factory behavior remain outside this boundary.

`dynamic_workflow` earns its own module because it carries a versioned authoring schema, a retention policy over persisted definitions, an action-dependent approval predicate, and a content-addressed audit identity — four lifecycles that change independently of the capabilities module. It accepts a declarative graph rather than source, so nothing it admits is executable in its own right; the host injects which agents and nested workflows a graph may reference. Authored definitions are removed from the live registry after their last in-flight run and archived immediately; boot reconciliation closes the crash window before worker discovery.

The tool is background-eligible by default. Its model-facing contract directs executable `run` and `resume` calls to preserve that default, while validation-only `run` calls and `inspect` may execute in the foreground. Mastra intentionally exposes a per-call `_background` override to the model, so this is strong tool guidance rather than framework-enforced immutability; the toolkit does not fork Mastra to remove that supported behavior.

Stored workflow agent entries use Mastra's regular agent-stream contract, while this host registers durable agent wrappers. Registration therefore rehydrates the stored graph through a resolver that unwraps each durable registration to its canonical regular agent. Each nested invocation receives an isolated workflow-owned memory thread and resource before its configured processors run. That compatibility layer uses Mastra's public rehydration and registry APIs: it neither duplicates the agent definition nor writes nested agent messages into the parent session thread.

## Future

Hosts may add tools through their own adapters, while the guarded execution and approval semantics here remain stable. New capability families should join this package only when they are role-independent and have package-local containment and failure contracts. `dynamic_workflow` is the sanctioned durable orchestration path; the removed compatibility tools must not be restored as alternate execution surfaces.
