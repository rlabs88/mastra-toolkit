# Mastra Toolkit

RLabs' local Mastra agent runtime and Mastra Factory adapter. It provides Cortex, Flux, and Zen through one shared runtime, with guarded repository tools, native background work, visible browser automation, and cloneable Local, Docker, or Platform sandboxes.

The [Executive Direction](docs/executive-direction.md) defines the project-runtime thesis and progression from local Mastra Code development to a multi-project Factory. The implemented ownership and fork boundaries are documented in [Workspace Architecture](docs/workspace-architecture.md), with exact consumers and extension rules in the [Repository Manifest](docs/repository-manifest.md).

## Requirements

- Node.js 22.19 or newer
- Infisical CLI authenticated to project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`
- `rg` and `git` for local Command Run
- Docker when using the Docker sandbox
- Chrome for visible computer-use

## Local project runtime

```bash
npm ci
npm run code:infisical
# or: npx mcode  (inject secrets yourself / use code:infisical)
```

This starts the Mastra Code TUI via the workspace `mcode` bin (`apps/mcode/bin/mcode.mjs`) directly in the containing Git checkout or worktree. It mounts one AgentController on one caller-owned Mastra, uses the same contained workspace for files and commands, and does not require an HTTP server. The default selection is `cortex/build`; Cortex, Flux, and Zen each expose `scope` and `build`, for exactly six selections. Press `Shift+Tab` to cycle selections, use `/mode` to list them, or use `/mode flux/build` to select one directly.

Every selection can also use Mastra Code's native `subagent` tool. Its named targets are exactly `cortex`, `flux`, and `zen`, so any active canonical agent can delegate a focused task to any canonical role without changing the parent mode. These delegated runs use the canonical role prompt and model mapping, receive the project workspace, and cannot recursively launch another subagent.

The A1 provider is `a1-proxy`. Active coding defaults to `code-frontier-high`, observational memory defaults to `code-workhorse-high`, and every alias in [`packages/runtime-config/config/models.yaml`](packages/runtime-config/config/models.yaml) is available without persisting a proxy key or raw upstream model ID. By default, the Observer runs after 60,000 message tokens and the Reflector runs after 60,000 accumulated observation tokens. Mastra Code presents those thresholds as a combined 120,000-token memory capacity; this is not a declaration of the provider model's physical context window. Persisted approval, YOLO, thinking, valid model choices, and explicit numeric memory thresholds remain authoritative.

Project resources are loaded from the checkout and hot-reloaded without restarting Mastra or the controller:

- skills from `.agents/skills/`, `.claude/skills/`, and `.mastracode/skills/`;
- specialist Markdown agents from `.github/agents/` and `.mastracode/agents/`, with the latter winning same-ID conflicts;
- trusted workflow modules from `.mastracode/workflow/`; only workflows with an explicit `agentTool` export become tools;
- MCP configuration using the installed Code SDK precedence, including root `.mcp.json` and `.mastracode/mcp.json`.

A resource change is compiled and validated as a complete candidate. Failed candidates leave the last-known-good generation active. Workflow tools require approval and forward cancellation and output streaming.

Mastra Studio uses the same prepared project mount:

```bash
npm run dev:infisical
```

## Mastra Factory

Factory can boot locally without GitHub or WorkOS credentials for manual single-user workflows. Development receives a synthetic local organization; production fails closed unless WorkOS is configured:

```bash
npm run dev:factory:infisical
```

For authenticated GitHub operation, populate the WorkOS and `GITHUB_APP_*` names documented in `.env.example`. The GitHub App must be owned by `rlabs88`, use the slug `rlabs-mastra-toolkit`, and be limited to metadata, contents, issues, pull requests, checks, and statuses. Credential creation and app installation are human-confirmed operations.

Factory uses `ToolkitFactoryIntegration` to add `delegate_cortex`, `delegate_flux`, and `delegate_zen` to its native controller. Delegated agents cannot invoke those tools recursively.

For the A1 custom provider, Mastra Code stores IDs such as `a1-proxy/code-frontier-high`. Local Factory startup idempotently seeds the provider in Factory's credential store and migrates legacy raw-model references to `a1-proxy/code-workhorse-high`. API keys are never written to `settings.json` or the sandbox specification.

## Sandboxes

[`packages/sandbox/config/sandbox.config.json`](packages/sandbox/config/sandbox.config.json) is the version-controlled runtime specification. It declares the default provider, command and fleet limits, native isolation policy, the immutable ARM64 AES image, the `sandbox-entrypoint/v1` ABI, Docker hardening, and Platform lease/network policy. Its shape is documented by [`packages/sandbox/config/sandbox.schema.json`](packages/sandbox/config/sandbox.schema.json).

`SANDBOX_PROVIDER` may select one of the declared provider policies at process start:

- `local`: native LocalSandbox isolation and a contained filesystem.
- `docker`: the digest-pinned canonical `ghcr.io/rlabs88/toolkit/aes-sandbox` image.
- `platform`: Mastra Platform Workspace using `MASTRA_ENVIRONMENT_ID`, `MASTRA_PROJECT_ID`, and `MASTRA_PLATFORM_SECRET_KEY`.

The Docker provider consumes the canonical image directly from that package-local specification; this repository does not rebuild or republish the centrally owned Fedora baseline. To validate the pinned entrypoint on an ARM64 Docker host:

```bash
IMAGE="$(node -p 'require("./packages/sandbox/config/sandbox.config.json").spec.entrypointProfile.image')"
docker pull "$IMAGE"
docker run --rm --platform linux/arm64 "$IMAGE" probe
```

Host-specific workspace paths and all credentials stay in environment/Infisical configuration and are intentionally rejected from the checked-in specification. `SANDBOX_SPEC_PATH` can point at a different validated specification for an explicit deployment; invalid or mutable-image configurations fail closed.

Provider errors are fatal; Docker and Platform never silently fall back to Local.

## Human gates

Command Run dynamically requests approval when a batch contains shell execution, patch application, or a download. Reads, search, extraction, and task status remain read-only. Visible Stagehand Chrome automatically allows observation, extraction, screenshots, and tab listing; navigation, acting, closing, or mutating tabs require approval.

## Infisical

Use the `dev` environment and `/mastra-toolkit` path. The checked-in wrapper composes that path with `/agents`, so the existing `CLI_PROXY_API_KEY` is injected without copying it into another secret or a tracked dotenv file. Toolkit-specific credentials and settings remain under `/mastra-toolkit`.

Validate names without printing values:

```bash
npm run secrets:check
npm run secrets:check:factory
```

## Validation

```bash
npm run typecheck
npm test
npm run build
```

Package ownership and extension rules are recorded in the [Repository Manifest](docs/repository-manifest.md). The declarative sandbox contract and its provenance are recorded in [docs/sandbox-runtime.md](docs/sandbox-runtime.md).
