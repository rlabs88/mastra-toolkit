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

This package adapts canonical RLabs runtime packages to Mastra Factory. It owns Factory-specific lifecycle and persistence while applications and deployment targets remain separate boundaries. The control plane can omit repository execution; enabled repository execution consumes the shared sandbox machine as a fleet template and persists project/user/session bindings. Ephemeral development and persistent operations are explicit, fail-closed runtime profiles.

## Future

Factory must next execute the checkout's canonical project workflow definitions through the bound sandbox without adding a second project format or workflow registry. Only after that single-project contract is proven may it scale across isolated projects. Cross-project control-plane behavior will not redefine agents, workflows, project formats, or sandbox contracts.
