# Mastra capability research matrix

Validated against the versions pinned in `package.json` on 2026-08-02. Production code uses supported Mastra seams; custom code exists only where the `just-oc` contract is stricter.

| Requirement | Mastra capability | Decision |
|---|---|---|
| Cortex, Flux, Zen | `Agent`, `agents`, delegation hooks, request context | Native agents; preserve the six-section prompts and expose Zen-only delegation. |
| Per-agent limits | `defaultOptions.maxSteps` and `modelSettings` | Native. |
| Tool approval | Dynamic `Tool.requireApproval` and `requireToolApproval` | Native lifecycle; toolkit predicates classify Command Run batches and browser actions. |
| Background work | Tool `background`, agent `backgroundTasks`, Mastra background manager | Native; no OpenCode background-task plugin. |
| Browser/CUA | `StagehandBrowser` and automatic browser tools | Native visible local Chrome; mutations require approval. |
| Workspace commands/media | Workspace tools include command execution and media-aware file reads | Use native tools generally; retain Command Run as a compatibility facade for ordered batches and exact limits. |
| Command batching | No native 1–20 child dependency-step scheduler | Port parser/scheduler/trace with Node process adapters. |
| Path and SSRF policy | Contained filesystem plus provider-specific sandboxing | Keep toolkit boundary checks in addition to native containment. |
| Flux ADHD | Parallel subagents exist, but no identical divergent instrument | Thin tool using isolated Flux branches and a depth guard. |
| Tool audit | Agent/workspace hooks and Mastra tracing | Native hooks with structured toolkit audit events. |
| Local sandbox | `LocalSandbox.clone()` and native OS isolation detection | Native. |
| Docker sandbox | `@mastra/docker` `DockerSandbox.clone()` | Native, hardened toolkit image. |
| Platform sandbox | `PlatformSandbox.clone()` | Native, configuration-gated. |
| Factory extension | `FactoryIntegration.agentTools`, routes, diagnostics, workers | Native integration contributes Cortex/Flux/Zen delegation tools. |
| Factory persistence | `LibSQLFactoryStorage` and `PgFactoryStorage` | LibSQL default; Postgres/Redis optional profile. |
| GitHub Factory | `GithubIntegration` | Native dedicated GitHub App integration. |
| WorkOS auth | `MastraAuthWorkos` and `SimpleAuth` | Native WorkOS in production; development Factory uses a synthetic local tenant and standalone remains authless. |
| Zellij | Host UI concern | Omitted. |

Primary references: Mastra package type declarations, the official `softwarefactory-template`, and the `just-oc` agent/tool contracts. The executable evidence is the contract suite under `test/`.
