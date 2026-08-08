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

This package is the reusable adapter for RLabs' extended Mastra Code runtime. Its root interface exposes controller projections, project adapters, and runtime lifecycle. The MCode projection mounts non-recursive canonical agents in two modes per canonical role and exposes exactly Cortex, Flux, Zen, and Ayra through the existing controller's native `subagent` tool. Mode and subagent ids derive from the canonical role registry rather than a literal list, so adding a role projects it into both without a change here. The Studio projection additionally registers each canonical top-level agent as a generic Mastra supervisor over the canonical leaves. `McodeRecipeV2` remains a deprecated compatibility alias. Factory is a sibling adapter over the same shared contract. Runtime defaults are resolved once and passed into the contract; request-local identity, workspace, sandbox, browser, and approval values stay in the binding. MCode does not own the executable process or fork upstream source.

Host tool grants are intentional, never incidental. `RESERVED_HOST_TOOL_IDS` names the ids the host owns outright, and MCode passes them to the project mounting manager as `reservedToolIds` rather than as publishable tools. The manager claims those ids into its collision set before merging any snapshot, so a project workflow or MCP server that would shadow a host tool is still rejected while the reserved tool itself never becomes publishable. That single chokepoint governs both the published tool map and the project specialists, so MCode deliberately keeps no second filter on the `getTools()` bridge: a downstream filter would be unreachable by construction, and if the reservation were ever dropped it would restore containment for role agents while leaving specialists exposed. The capability descriptor records the `dynamic_workflow` ceilings — dispatchable agent ids derived from the role registry, the nested-workflow policy, and the reserved ids — so widening any of them moves the digest.

Startup order is load-bearing. `reconcileDynamicWorkflowDefinitions` archives crash-orphaned model-authored definitions and must run before `ProjectMountingManager.create` and before the controller mount reaches `startWorkers()`, which live-registers every still-active row. It fails open when the host exposes no workflow definition store.

Which roles hold `dynamic_workflow` is decided outside this package. `agents-roles` owns that projection and grants it to every canonical supervisor — Cortex, Flux, Zen, and Ayra — while withholding it from Studio leaves, which sit at the bottom of the delegation tree. Before that grant existed, Flux reached the tool only through the bridge leak; closing the leak removed its access entirely until the projection was corrected. Any further canonical role inherits the grant from that projection, never from this package.

### Skill discovery scans the user's home Claude directory

`createMcodeWorkspace` scans `~/.claude/skills` in addition to the workspace-local roots and the home `.agents` and `.mastracode` roots. This was added deliberately so Ayra can reach the `graph-engineering` and `loop-engineering` skills, which live there under the Claude Code convention. The workspace already scanned `<workspace>/.claude/skills`; omitting the home counterpart was an asymmetry, not a policy.

Three consequences were weighed and accepted rather than discovered:

- The user's entire personal skill directory is mounted, not just the two skills Ayra needs. On the reference machine this took the resolved set from 29 skills to 108.
- The resolved skill set therefore becomes machine-dependent. Two developers on the same commit can see different skills. Any contract that must hold everywhere has to assert named skills, never a count.
- Two skills in that directory, `archon` and `archon-dev`, fail Mastra's skill metadata validation because their `description` exceeds 1024 characters. `WorkspaceSkills` logs `Invalid skill metadata` and skips them; loading continues and every other skill resolves. **This is expected output, not a defect to debug.** Fixing it means shortening those descriptions at the source, which is outside this repository.

The home skill roots feed both `Workspace.skills` and `LocalFilesystem.allowedPaths`, and they are derived from one list in `project.ts` because they must agree. A path present in only one silently resolves zero skills and logs a permission warning instead of failing, so `packages/mcode/test/workspace-skills.test.ts` asserts the resolution outcome for named skills rather than asserting the configuration.

## Future

MCode may add supported Code extensions and richer workflow visualization. It will continue to consume the canonical role and project contracts rather than developing alternate prompts, tools, or configuration systems.
