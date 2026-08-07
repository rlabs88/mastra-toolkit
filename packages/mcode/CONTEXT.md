---
kind: checkpoint-context
version: 1
scope: "packages/mcode/**"
status: active
---

# MCode Package Context

## Past

The RLabs Mastra Code wrapper lived across `src/code`, agent mode files, Factory provider helpers, and the generic project runtime. That made Code-specific configuration appear canonical and coupled local mounting to Factory implementation details.

## Present

This package is the reusable adapter for RLabs' extended Mastra Code runtime. Its root interface exposes controller projections, project adapters, and runtime lifecycle. The MCode projection mounts non-recursive canonical agents in six modes and exposes exactly Cortex, Flux, and Zen through the existing controller's native `subagent` tool. The Studio projection additionally registers each canonical top-level agent as a generic Mastra supervisor over the three canonical leaves. `McodeRecipeV2` remains a deprecated compatibility alias. Factory is a sibling adapter over the same shared contract. Runtime defaults are resolved once and passed into the contract; request-local identity, workspace, sandbox, browser, and approval values stay in the binding. MCode does not own the executable process or fork upstream source.

## Future

MCode may add supported Code extensions and richer workflow visualization. It will continue to consume the canonical role and project contracts rather than developing alternate prompts, tools, or configuration systems.
