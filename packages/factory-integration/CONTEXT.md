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

This package binds the versioned `ToolkitRuntimeContract` into Mastra Factory without importing MCode. Its four-module facade owns the Factory controller projection, request-local binding, configuration-backed infrastructure, integrations, and the complete Factory/Mastra runtime lifecycle while the application owns signal handling only. Factory retains exactly one upstream-owned controller and one built-in GitHub source-control integration. Optional GitHub Projects V2 configuration requires that canonical GitHub integration, injects the temporary Projects GraphQL credential at the host boundary, and registers the `factory-github-projects` storage domain, verified-webhook observer, and scheduler worker without duplicating webhook verification. The control plane can omit repository execution; enabled repository execution consumes the shared sandbox machine as a fleet template and persists project/user/session bindings. Ephemeral development and persistent operations are explicit, fail-closed runtime profiles. Factory still exposes no modes, subagents, or controller-construction callback, so diagnostics explicitly report canonical delegation as upstream-blocked and the integration exposes neither role-specific delegation tools nor an unsafe neutral adapter.

## Future

Factory must mount the shared contract's canonical modes and native subagents once an official upstream construction seam exists, then add request-aware sandbox adapters for the explicitly unsupported repository configuration surfaces. No Mastra fork, dependency patch, second controller, or host-checkout fallback is part of that path. Only after the single-project contract is proven may it scale across isolated projects.
