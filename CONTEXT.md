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

The repository is a single Node package. `src/agents`, `src/tools`, and `src/runtime` contain the canonical implemented agent behavior; `src/mastra` boots Studio or Factory; `src/factory/code-sdk.ts` already connects the Factory Code SDK to the A1 CLIProxy-compatible provider without persisting its key. Configuration remains environment-driven, and the repository does not yet contain workspace packages or checked-out upstream forks.

Mastra Code itself is developed inside the upstream `mastra-ai/mastra` monorepo. The existing private `rlabs88/mastra-code` repository is a public-API wrapper around the published `mastracode` package, not a fork of the upstream source. This distinction shapes the target layout: wrappers belong with applications, while framework and TUI source deltas belong in one pinned Mastra monorepo fork.

## Future

The accepted [executive direction](docs/executive-direction.md) treats Mastra as the mid-loop development layer above deterministic tests for RLabs closed-loop systems. It progresses from the current shared harness to one local Mastra Code runtime and sandbox per project checkout, then to a single-project Factory deployment, and only then to a multi-project Factory control plane.

The target remains a product monorepo with thin Studio, Factory, and Mastra Code applications consuming a small set of canonical RLabs packages. Agent definitions, prompts, tools, workflows, and runtime defaults converge on one agent-runtime boundary. Mastra Code's existing project conventions remain authoritative for instructions, skills, MCP, hooks, commands, and plugins; the toolkit does not introduce a second project manifest. A typed, secret-free YAML model profile remains the input to host-specific adapters for Mastra Studio, Factory, and Mastra Code.

Sandbox builds become a separate top-level boundary with reusable package layers and explicit ephemeral and persistent environment compositions. Persistent environments gain stronger operational controls and runtime secret delivery without turning images or repository configuration into credential stores.

Upstream source remains exceptional. One Mastra monorepo fork covers both framework and Mastra Code TUI changes. A separate desktop `mastra-code-ui` fork remains an option only if desktop interface work begins. Published packages and public extension APIs remain the ordinary integration path.
