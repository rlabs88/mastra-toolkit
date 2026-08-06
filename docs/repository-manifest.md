# Repository Manifest

This manifest is the routing table for changes. A package owns a reusable contract; an application owns only process and host composition; a deployment folder owns environment-specific delivery.

| Boundary | Owns | Consumes | Extensions belong here when… |
| --- | --- | --- | --- |
| `packages/runtime-config` | model profile, aliases, environment resolution, proxy gateway | Mastra core, YAML, Zod | the change is host-neutral model or runtime configuration |
| `packages/agent-tools` | Command Run, ADHD, visible browser policy, tool audit hooks | Mastra core and Stagehand | a capability is reusable independent of role and host |
| `packages/agents-roles` | Cortex/Flux/Zen prompts, role metadata, agent factory | `agent-tools`, `runtime-config` | the canonical agent identity or policy changes |
| `packages/sandbox` | sandbox schema/config, machine contract, Local/Docker/Platform adapters | Mastra sandbox providers | provider behavior or the common containment contract changes |
| `packages/project-mounting-manager` | specialist/workflow discovery, explicit publication, generations, watcher, transaction ports | Mastra core only | project resources must mount consistently across hosts |
| `packages/mcode` | Code modes/subagents/settings, controller mount, MCP and host adapters, session/TUI runtime | roles, config, sandbox, mounting manager, published Code APIs | RLabs extends Mastra Code without changing upstream source |
| `packages/factory-integration` | Factory auth, storage, provider migration, delegation, sandbox provisioning | roles, MCode provider surface, config, sandbox | behavior exists only because the host is Mastra Factory |
| `apps/mcode` | CLI process and exit lifecycle | `mcode` | command parsing or executable UX changes |
| `apps/studio` | Studio/server composition | `mcode` prepared runtime | Studio transport or server lifecycle changes |
| `apps/factory` | Factory composition root | `factory-integration`, roles | Factory process bootstrap changes |
| `deployment/mcode-sandbox` | ephemeral-development and persistent-operations image source, profile identity, runtime probes, native validation, rollback policy | immutable AES/OPS bases and canonical sandbox profiles | Factory workspace packaging or its deployment evidence changes |
| `deployment/studio-server` | central Studio target intent | approved application artifacts | a concrete Studio server delivery is approved |

## Dependency rules

- Applications may depend on packages; packages never depend on applications.
- `agents-roles` may depend on `agent-tools` and `runtime-config`, but host adapters do not flow back into canonical roles.
- `project-mounting-manager` stays independent of Code SDK, Factory, and TUI types; adapters implement its ports.
- `mcode` must not import Factory. `factory-integration` may consume only narrow public MCode provider/settings exports.
- Deployment targets consume built applications and packages; runtime source does not import deployment policy.
- Upstream forks are not workspace dependencies unless a reviewed, pinned fork build replaces a published package at the package-manager boundary.

## Project-owned mount space

The containing checkout remains the configuration unit. Mastra Code continues to own its native instructions, skills, hooks, commands, plugins, MCP file precedence, and settings. The mounting manager consumes `.mastracode/agents`, `.github/agents`, and `.mastracode/workflow` and publishes only validated resources. Git submodules do not inherit executable trust automatically.

## Checkpoint rule

Every package has its own `AGENTS.md` and `CONTEXT.md`. Applications share the `apps/` checkpoint because they are deliberately thin. Each deployment target has a deeper checkpoint because its operational and credential policy can diverge. Add another checkpoint only when a real ownership boundary requires entrants to recalibrate.
