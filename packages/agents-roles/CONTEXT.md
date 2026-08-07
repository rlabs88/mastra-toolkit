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

This private package owns the three role definitions, their exact prompt content and composition contract, and the host-neutral registry that creates both non-recursive canonical leaves and canonical supervisors over those leaves. Four cohesive source modules group role policy, prompt policy, agent construction, and the single public facade without one-file role directories or implementation subpaths. It consumes tool behavior and runtime model configuration through package exports and does not own host projections or AgentController subagent definitions.

## Future

Studio, Factory, and Mastra Code adapters can consume these definitions and the supervisor/leaf registry without copying prompts. Host-specific modes, AgentController leaf projections, and lifecycle policy remain downstream even as additional canonical roles or prompt revisions are introduced here.
