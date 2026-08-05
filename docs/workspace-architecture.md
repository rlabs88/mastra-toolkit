# Mastra Toolkit Workspace Architecture

Status: accepted target architecture; migration is not yet complete.

This document defines the intended ownership map for the Mastra Toolkit workspace. It separates RLabs product behavior from host adapters, sandbox build inputs, and upstream source. The layout is deliberately package-oriented so a human can tell where a change belongs before opening code.

## Decisions

1. **One canonical agent runtime.** Cortex, Flux, and Zen prompts, skills, tool factories, role metadata, and runtime defaults have one source. Studio, Factory, and Mastra Code only adapt that source to their host APIs.
2. **Applications are thin hosts.** Studio is a Mastra CLI/server entrypoint, Factory is the Factory deployment entrypoint, and Code mounts an AgentController on the caller-owned Mastra runtime. Host folders do not own prompt copies.
3. **Model configuration is declarative.** A checked-in YAML profile names the endpoint, credential environment variable, model roles, and host defaults. A typed loader resolves it once and emits host-specific configuration without persisting secrets.
4. **Sandbox builds are a separate product boundary.** Reusable package layers are composed into ephemeral and persistent environments. Application dependencies and sandbox image dependencies do not share a manifest by accident.
5. **Forks are escape hatches.** Published Mastra packages and public extension APIs are the normal dependency path. Source forks exist only for a concrete framework, Studio, TUI, or desktop UI delta that cannot be implemented through those APIs.

## Target layout

```text
mastra-toolkit/
├── AGENTS.md
├── CONTEXT.md
├── README.md
├── package.json
├── config/
│   └── models.yaml
├── apps/
│   ├── studio/                 # Mastra Studio/local server bootstrap
│   ├── factory/                # Mastra Factory bootstrap and deployment adapter
│   └── code/                   # Mastra Code SDK + TUI bootstrap
├── packages/
│   ├── agent-runtime/          # canonical roles, prompts, skills bridge, tools, hooks
│   ├── runtime-config/         # YAML schema, env resolver, host projections
│   ├── sandbox-runtime/        # workspace and cloneable sandbox-machine contract
│   └── factory-integration/    # Factory auth, delegation, Code SDK integration
├── sandbox/
│   ├── packages/
│   │   ├── base/               # common OS/runtime package layer
│   │   ├── coding/             # compilers, search, git, document tooling
│   │   ├── browser/            # browser automation dependencies
│   │   └── operations/         # deployment tooling; no credentials
│   └── environments/
│       ├── ephemeral/          # short-lived Factory composition
│       └── persistent/         # hardened operations composition
├── forks/
│   ├── mastra/                 # pinned RLabs fork of mastra-ai/mastra
│   └── mastra-code-ui/         # optional; only for desktop UI work
├── docs/
└── test/
```

Only the root checkpoint exists today. Nested `AGENTS.md`/`CONTEXT.md` pairs should be created with the corresponding real boundaries during migration, not in advance. The first expected nested checkpoints are `packages/agent-runtime`, `sandbox`, and `forks`; `sandbox/environments/persistent` merits a deeper checkpoint when privileged runtime integration is implemented.

## Canonical agent projection

The canonical package should expose data and factories rather than pre-bound host singletons:

```text
AgentProfile + prompt sections + tool factories + skill roots
                   │
         ┌─────────┼──────────┐
         ▼         ▼          ▼
  Studio adapter  Factory   Code modes/subagents
  (Mastra Agent)  adapter    (AgentController)
```

`packages/agent-runtime` owns role IDs, prompt composition, tool contracts, hooks, and the mapping from canonical roles to host modes/subagents. `apps/studio`, `apps/factory`, and `apps/code` own only lifecycle, presentation, and host-specific wiring.

The existing implementation remains canonical in `src/agents`, `src/tools`, and `src/runtime` until this move is performed. The migration must move code and switch all consumers in one coherent series; it must not establish a second prompt tree beside the first.

The root `.agents/skills/` tree remains the repository-local skill source during migration. Both Studio workspaces and Mastra Code project discovery can consume it. Packaging or synchronization may be added later, but generated copies are not canonical.

## Model profile contract

The YAML file contains references and defaults, not secrets. A representative shape is:

```yaml
version: 1
defaultProfile: cliproxy

profiles:
  cliproxy:
    provider:
      id: a1-proxy
      kind: openai-compatible
      baseUrl: https://aa.renaissancelab.org/v1
      apiKeyEnv: CLI_PROXY_API_KEY
    aliases:
      - code-frontier-high
      - code-workhorse-high
    roles:
      cortex: code-frontier-high
      flux: code-frontier-high
      zen: code-frontier-high
      specialist: code-frontier-high
      observer: code-workhorse-high
      reflector: code-workhorse-high
    code:
      defaultAgent: cortex
      defaultMode: build
      modes: [scope, build]
```

The loader should accept a profile name from a CLI flag or `MASTRA_MODEL_PROFILE`, resolve `apiKeyEnv` from the injected process environment, normalize the base URL, validate every referenced role, and return an immutable resolved profile. Arbitrary shell expansion is unnecessary; the explicit `apiKeyEnv` field keeps secret resolution auditable.

Host projections derive their IDs from that object:

- Studio registers the existing `ProxyGateway` and resolves `proxy/a1-proxy/<alias>`.
- Factory registers the same `a1-proxy` provider through the Code SDK custom-provider source and seeds only missing, non-secret model defaults.
- Code passes six derived namespaced modes and three canonical leaf-subagent definitions into `prepareAgentControllerMount()`. Every mode receives the native `subagent` tool and can target `cortex`, `flux`, or `zen`. Its settings file may contain non-secret user preferences but never the CLIProxy key or raw upstream model IDs.

This adapts the useful part of the `jc` launcher pattern—named YAML profiles, environment references, validation, and an explicit user override—without importing Claude-specific tier aliases or writing resolved credentials to configuration.

## Sandbox composition

`sandbox/packages/*` are build inputs, not JavaScript workspace packages. Each layer has a manifest, install/build logic, and a smoke test. Environment folders select layers and security policy:

| Environment | Intended lifetime | Package layers | Credentials |
| --- | --- | --- | --- |
| Ephemeral | One Factory task/run | base + coding, optional browser | Short-lived task credentials only; no deployment keys |
| Persistent | Long-running operations workspace | base + coding + operations, optional browser | Runtime-injected, scoped operations credentials with audit and rotation |

Both compositions implement the same cloneable sandbox-machine interface. Provider selection is explicit, and provider failure is terminal. Persistent environments add hardening and secret delivery; they do not become a separate agent implementation.

## Fork topology

Mastra Code's source and TUI live under `mastracode/` in the main [`mastra-ai/mastra`](https://github.com/mastra-ai/mastra) monorepo. Consequently:

- `forks/mastra` is the only source fork needed for Mastra framework, Studio, or Mastra Code TUI deltas.
- The current private `rlabs88/mastra-code` project is a wrapper and should be migrated into `apps/code`, then retained only as a transition/archive repository if desired.
- `forks/mastra-code-ui` is separate because [`mastra-ai/mastra-code-ui`](https://github.com/mastra-ai/mastra-code-ui) is a separate Electron project. It should not be added until desktop work is in scope.

Fork checkouts should be git submodules pinned to reviewed commits. They are not members of the root npm workspace. Each fork keeps `origin` pointed at the RLabs fork and `upstream` pointed at the authoritative Mastra repository. Toolkit changes consume a fork through a package/tarball/linked build boundary, not by importing arbitrary source paths across repositories.

## Migration sequence

1. Add and test the typed model-profile loader while the existing single package remains intact.
2. Extract `packages/agent-runtime` and switch the current Studio/Factory entrypoint to it.
3. Move the private Mastra Code wrapper into `apps/code`, replace copied prompts/modes with canonical projections, and update it from its older Mastra Code API to the current public API.
4. Extract `runtime-config`, `sandbox-runtime`, and `factory-integration` only along existing seams; keep a root compatibility export until callers migrate.
5. Move toolkit-owned sandbox runtime manifests into `sandbox/`, then create its checkpoint pair and validate ephemeral and persistent compositions. Add image build inputs only when this repository owns a concrete derived image.
6. Add `forks/mastra` only when the first concrete upstream delta is selected and the RLabs GitHub fork exists. Add the optional desktop fork only for actual desktop UI work.
7. Remove legacy root `src/` ownership and the separate wrapper only after all host and contract tests use workspace packages.

## Validation gates

- Canonical prompt snapshots must be identical across Studio and Code projections.
- Every host must resolve the same role-to-model mapping from one profile fixture.
- No settings file, generated artifact, image layer, or test snapshot may contain a resolved credential.
- Ephemeral and persistent environments must pass the same sandbox-machine contract suite, plus profile-specific security tests.
- Fork-backed builds must pass upstream-targeted tests and the toolkit consumer integration test before the pinned commit advances.
