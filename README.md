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

The default endpoint is `https://aa.renaissancelab.org/v1`, the default model is `proxy/openai/gpt-5.6-luna`, storage is local LibSQL, and the sandbox provider is `local`.

Set the agent request context key `workspaceRoot` to bind Command Run to a project other than `WORKSPACE_ROOT`.

## Mastra Factory

Factory can boot locally without GitHub or WorkOS credentials for manual single-user workflows. Development receives a synthetic local organization; production fails closed unless WorkOS is configured:

```bash
npm run dev:factory:infisical
```

For authenticated GitHub operation, populate the WorkOS and `GITHUB_APP_*` names documented in `.env.example`. The GitHub App must be owned by `rlabs88`, use the slug `rlabs-mastra-toolkit`, and be limited to metadata, contents, issues, pull requests, checks, and statuses. Credential creation and app installation are human-confirmed operations.

Factory uses `ToolkitFactoryIntegration` to add `delegate_cortex`, `delegate_flux`, and `delegate_zen` to its native controller. Delegated agents cannot invoke those tools recursively.

## Sandboxes

Select with `SANDBOX_PROVIDER`:

- `local`: native LocalSandbox isolation and a contained filesystem.
- `docker`: hardened `mastra-toolkit-sandbox:local` container.
- `platform`: Mastra Platform Workspace using `MASTRA_ENVIRONMENT_ID`, `MASTRA_PROJECT_ID`, and `MASTRA_PLATFORM_SECRET_KEY`.

Build the Docker sandbox with:

```bash
docker build -f docker/sandbox.Dockerfile -t mastra-toolkit-sandbox:local .
```

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

The native capability decisions are recorded in [docs/mastra-capability-matrix.md](docs/mastra-capability-matrix.md).
