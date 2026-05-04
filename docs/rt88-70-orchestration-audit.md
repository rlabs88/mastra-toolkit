# RT88-70 orchestration-layer hook and routing audit

## Current layering validation

- Connector channels are attached to `orchestratorAgent` (`orchestratorAgent.channels = createSupervisorChannelsConfig()`), making orchestrator the runtime ingress layer for connector entrypoints.
- `supervisorAgent` remains defined as a secondary orchestration profile and is still available through the harness mode registry.
- Both `orchestratorAgent` and `supervisorAgent` are configured with specialist subagents (`scout`, `researcher`, `architect`, `advisor`, `developer`, `validator`), so either orchestration layer can delegate.

## Delegation observability implications

- Delegation observability is implemented in the shared async job streaming pipeline (`streamHarnessMessage`) by emitting `delegation-event` chunks from delegation lifecycle events.
- Because both orchestration layers run through the same harness/event stream path, no additional per-agent wiring is required for delegation event emission.
- ACP maps `delegation-event` into `tool_call_update`, and now uses a uniqueness-preserving fallback ID derived from phase + correlation fields + timestamp.

## Remaining gap

- If future runtime changes bypass the shared harness stream path for one orchestrator profile, explicit hook registration at that profile should be reintroduced and covered with a focused integration test.
