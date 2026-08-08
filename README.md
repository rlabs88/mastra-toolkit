# Mastra Toolkit

RLabs' local Mastra agent runtime and Mastra Factory adapter. It provides Cortex, Flux, and Zen through one shared runtime, with guarded repository tools, native background work, visible browser automation, and cloneable Local, Docker, or Platform sandboxes.

The [Executive Direction](docs/executive-direction.md) defines the project-runtime thesis and progression from local Mastra Code development to a multi-project Factory. The implemented ownership and fork boundaries are documented in [Workspace Architecture](docs/workspace-architecture.md), with exact consumers and extension rules in the [Repository Manifest](docs/repository-manifest.md).

## Requirements

- Node.js 22.19 or newer
- Infisical CLI authenticated to project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`
- `rg` and `git` inside the local workspace sandbox
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

Factory is the control plane, not the project sandbox. Set `FACTORY_REPOSITORY_EXECUTION=disabled` to run its authentication, storage, integrations, and scheduling surfaces without configuring a sandbox; attempts to start a GitHub-backed project then fail explicitly with `sandbox_not_configured`. With repository execution enabled (the default), Factory uses the configured sandbox template as a fleet and persists a workspace binding for each project, user, and session rather than assigning one sandbox to the Factory process. Checkout, setup, filesystem, command, Git, and explicitly published `.mastracode/workflow/` execution use that bound workspace. Cross-binding filesystem isolation belongs to the multi-project stage.

`FACTORY_PROJECT_RUNTIME_PROFILE` defaults to `ephemeral-development` and declares the shared MCode and project-development layers with task-scoped credentials. `persistent-operations` declares the operations layer and fails closed unless Platform sandboxing, durable database and Redis state, WorkOS deployment authentication, `NODE_ENV=production`, and an HTTPS `FACTORY_PUBLIC_URL` are configured. `FACTORY_ALLOWED_ORIGINS` is a comma-separated origin allowlist; WorkOS callback and cookie security derive from these validated deployment origins. Remote workspaces must pass the selected profile's runtime probe before use. The current project workflow tool receives no privileged operations credentials.

For authenticated GitHub operation, populate the WorkOS and `GITHUB_APP_*` names documented in `.env.example`. The GitHub App must be owned by `rlabs88`, use the slug `rlabs-mastra-toolkit`, and be limited to metadata, contents, issues, pull requests, checks, statuses, and organization Projects when Projects V2 is enabled. Credential creation and app installation are human-confirmed operations.

GitHub Projects V2 scheduling is enabled by `GITHUB_PROJECTS_CONFIG`, `GITHUB_PROJECTS_AUTOMATION_USER_ID`, and the runtime-only `GITHUB_PROJECTS_TOKEN`. The JSON config contains only stable Project, field, option, Factory-project, and optional Workspace mapping IDs. The Factory host injects the token from Infisical project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`, environment `dev`, path `/mastra-toolkit`; the Projects package, bindings, logs, and tracked files never own it. Project Status is the admission and desired-state surface: Backlog remains Project-only; Intake prepares a linked Factory card without running an agent; Investigate, Planning, Building, Review, Done, and Canceled map to the governed Factory `triage`, `planning`, `execute`, `review`, `done`, and `canceled` stages. Accepted Factory transitions project back to the same field, while stale or invalid Project requests fail closed and are repaired to Factory's operational state. Workspace path, command, and per-workspace concurrency overrides fail configuration until Factory publishes an execution-boundary seam that can enforce them; repository and project-repository settings remain authoritative.

Factory uses `ToolkitFactoryIntegration` to add only `project_workflow` to its native controller. Canonical delegation remains unavailable until Factory exposes the documented guarded controller-construction seam; the toolkit does not install a replacement `subagent` adapter. Because loading a workflow module can execute its top-level code, `project_workflow` requires approval before either listing or running project workflows. It publishes only workflows with explicit `agentTool` metadata, forwards output live and cancellation cooperatively, validates Standard Schema input/output, and refuses any workspace whose filesystem is not sandbox-backed. Factory host request context is intentionally not serialized into project code because it may contain authentication and controller objects; sandbox workflows receive explicit validated input instead.

Local MCode, Studio, and Factory consume the same versioned, secret-free [`ToolkitRuntimeContract`](docs/mcode-factory-compatibility.md) through host-local controller projections and bindings. `McodeRecipeV2` remains a deprecated compatibility alias rather than the canonical composition seam. Canonical agents, native subagents, delegated children, and project specialists use Mastra's workspace file/search tools and sandbox-backed `execute_command`; the toolkit owns no alternate command-loop or divergent-fan-out tool. Structured orchestration remains deferred to a future explicitly published Mastra workflow. Factory currently reports canonical mode/native-subagent controller construction as `upstream-blocked`; no controller patch or second controller is used. The separate Projects V2 control-plane integration consumes narrowly-scoped automation and verified-webhook seams from the pinned RLabs Factory backport documented in the workspace architecture.

For the A1 custom provider, Mastra Code stores IDs such as `a1-proxy/code-frontier-high`. Local Factory startup idempotently seeds the provider in Factory's credential store and migrates legacy raw-model references to `a1-proxy/code-workhorse-high`. API keys are never written to `settings.json` or the sandbox specification.

## Sandboxes

[`packages/sandbox/config/sandbox.config.json`](packages/sandbox/config/sandbox.config.json) is the version-controlled runtime specification. It declares the default provider, command and fleet limits, native isolation policy, the immutable ARM64 AES image, the `sandbox-entrypoint/v1` ABI, Docker hardening, and Platform lease/network policy. Its shape is documented by [`packages/sandbox/config/sandbox.schema.json`](packages/sandbox/config/sandbox.schema.json).

`SANDBOX_PROVIDER` may select one of the declared provider policies at process start:

- `local`: native LocalSandbox isolation and a contained filesystem.
- `docker`: the digest-pinned canonical `ghcr.io/rlabs88/toolkit/aes-sandbox` image.
- `platform`: Mastra Platform Workspace using `MASTRA_ENVIRONMENT_ID`, `MASTRA_PROJECT_ID`, and `MASTRA_PLATFORM_SECRET_KEY`.

The generic Docker provider consumes the canonical image from that package-local specification. Docker-backed Factory repository execution instead requires `SANDBOX_RUNTIME_IMAGE` at a profile-matching immutable digest and rejects a mutable or missing reference. The derived image source and native validation path are documented in [`deployment/mcode-sandbox`](deployment/mcode-sandbox/README.md). To validate the pinned base entrypoint on an ARM64 Docker host:

```bash
IMAGE="$(node -p 'require("./packages/sandbox/config/sandbox.config.json").spec.entrypointProfile.image')"
docker pull "$IMAGE"
docker run --rm --platform linux/arm64 "$IMAGE" probe
```

Host-specific workspace paths and all credentials stay in environment/Infisical configuration and are intentionally rejected from the checked-in specification. `SANDBOX_SPEC_PATH` can point at a different validated specification for an explicit deployment; invalid or mutable-image configurations fail closed.

Provider errors are fatal; Docker and Platform never silently fall back to Local.

## Human gates

MCode and Studio require approval for native workspace command execution, file writes, edits, and deletion. Factory applies the Code SDK's workspace policy to the persisted project/session sandbox. Visible Stagehand Chrome automatically allows observation, extraction, screenshots, and tab listing; navigation, acting, closing, or mutating tabs require approval.

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

Package ownership and extension rules are recorded in the [Repository Manifest](docs/repository-manifest.md). The declarative sandbox contract and its provenance are recorded in [docs/sandbox-runtime.md](docs/sandbox-runtime.md). The end-to-end model-selection path — declaration, role resolution, per-host persistence, and its known failure modes — is recorded in [Agent harness model selection](vault/agent-harness-model-selection.md).
