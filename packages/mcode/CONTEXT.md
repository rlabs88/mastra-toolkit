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

This package is the reusable adapter for RLabs' extended Mastra Code runtime. Its versioned recipe is the MCode construction seam for canonical agents, modes, native subagents, tools, and its secret-free capability descriptor. Factory is a sibling adapter and consumes canonical agents directly. Runtime defaults remain a separate `@rlabs/runtime-config` projection consumed directly by each host. MCode projects those canonical packages into published Code SDK and TUI APIs without owning the executable process or forking upstream source.

## Future

MCode may add supported Code extensions and richer workflow visualization. It will continue to consume the canonical role and project contracts rather than developing alternate prompts, tools, or configuration systems.
