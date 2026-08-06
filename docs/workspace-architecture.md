# Mastra Toolkit Workspace Architecture

Status: implemented baseline.

Mastra Toolkit is a product monorepo whose applications compose canonical RLabs packages. The structure separates agent behavior, project mounting, host adaptation, sandbox policy, and deployment intent so each concern can evolve without creating a second configuration system.

## Layout

```text
mastra-toolkit/
├── apps/
│   ├── mcode/                    # local CLI process and TUI launch
│   ├── studio/                   # Mastra Studio/server composition
│   └── factory/                  # Mastra Factory composition
├── packages/
│   ├── runtime-config/           # model YAML, env resolver, proxy gateway
│   ├── agent-tools/              # role-neutral tools and audit policy
│   ├── agents-roles/             # canonical Cortex, Flux, and Zen
│   ├── sandbox/                  # Local/Docker/Platform machine contract
│   ├── project-mounting-manager/ # hot-loaded project generations
│   ├── mcode/                    # Code SDK/controller/TUI adapter
│   ├── factory-integration/      # Factory host and control-plane composition
│   └── factory-github-projects/  # future, issue #127; not created yet
├── deployment/
│   ├── mcode-sandbox/            # activated Factory runtime image source and probes
│   └── studio-server/            # target intent; build assets not yet added
├── docs/
└── test/                         # cross-package and application contracts
```

Every package has an `AGENTS.md`/`CONTEXT.md` checkpoint pair. Applications share one pair at `apps/`; deployment targets each have a pair because their credential and operational policies differ. The exact dependency and extension contracts are listed in the [repository manifest](repository-manifest.md).

## Canonical runtime projection

```text
runtime-config ───────────┬──────────────┐
                         ▼              ▼
agent-tools ───────► agents-roles     sandbox
                         │              │
               ┌─────────┴───────┐      │
               ▼                 ▼      ▼
             mcode       factory-integration
               │                 ▲
               ▼                 │ optional, future
project-mounting-manager  factory-github-projects
               │
        ┌──────┴───────┐          │
        ▼              ▼           ▼
  apps/mcode      apps/studio  apps/factory
```

`agents-roles` is the one source of role IDs, prompt composition, model policy, and Mastra agent factories. Each role owns a folder containing `prompt.ts`, `role.ts`, and `index.ts`. `agent-tools` owns the host-neutral Command Run language/scheduling contracts and browser capabilities; `sandbox` owns the executable `command_run` tool because execution requires an active sandbox workspace. Hosts project these packages; they do not copy them.

`runtime-config` owns the secret-free YAML catalog, startup environment resolution, and host data paths. MCode, Studio, and Factory persist local state beneath `~/.mastra-toolkit/{mcode,studio,factory}` unless `MASTRA_APP_DATA_DIR` explicitly selects another host directory. `sandbox` owns the package-local runtime specification and the substitutable Local, Docker, and Platform machine adapters. No application-level aggregate configuration is canonical.

## Project mounting

The local runtime starts from `cwd`, resolves the containing Git checkout or worktree through Mastra Code, and lets Mastra Code own its established instruction, skill, hook, command, plugin, database, and settings conventions.

`project-mounting-manager` adds the missing project-scoped executable resources without adding another manifest:

- specialists from `.github/agents/` and `.mastracode/agents/`;
- trusted workflow modules from `.mastracode/workflow/`;
- explicit workflow tools only when `agentTool` metadata is exported;
- MCP candidates validated through the Code SDK adapter;
- watched, generation-based reload with last-known-good rollback.

The package is host-neutral. Model lookup, MCP lifecycle, current tool enumeration, and Mastra registry changes are ports. `mcode` implements those ports for the in-process Code runtime. Factory can implement the same ports when its per-project runtime topology is proven.

## Host boundaries

- `packages/mcode` is an RLabs extension built on published `@mastra/code-sdk` and `mastracode` APIs. Its versioned recipe is the single construction seam for canonical agents, modes, native leaf subagents, settings input, and a secret-free capability digest. It also owns provider adaptation, local project mounting, sessions, and reusable TUI construction.
- `apps/mcode` owns only the executable process lifecycle. `npm run code` launches it; `npm run code:infisical` injects runtime secrets first.
- `apps/studio` creates the same prepared local project runtime and exposes it through Mastra Studio. The agent, workflow, and mounting definitions are shared with MCode.
- `packages/factory-integration` owns Factory authentication, persistence, direct construction of canonical agents, sandbox provisioning, compatibility diagnostics, and local provider migration. It does not import MCode. `apps/factory` is its thin composition root.
- A future `packages/factory-github-projects` belongs between the GitHub Projects V2 API and `factory-integration`. It may own project-item bindings, leases, reconciliation, and scheduling, but never agent definitions, agent tools, sessions, sandboxes, project mounting, or credentials. Its creation is deferred until issue #127 needs executable code.
- Agent-facing project or RLabs API access enters through narrow tool ports injected at host composition time. Raw SDK clients, tokens, webhook verification, persistence, and control-plane scheduling cannot cross into `agents-roles`.

The local MCode path is serverless in the transport sense: the controller, workflows, specialists, and Mastra instance run in the CLI process and require no central HTTP server. Studio and Factory are server hosts of shared package contracts.

## Sandbox and deployment

One checkout or worktree maps to one workspace root and one sandbox context. `packages/sandbox` is runtime code; `deployment/*` describes how concrete runtime targets are built and operated. `deployment/mcode-sandbox` is activated for Factory repository execution and owns the two profile images plus their native validation probes. `deployment/studio-server` remains an inactive checkpoint.

Ephemeral Factory environments receive short-lived task credentials. Persistent operations environments may receive scoped deployment credentials only at runtime with audit and rotation. Neither model YAML, sandbox specifications, images, nor repository settings may contain resolved secrets.

## Fork policy

No upstream fork is used for the implemented baseline. MCode is an extension/composition package, not a source fork. Issue #125 does not permit an upstream fork, dependency patch, or copied controller implementation; its Factory construction gap remains open until an official upstream release exposes the required narrow input. Any future fork proposal is a separate architectural decision and is not authorized by this baseline.

Fork checkouts are external trust boundaries and are not npm workspace members. Each must record an RLabs `origin`, authoritative `upstream`, pinned commit, reason for divergence, and consumer validation.

## Invariants

1. Canonical roles, prompts, tools, model aliases, and sandbox providers have one owner.
2. Project discovery does not grant execution authority; workflow tool publication is explicit.
3. Hot reload activates a complete generation or retains the prior generation.
4. User-selected valid models and Code preferences are preserved; proxy keys are never persisted.
5. Provider failure is explicit and cannot silently weaken sandbox or model policy.
6. Applications remain thin and consume package public exports only.
7. Host adapters are siblings: Factory does not consume MCode, and canonical packages do not depend on either host.
8. Process shutdown awaits host resources and the shared Mastra runtime exactly once.

## Validation gates

- Root: `npm run typecheck`, `npm test`, and `npm run build`.
- Package: the owning package's `npm run check`.
- MCode: local project boot, six modes, native subagent targets, project workflow tools, and PTY/CUA evidence when UI behavior changes.
- Factory: auth, storage migration, delegation, sandbox, an `agent-browser` browser pass, and CUA evidence for visible workflows.
- Studio: browser validation when the Studio host or shared mounted runtime changes.
- Repository: `git diff --check`, checkpoint verification, secret scan, and generated-state inspection.
