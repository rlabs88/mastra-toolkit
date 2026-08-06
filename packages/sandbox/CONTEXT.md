---
kind: checkpoint-context
version: 1
scope: "packages/sandbox/**"
status: active
---

# Sandbox Context

## Past

Sandbox parsing and provider construction originally lived under the root application and imported the aggregate toolkit configuration type. This coupled Local, Docker, and Platform adapters to unrelated host configuration.

## Present

This package owns the validated sandbox specification, its checked-in schema and default configuration, the canonical runtime-profile manifest, environment projection, the cloneable machine contract, remote runtime admission, narrow provider credentials, the three provider adapters, and the executable `command_run` Mastra tool. `command_run` resolves the active request workspace and executes only through its sandbox. Applications may select a workspace root and supply runtime-only Platform credentials.

## Future

Ephemeral and persistent environment compositions can consume the same contract while adding their own package layers and credential delivery. Provider fallback, baked credentials, and application-specific configuration remain non-goals.
