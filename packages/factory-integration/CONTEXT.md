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

This package adapts the versioned MCode recipe to Mastra Factory. It owns Factory-specific lifecycle and persistence while applications and deployment targets remain separate boundaries. The control plane can omit repository execution; enabled repository execution consumes the shared sandbox machine as a fleet template and persists project/user/session bindings. Ephemeral development and persistent operations are explicit, fail-closed runtime profiles. Until upstream Factory accepts controller-construction ingredients, diagnostics explicitly report canonical mode/native-subagent mounting as unsupported.

## Future

Factory must consume the recipe's canonical modes and native subagents once an official upstream construction seam exists, then add request-aware sandbox adapters for the explicitly unsupported repository configuration surfaces. No Mastra fork, dependency patch, second controller, or host-checkout fallback is part of that path. Only after the single-project contract is proven may it scale across isolated projects.
