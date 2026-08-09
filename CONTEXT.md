---
kind: checkpoint-context
version: 1
scope: "**"
status: active
---

# Mastra Toolkit Context

## Past

This repository began as a broader Mastra system and accumulated experiments around agent prompts, channel adapters, ACP, Factory, sandbox providers, and terminal interfaces. It was restarted as `mastra-toolkit` to reduce that surface to an RLabs-owned agent runtime and a Mastra Factory adapter. The restart established Cortex, Flux, and Zen, a guarded Command Run tool, shared workspace behavior, and Local, Docker, and Platform sandbox providers.

The repository initially had an instruction file without the matching narrative checkpoint. Mastra Code customization also evolved in a separate private wrapper, which made it possible for Studio and the terminal host to drift in prompts, models, and runtime defaults.

## Present

The repository is an npm workspace with thin `mcode`, `mz`, Studio, and Factory application paths. Canonical roles, tools, model configuration, sandbox behavior, and project mounting have explicit package owners. `mastra-primitives-export` aggregates those public contracts into one versioned, deterministic, secret-free runtime contract; MCode, Studio, and Factory bind request-scoped identity, workspace, sandbox, browser, and approval context through sibling host projections. Embedded `mcode` remains local, while `mz` supervises or attaches to a project-scoped Studio runtime and uses a remote Mastra Code TUI. Studio owns that controller, persisted sessions, mounted resources, and local-only traces. Factory remains separate and retains its one upstream-owned controller. `project-mounting-manager` hot-loads project specialists, workflows, and MCP as validated generations. `factory-github-projects` owns GitHub Projects V2 bindings, leases, reconciliation, and scheduling and is composed only by `factory-integration`. Package-local checkpoint pairs record the purpose and rules of every ownership boundary.

Mastra Code itself is developed inside the upstream `mastra-ai/mastra` monorepo. The existing private `rlabs88/mastra-code` repository is a public-API wrapper around the published `mastracode` package, not a fork of the upstream source. This distinction shapes the target layout: wrappers belong with applications, while framework and TUI source deltas belong in one pinned Mastra monorepo fork.

## Future

The accepted [executive direction](docs/executive-direction.md) treats Mastra as the mid-loop development layer above deterministic tests for RLabs closed-loop systems. It progresses from the current shared harness to one local Mastra Code runtime and sandbox per project checkout, then to a single-project Factory deployment, and only then to a multi-project Factory control plane.

The product monorepo continues toward one project runtime per checkout, then a single-project Factory deployment, and finally an isolated multi-project control plane. Mastra Code conventions remain authoritative for instructions, skills, hooks, commands, and plugins; the project mounting manager adds only the currently missing specialist, workflow, and transactional MCP generation contract. A typed, secret-free YAML model profile remains the input to every host adapter.

Sandbox builds become a separate top-level boundary with reusable package layers and explicit ephemeral and persistent environment compositions. Persistent environments gain stronger operational controls and runtime secret delivery without turning images or repository configuration into credential stores.

GitHub Projects V2 is an optional Factory control-plane integration activated by validated binding policy and a host-injected runtime token. It schedules governed Factory work but never owns agents, sessions, workspaces, sandboxes, GitHub credentials, or webhook verification. Unsupported workspace execution overrides fail startup instead of becoming advisory metadata. Agent-facing API capabilities remain request-scoped tools backed by injected ports; control-plane APIs do not become agent tools.

Upstream source remains exceptional. One Mastra monorepo fork covers both framework and Mastra Code TUI changes. A separate desktop `mastra-code-ui` fork remains an option only if desktop interface work begins. Published packages and public extension APIs remain the ordinary integration path.
