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

This package exposes one root facade over its validated contract, explicit machine router, and consolidated provider implementations. The contract includes the checked-in schema and defaults, canonical runtime profiles, environment projection, cloneable machine options, remote admission, and narrow provider credentials. Native Mastra workspace tools are the only agent-visible file and execution surface. Applications may select a workspace root and supply runtime-only Platform credentials.

## Future

Ephemeral and persistent environment compositions can consume the same contract while adding their own package layers and credential delivery. Provider fallback, baked credentials, and application-specific configuration remain non-goals.
