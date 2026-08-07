---
kind: checkpoint-context
version: 1
scope: "packages/mastra-primitives-export/**"
status: active
---

# Mastra Primitives Export Context

## Past

MCode's recipe aggregated canonical agents, modes, tools, model defaults, and a capability digest. Studio reused the local MCode runtime, while Factory constructed canonical agents independently and could not prove that every host consumed one equivalent contract.

## Present

This package is the host-neutral aggregation boundary over canonical role, tool/rule, runtime-config, sandbox-machine, and project workspace-resolution contracts. It exposes a versioned, deterministic capability descriptor and the binding shape hosts use for live execution values. It owns no controller or host lifecycle.

## Future

MCode, Studio, and Factory projections will continue to consume this contract while each host constructs exactly one controller. Factory-native mode and subagent projection remains gated on a supported upstream constructor input; the shared contract must not grow Factory lifecycle concerns to work around that gap.
