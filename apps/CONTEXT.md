---
kind: checkpoint-context
version: 1
scope: "apps/**"
status: active
---

# Application Hosts Context

## Past

Mastra Code, Studio, and Factory bootstraps previously shared the root `src/` tree, allowing host lifecycle concerns to mix with canonical agents, configuration, project mounting, and sandbox behavior.

## Present

This boundary contains three private composition roots. `mcode` exposes the RLabs CLI built on published Mastra Code APIs, `studio` boots the central or local Studio host, and `factory` boots Mastra Factory. Reusable behavior remains in workspace packages.

## Future

Applications may gain host-specific transport or presentation behavior, but they will remain thin consumers. They will not become alternate sources for agents, tools, project configuration, deployment policy, or sandbox implementations.
