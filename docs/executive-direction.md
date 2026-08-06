# Mastra Toolkit Executive Direction

Status: accepted executive direction; implementation is staged through the linked GitHub initiative.

## Executive thesis

Mastra Toolkit is the project-scoped agentic development runtime for RLabs software. Its immediate purpose is not to replace a production closed loop such as a trading or operations system. It provides the mid-loop development layer that designs, exercises, evaluates, and repairs those systems above their deterministic test suites.

The unit of operation is a project checkout or worktree with one agent runtime and one contained sandbox. Mastra Code is the primary coding agent for that runtime. Mastra Studio and Mastra Factory are alternate hosts of the same canonical agents, tools, workflows, model defaults, and policy rather than separate sources of agent behavior.

```text
code + deterministic tests
            │
            ▼
Mastra mid-loop development runtime
agents + skills + workflows + evaluation + remediation
            │
            ▼
production closed-loop system
```

## Development progression

| Stage | Operating unit | Outcome |
| --- | --- | --- |
| Current harness | Shared Cortex, Flux, and Zen runtime with sandbox and Factory adapters | Establish one canonical agent behavior and supported Mastra integration seams. |
| Local project runtime | One embedded Mastra Code controller and sandbox per checkout or worktree | Let the coding agent develop and run project-scoped agentic workflows without requiring an HTTP server. |
| Single-project Factory | Cloneable instances of the same project runtime | Run governed development sessions with durable execution, explicit credentials, and ephemeral or persistent sandboxes. |
| Multi-project Factory | A control plane managing isolated project runtimes | Schedule and observe work across projects without sharing mutable state, credentials, or project policy. |

Each stage must preserve the contracts proven by the stage before it. Factory scale is a deployment and governance concern; it must not introduce a second prompt tree, workflow definition, or project-configuration system.

## Project runtime

Mastra Code's existing project model is the default mounting mechanism. A runtime starts from `cwd`, resolves the Git root or worktree, and consumes the conventions it already supports:

- `AGENTS.md` and `CLAUDE.md` for project instructions
- `.mastracode`, `.claude`, and `.agents` skill locations
- Mastra Code MCP, hook, command, plugin, database, and settings conventions
- programmatic Code SDK options for modes, subagents, tools, storage, memory, workspace, browser, and PubSub

The toolkit will not add a `mastra.project.yaml` manifest or mirror these settings into another schema. Contract tests may pin important upstream behavior, but Mastra Code remains the owner of its project configuration and precedence rules.

Canonical agent definitions remain code-defined and are projected into the host:

```text
canonical agents + tools + model roles
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
   Mastra Code  Studio   Factory
```

Mastra Code projects Cortex, Flux, and Zen into a namespaced AgentController mode registry. Each agent has `scope` and `build` prompt overlays, producing exactly six selections while preserving the canonical `Agent` instances and one complete tool surface per agent. Every selection must expose Mastra Code's native `subagent` tool with exactly three named targets: `cortex`, `flux`, and `zen`. Any canonical parent may delegate to any target without switching its own mode; delegated runs reuse the canonical role prompt and model mapping and remain leaves, so recursive subagent launches are unavailable. Project specialists use bounded delegation and do not enlarge this top-level registry. Generic Mastra supervisor agents use an ordinary `Agent` with an `agents` map; their lifecycle remains distinct even though both hosts consume the same canonical roles.

## Workflow execution

Workflows form the executable agentic layer above project tests. They coordinate deterministic checks, agent tasks, evaluation, approvals, and remediation while leaving the test suite as the source of functional evidence.

Mastra Code itself does not discover a workflow folder. The toolkit's `project-mounting-manager` now fills that extension gap for the embedded runtime: it compiles trusted `.mastracode/workflow/` modules, registers them with the same caller-owned Mastra instance, and exposes only workflows with explicit `agentTool` metadata through schema-validated tools. This remains distinct from Mastra's build-time `src/mastra/workflows` convention.

The first implementation adds only the workflow, specialist, MCP-generation, and reload behavior proven by this path. It reuses Mastra Code's existing discovery for instructions, skills, hooks, commands, and plugins rather than introducing a second project manifest.

Local workflow execution is in-process and does not require an HTTP server. Durable or distributed execution may later use Mastra workers, storage, and PubSub. A workflow being registered beside Mastra Code does not automatically make it agent-callable; exposure remains explicit so permissions, schemas, versions, and audit events stay controlled.

## Sandbox and Factory boundary

The local development target is one persistent sandbox per checkout or worktree. Filesystem and command tools must address the same contained checkout. Simultaneous worktrees receive distinct runtimes and sandboxes even when they share a logical project identity for history or reporting.

Factory first scales one project runtime across two explicit planes. The Factory process is the control plane: it owns authentication, durable state, integrations, scheduling, AgentController sessions, and orchestration, and Mastra Factory can boot those surfaces with repository sandboxes disabled. GitHub-backed project execution is the sandboxed data plane: one configured cloneable template/fleet provisions or reattaches isolated sandboxes for project/user/session bindings, and repository materialization, filesystem access, commands, setup, and git mutation operate against those sandbox workspaces rather than the Factory host.

The cardinality is therefore not one sandbox per Factory instance. One Factory deployment manages a fleet, while each active repository execution binding receives its own isolated or explicitly reattached sandbox. The complete Factory or AgentController process does not need to move into every sandbox; an additional in-sandbox agent/workflow worker is justified only if the single-project vertical slice demonstrates a concrete execution or public-extension gap. Only after the control-plane/data-plane contract is validated should Factory schedule the same runtime across projects.

Ephemeral sandboxes receive short-lived task credentials. Persistent operations sandboxes may receive scoped deployment credentials at runtime with audit and rotation. Secrets do not belong in repository configuration, settings snapshots, images, workflow source, or model profiles.

## Ownership and invariants

- Agent identities, prompts, tool contracts, workflow exports, model roles, and runtime policy have one canonical implementation.
- Studio, Mastra Code, and Factory own lifecycle and presentation adapters only.
- Project instructions, skills, MCP, hooks, commands, and plugins continue to use Mastra Code-compatible conventions.
- Workflow exposure is allowlisted and schema-validated; discovering source does not grant execution authority.
- Git submodules are separate repository trust boundaries. A parent checkout does not automatically activate executable configuration from every submodule.
- Published Mastra packages and public extension APIs are the default integration path. Forks exist only for a demonstrated framework or interface gap.
- Provider failures are explicit. Remote or hardened sandbox profiles do not silently fall back to a less isolated local provider.

## Success conditions

The direction is realized when:

1. Studio and Mastra Code resolve identical canonical agent prompts, tools, and model-role mappings.
2. A developer can start one local project runtime, change a trusted workflow, and invoke its approved tool surface without starting an HTTP server.
3. The same project runtime can be provisioned and resumed by Factory without changing agent or workflow definitions.
4. Multiple Factory projects remain isolated in filesystem state, credentials, runtime identity, and policy.
5. Every expansion is driven by a working vertical slice and contract evidence rather than parallel configuration systems.

## Non-goals

- A new project manifest or replacement for Mastra Code configuration
- Automatic execution of all discovered workflows, plugins, or submodule assets
- A second canonical agent tree for Studio, Code, or Factory
- A source fork before a concrete public-extension limitation is demonstrated
- Multi-project control-plane work before the single-project runtime is proven

## Supporting evidence

- [Workspace architecture](workspace-architecture.md)
- [Mastra Code mounting primitives](research/mastra-code-mounting-primitives.md)
- [Mastra Code project configuration](research/mastra-code-project-configuration.md)
- [GitHub Discussion #115](https://github.com/rlabs88/mastra-toolkit/discussions/115)

## Execution tracking

GitHub initiative: [#116 — Mastra Agentic Development Runtime](https://github.com/rlabs88/mastra-toolkit/issues/116).
