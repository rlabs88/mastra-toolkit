---
kind: checkpoint-context
version: 1
scope: "packages/factory-integration/**"
status: active
---

# Factory Integration Package Context

## Past

Factory construction, authentication, provider preparation, storage, canonical agents, and sandbox selection were coupled through the root source tree.

## Present

This package adapts canonical RLabs runtime packages to Mastra Factory. It owns Factory-specific lifecycle and persistence while applications and deployment targets remain separate boundaries.

## Future

Factory will first provision and resume the same single-project runtime, then scale it across isolated projects. Cross-project control-plane behavior will not redefine agents, workflows, project formats, or sandbox contracts.
