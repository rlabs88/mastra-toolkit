# RT88-70 orchestration-layer hook and routing audit

## Current layering validation

- Connector channels are attached to `orchestratorAgent` (`orchestratorAgent.channels = createSupervisorChannelsConfig()`), making orchestrator the runtime ingress layer for connector entrypoints.
- `supervisorAgent` remains defined as a secondary orchestration profile and is still available through the harness mode registry.
- Both `orchestratorAgent` and `supervisorAgent` are configured with specialist subagents (`scout`, `researcher`, `architect`, `advisor`, `developer`, `validator`), so either orchestration layer can delegate.
- Both orchestration agents register `delegation.onDelegationStart` and `delegation.onDelegationComplete` through `createDelegationObservabilityOptions(...)`.
- Both orchestration agents own the shared workspace directly; specialist harness modes inherit the same workspace from `createMastraAgentHarness()`.

## Delegation observability implications

- Delegation observability is implemented at the orchestration agent call boundary by hook registration, then surfaced in the shared async job streaming pipeline (`streamHarnessMessage`) as `delegation-event` chunks.
- Because both orchestration layers register the same hook factory, orchestrator and supervisor delegation behavior is inspectable through the same ACP mapping.
- ACP maps `delegation-event` into `tool_call_update`, and now uses a uniqueness-preserving fallback ID derived from phase + correlation fields + timestamp.

## Remaining gap

- A full live LLM delegation smoke remains environment-dependent. The focused local spec verifies hook payload emission, structured payload preservation, numeric timestamp fallback IDs, and ACP mapping without requiring provider credentials.
