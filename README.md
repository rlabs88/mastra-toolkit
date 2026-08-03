# Mastra Toolkit

RLabs' local Mastra agent runtime and Mastra Factory adapter. It provides Cortex, Flux, and Zen through one shared runtime, with guarded repository tools, native background work, visible browser automation, and cloneable Local, Docker, or Platform sandboxes.

## Requirements

- Node.js 22.19 or newer
- Infisical CLI authenticated to project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`
- `rg` and `git` for local Command Run
- Docker when using the Docker sandbox or persistence profile
- Chrome for visible computer-use

## Local standalone

```bash
npm ci
npm run dev:infisical
```

The default endpoint is `https://aa.renaissancelab.org/v1`, the default model is `proxy/openai/gpt-5.6-luna`, storage is local LibSQL, and the checked-in sandbox specification selects `local`.

Set the agent request context key `workspaceRoot` to bind Command Run to a project other than `WORKSPACE_ROOT`.

## Mastra Factory

Factory can boot locally without GitHub or WorkOS credentials for manual single-user workflows. Development receives a synthetic local organization; production fails closed unless WorkOS is configured:

```bash
npm run dev:factory:infisical
```

For authenticated GitHub operation, populate the WorkOS and `GITHUB_APP_*` names documented in `.env.example`. The GitHub App must be owned by `rlabs88`, use the slug `rlabs-mastra-toolkit`, and be limited to metadata, contents, issues, pull requests, checks, and statuses. Credential creation and app installation are human-confirmed operations.

Factory uses `ToolkitFactoryIntegration` to add `delegate_cortex`, `delegate_flux`, and `delegate_zen` to its native controller. Delegated agents cannot invoke those tools recursively.

For the A1 custom provider, the MastraCode model ID stored in project/session settings is `a1-proxy/gpt-5.6-luna`. Do not include the `mastracode/` gateway prefix there; the SDK adds that prefix when it routes the request. API keys remain in Infisical or Factory's credential store and are never written to `settings.json` or the sandbox specification.

## Sandboxes

[`sandbox.config.json`](sandbox.config.json) is the version-controlled runtime specification. It declares the default provider, command and fleet limits, native isolation policy, the immutable ARM64 AES image, the `sandbox-entrypoint/v1` ABI, Docker hardening, and Platform lease/network policy. Its shape is documented by [`config/sandbox.schema.json`](config/sandbox.schema.json).

`SANDBOX_PROVIDER` may select one of the declared provider policies at process start:

- `local`: native LocalSandbox isolation and a contained filesystem.
- `docker`: the digest-pinned canonical `ghcr.io/rlabs88/toolkit/aes-sandbox` image.
- `platform`: Mastra Platform Workspace using `MASTRA_ENVIRONMENT_ID`, `MASTRA_PROJECT_ID`, and `MASTRA_PLATFORM_SECRET_KEY`.

The repository Dockerfile is a thin consumer of the canonical image; it does not duplicate the centrally owned Fedora baseline. To validate the pinned entrypoint on an ARM64 Docker host:

```bash
IMAGE="$(node -p 'require("./sandbox.config.json").spec.entrypointProfile.image')"
docker pull "$IMAGE"
docker run --rm --platform linux/arm64 "$IMAGE" probe
```

Host-specific workspace paths and all credentials stay in environment/Infisical configuration and are intentionally rejected from the checked-in specification. `SANDBOX_SPEC_PATH` can point at a different validated specification for an explicit deployment; invalid or mutable-image configurations fail closed.

The optional persistence profile mirrors production infrastructure:

```bash
docker compose --profile persistence up -d
export DATABASE_URL=postgresql://mastra:mastra@127.0.0.1:5433/mastra
export REDIS_URL=redis://127.0.0.1:6380
```

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

The native capability decisions are recorded in [docs/mastra-capability-matrix.md](docs/mastra-capability-matrix.md). The declarative sandbox contract and its Linear provenance are recorded in [docs/sandbox-runtime.md](docs/sandbox-runtime.md).
