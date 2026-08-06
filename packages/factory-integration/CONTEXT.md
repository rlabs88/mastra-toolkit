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

This package adapts canonical RLabs runtime packages to Mastra Factory. It owns Factory-specific lifecycle and persistence while applications and deployment targets remain separate boundaries. Factory startup now selects an explicit ephemeral-development or persistent-operations project-runtime profile; the persistent profile fails closed without Platform isolation, durable Factory state, deployment authentication, and the approved runtime secret-provider reference.

## Future

Factory will next verify the control-plane/data-plane seam for one project: centralized orchestration with repository execution bound to one persisted sandbox-backed session workspace. An in-sandbox agent/workflow worker is added only if that slice demonstrates a real execution gap. Factory can then scale the verified runtime across isolated projects without redefining agents, workflows, project formats, or sandbox contracts.
