---
kind: checkpoint-context
version: 1
scope: "packages/agents-roles/**"
status: active
---

# Agent Roles Package Context

## Past

Cortex, Flux, and Zen were defined together under root `src/agents`, where prompts, host wiring, Code projections, and reusable tool behavior could drift across consumers. This boundary separates canonical role behavior from those hosts.

## Present

This private package owns four role definitions, their exact prompt content and composition contract, and the host-neutral registry that creates both non-recursive canonical leaves and canonical supervisors over those leaves. Four cohesive source modules group role policy, prompt policy, agent construction, and the single public facade without one-file role directories or implementation subpaths. It consumes tool behavior and runtime model configuration through package exports and does not own host projections or AgentController subagent definitions.

Ayra joined Cortex, Flux, and Zen as the orchestration archetype: it provisions domain-focused agents for a goal, declares the graph or loop that connects them, and owns the combined result. It is the primary author of dynamic workflows, so every canonical role now receives the host-constructed `dynamic_workflow` tool. Flux's earlier omission recorded a rationale that no longer exists — it was kept on a separate run tool that has since been deleted. Registry leaves are the one place the tool is withheld, because the tool's depth guard keys off the request context its own dispatch sets and a supervisor-to-leaf hop never sets it.

Every role prompt now distinguishes the two delegation surfaces: the native `subagent` tool for one bounded delegation inside the turn, and `dynamic_workflow` for a durable declared graph. Ayra additionally reaches for the workspace-supplied `graph-engineering` and `loop-engineering` skills. Skills are a `Workspace` property, not an agent property, so no per-agent skill wiring exists in this package.

## Future

Studio, Factory, and Mastra Code adapters can consume these definitions and the supervisor/leaf registry without copying prompts. Host-specific modes, AgentController leaf projections, and lifecycle policy remain downstream even as additional canonical roles or prompt revisions are introduced here.

Ayra's model policy still resolves through a temporary fallback to the Cortex alias because `@rlabs/runtime-config` has not yet published an `ayra` entry in its model profile schema. That fallback is marked in `agents.ts` and must be deleted as soon as the mapping lands.
