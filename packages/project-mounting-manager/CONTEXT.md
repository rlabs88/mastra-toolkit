---
kind: checkpoint-context
version: 1
scope: "packages/project-mounting-manager/**"
status: active
---

# Project Mounting Manager Context

## Past

Project specialist, workflow, MCP, and watcher behavior first lived inside the root application's Mastra Code runtime. Direct Code SDK and host registration dependencies made the mounting behavior difficult to reuse safely from another host.

## Present

This package owns project specialist and workflow discovery, explicit workflow-tool publication, generation state, diagnostics, resource watching, and the transactional mounting facade. Its root Interface exposes deep contract, discovery, and manager Modules. Host-specific model lookup, MCP connections, current tool enumeration, and registry mutation enter through ports defined by the contract Module.

## Future

Studio, local Code, and Factory adapters can share this mounting contract while retaining their own lifecycle and policy. Cross-project scheduling and a new project manifest remain outside this boundary.
