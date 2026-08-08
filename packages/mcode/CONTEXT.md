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

Host tool grants are intentional, never incidental. `RESERVED_HOST_TOOL_IDS` names the ids the host owns outright; MCode hands them to the project mounting manager as a shadow-detection snapshot and strips them back out of everything that manager republishes through `getTools()`, so a mounted project generation can never widen a per-role grant. The capability descriptor records the `dynamic_workflow` ceilings — dispatchable agent ids derived from the role registry, the nested-workflow policy, and the reserved ids — so widening any of them moves the digest.

Startup order is load-bearing. `reconcileDynamicWorkflowDefinitions` archives crash-orphaned model-authored definitions and must run before `ProjectMountingManager.create` and before the controller mount reaches `startWorkers()`, which live-registers every still-active row. It fails open when the host exposes no workflow definition store.

Two containment gaps remain outside this package. Project specialists are constructed inside `project-mounting-manager` from the merged published tool map, a sibling of `getTools()` rather than a descendant, so the bridge filter cannot reach them; closing that needs a reserved-id seam in that package. Separately, `agents-roles` grants `dynamic_workflow` to Cortex and Zen but not Flux, so Flux's access depended entirely on the bridge leak.

## Future

MCode may add supported Code extensions and richer workflow visualization. It will continue to consume the canonical role and project contracts rather than developing alternate prompts, tools, or configuration systems.
