# Repository Manifest

This manifest is the routing table for changes. A package owns a reusable contract; an application owns only process and host composition; a deployment folder owns environment-specific delivery.

| Boundary | Owns | Consumes | Extensions belong here when… |
| --- | --- | --- | --- |
| `packages/runtime-config` | model profile, aliases, environment resolution, host data paths, proxy gateway | Mastra core, YAML, Zod | the change is host-neutral model or runtime configuration |
| `packages/agent-tools` | library-only Command Run/ADHD compatibility contracts, visible browser policy, tool audit hooks | Mastra core and Stagehand | a capability contract is reusable independent of role and host |
| `packages/agents-roles` | Cortex/Flux/Zen prompts, role metadata, agent factory | `agent-tools`, `runtime-config` | the canonical agent identity or policy changes |
| `packages/sandbox` | sandbox schema/config, machine contract, Local/Docker/Platform adapters, library-only `command_run` adapter | Mastra sandbox providers and agent-tools command contracts | provider behavior or sandbox-contained execution changes |
| `packages/project-mounting-manager` | specialist/workflow discovery, explicit publication, generations, watcher, transaction ports | Mastra core only | project resources must mount consistently across hosts |
| `packages/mastra-primitives-export` | versioned runtime contract, binding interfaces, deterministic capability descriptor and digest | roles, tools, config, sandbox, mounting manager | hosts need one verified aggregation of canonical runtime primitives |
| `packages/mcode` | MCode/Studio controller projections, Code modes/subagents/settings, controller mount, MCP and host adapters, session/TUI runtime | primitives export, sandbox, mounting manager, published Code APIs | RLabs extends Mastra Code without changing upstream source |
| `packages/factory-integration` | Factory runtime binding and controller projection, auth, storage, compatibility diagnostics, sandbox provisioning, future control-plane composition | primitives export, config, sandbox | behavior exists only because the host is Mastra Factory |
| `apps/mcode` | CLI process and exit lifecycle | `mcode` | command parsing or executable UX changes |
| `apps/studio` | deployer-required top-level Mastra construction and server exports | `mcode` prepared host facade | Studio transport or server lifecycle changes |
| `apps/factory` | Factory composition root and process lifecycle | `factory-integration` | Factory process bootstrap changes |
| `deployment/mcode-sandbox` | ephemeral-development and persistent-operations image source, profile identity, runtime probes, native validation, rollback policy | immutable AES/OPS bases and canonical sandbox profiles | Factory workspace packaging or its deployment evidence changes |
| `deployment/studio-server` | central Studio target intent | approved application artifacts | a concrete Studio server delivery is approved |

## Dependency rules

- Applications may depend on packages; packages never depend on applications.
- `agents-roles` may depend on `agent-tools` and `runtime-config`, but host adapters do not flow back into canonical roles.
- `project-mounting-manager` stays independent of Code SDK, Factory, and TUI types; adapters implement its ports.
- `mastra-primitives-export` aggregates canonical package-root contracts by reference and remains independent of MCode, Factory, applications, credentials, live SDK clients, and controllers.
- `mcode` and `factory-integration` are sibling host adapters. Neither imports the other; both consume the shared runtime contract and supply host-local bindings.
- Canonical agents receive capabilities as narrow, request-scoped tool ports. They never import host clients, control-plane schedulers, storage implementations, or credentials.
- A future `factory-github-projects` package may own GitHub Projects V2 bindings, leases, reconciliation, and scheduling. Only `factory-integration` may compose it; it must not import agents, agent tools, MCode, project mounting, or sandbox implementations.
- Deployment targets consume built applications and packages; runtime source does not import deployment policy.
- Issue #125 does not permit an upstream fork, dependency patch, or copied Factory controller implementation.
- Exactly one host-owned controller may exist per runtime. Factory canonical mode/native-subagent mounting remains blocked until an official upstream construction seam exists.

## Project-owned mount space

The containing checkout remains the configuration unit. Mastra Code continues to own its native instructions, skills, hooks, commands, plugins, MCP file precedence, and settings. The mounting manager consumes `.mastracode/agents`, `.github/agents`, and `.mastracode/workflow` and publishes only validated resources. Git submodules do not inherit executable trust automatically.

## Checkpoint rule

Every package has its own `AGENTS.md` and `CONTEXT.md`. Applications share the `apps/` checkpoint because they are deliberately thin. Each deployment target has a deeper checkpoint because its operational and credential policy can diverge. Add another checkpoint only when a real ownership boundary requires entrants to recalibrate.
