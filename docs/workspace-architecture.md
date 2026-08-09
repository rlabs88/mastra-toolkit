# Mastra Toolkit Workspace Architecture

Status: implemented baseline.

Mastra Toolkit is a product monorepo whose applications compose canonical RLabs packages. The structure separates agent behavior, project mounting, host adaptation, sandbox policy, and deployment intent so each concern can evolve without creating a second configuration system.

## Layout

```text
mastra-toolkit/
├── apps/
│   ├── mcode/                    # embedded mcode and remote mz CLI lifecycles
│   ├── studio/                   # Mastra Studio/server composition
│   └── factory/                  # Mastra Factory composition
├── packages/
│   ├── runtime-config/           # model YAML, env resolver, proxy gateway
│   ├── agent-tools/              # role-neutral tools and audit policy
│   ├── agents-roles/             # canonical Cortex, Flux, and Zen
│   ├── sandbox/                  # Local/Docker/Platform machine contract
│   ├── project-mounting-manager/ # hot-loaded project generations
│   ├── mastra-primitives-export/ # versioned host-neutral runtime contract
│   ├── mcode/                    # Code SDK/controller/TUI adapter
│   ├── factory-integration/      # Factory host and control-plane composition
│   └── factory-github-projects/  # GitHub Projects V2 control plane
├── deployment/
│   ├── mcode-sandbox/            # activated Factory runtime image source and probes
│   └── studio-server/            # target intent; build assets not yet added
├── docs/
└── test/                         # cross-package and application contracts
```

Every package has an `AGENTS.md`/`CONTEXT.md` checkpoint pair. Applications share one pair at `apps/`; deployment targets each have a pair because their credential and operational policies differ. The exact dependency and extension contracts are listed in the [repository manifest](repository-manifest.md).

## Production module structure

The package boundaries remain distinct, and their implementations are concentrated into deep modules. Package roots are the only TypeScript export surface; JSON/YAML configuration assets are the only allowed subpath exports.

```text
packages/
├── runtime-config/src/{index,profile,environment,gateway}.ts
├── agent-tools/src/{index,capabilities,dynamic-workflow}.ts
├── agents-roles/src/{index,roles,prompts,agents}.ts
├── sandbox/src/{index,contract,machine,providers}.ts
├── project-mounting-manager/src/{index,contract,discovery,manager}.ts
├── mastra-primitives-export/src/{index,primitives}.ts
├── mcode/src/{index,recipe,project,runtime,mz}.ts
├── factory-integration/src/{index,config,integration,runtime}.ts
└── factory-github-projects/src/{index,config,github-projects-client,integration,reconciler,storage,types}.ts
```

Do not create one-function files, role directories, compatibility barrels, or TypeScript implementation subpaths. A new source module requires an independently changing responsibility or lifecycle; otherwise extend the existing deep module that owns the behavior.

## Canonical runtime projection

```text
runtime-config ───────────┬──────────────┐
                         ▼              ▼
agent-tools ───────► agents-roles     sandbox
       │                 │              │
       └────────────┬────┴───────┬──────┘
                    ▼            │
          mastra-primitives-export
                 ┌──┴────────────┐
                 ▼               ▼
               mcode     factory-integration
                 ▲               ▲
                 │               │ optional control plane
project-mounting-manager  factory-github-projects
                 │
          ┌──────┴───────┐        │
          ▼              ▼        ▼
    apps/mcode      apps/studio  apps/factory
```

`agents-roles` is the one source of role IDs, prompt composition, model policy, and the Mastra supervisor/leaf registry. Each canonical supervisor points to all three canonical leaves; leaves have no `agents` map and cannot recursively delegate. Its four deep modules group role policy, prompt policy, agent construction, and the public facade; Cortex, Flux, and Zen do not require one-file directories or public implementation subpaths. Agents receive Mastra's native workspace file/search tools and sandbox execution automatically from their authorized workspace. `agent-tools` owns host-neutral browser, audit, aggregate run-containment, and `dynamic_workflow` authoring policy; `dynamic_workflow` accepts declarative Mastra graphs, issues no command, touches no filesystem, and receives agent and workflow ceilings from its MCode or Studio host. Factory does not expose this neutral orchestration adapter while its canonical modes/native-subagent construction seam remains upstream-blocked. `sandbox` owns the cloneable machine contract and provider adapters. The toolkit retains neither the alternate command loop nor the divergent fan-out tool.

`runtime-config` owns the secret-free YAML catalog, startup environment resolution, and host data paths. MCode, Studio, and Factory persist local state beneath `~/.mastra-toolkit/{mcode,studio,factory}` unless `MASTRA_APP_DATA_DIR` explicitly selects another host directory. Managed Studio state is further partitioned by a stable hash of the canonical Git root, so concurrent projects never share storage or DuckDB locks. `sandbox` owns the package-local runtime specification and the substitutable Local, Docker, and Platform machine adapters. No application-level aggregate configuration is canonical.

`mastra-primitives-export` references those canonical public exports without copying them. Its versioned `ToolkitRuntimeContract` publishes a deterministic capability descriptor and digest for role, prompt, model, tool, delegation, containment, background-task, workspace, and sandbox policy. A `ToolkitRuntimeBinding` keeps live identity, workspace, sandbox, browser, and approval values outside the descriptor. Host projections consume the same contract and a local binding; the contract and projections never own an `AgentController`.

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

- `packages/mcode` is an RLabs extension built on published `@mastra/code-sdk` and `mastracode` APIs. Its MCode projection binds non-recursive canonical agents to Code modes and exactly three native AgentController subagents. Its Studio projection additionally registers the generic canonical supervisor topology through supported `Agent({ agents })` semantics. `McodeRecipeV2` remains only as a deprecated compatibility alias. The package also owns provider adaptation, local project mounting, sessions, reusable TUI construction, and the project-aware `mz` runtime registry/supervision contract. Studio consumes its prepared constructor arguments and finalize lifecycle; the top-level `new Mastra(...)` in the Studio entrypoint is the one deployer-required exception to host-facade-only construction. Programmatic hosts use the prepared runtime's abort path if construction fails before finalize.
- `apps/mcode` owns only executable process lifecycle. `mcode` retains the embedded local runtime. `mz` resolves the canonical Git root, serializes project startup, validates a live runtime descriptor, starts or attaches to a loopback Studio runtime, and opens the remote TUI. Its detached supervisor keeps Studio alive after the TUI exits and restarts the same URL after a workflow-generation change.
- `apps/studio` creates the prepared project runtime and exposes it through Mastra Studio. It owns the AgentController, sessions, workspace, project manager, storage, and local-only observability for `mz`. Its versioned `/mz/runtime` descriptor is the authority for project identity, process instance, mount readiness, and observability readiness; PID/binding files are only discovery hints.
- `packages/factory-integration` binds the shared runtime contract to Factory request identity, workspace, sandbox, approvals, authentication, persistence, provisioning, diagnostics, and local provider migration. It does not import MCode. Factory constructs exactly one upstream-owned controller. `@mastra/factory@0.5.0` accepts no canonical modes, native subagents, or guarded controller-construction callback, so the projection and diagnostics mark that surface `upstream-blocked` and expose no delegation adapter; no second controller, dependency patch, or fork substitutes for the missing seam. `apps/factory` is its thin composition root.
- `packages/factory-github-projects` belongs between the GitHub Projects V2 API and `factory-integration`. It owns project-item binding policy, durable invalidations, scheduler and execution leases, GraphQL field projection, and governed scheduling. It never owns agent definitions, agent tools, sessions, sandboxes, project mounting, GitHub credentials, or webhook verification.
- Agent-facing project or RLabs API access enters through narrow tool ports injected at host composition time. Raw SDK clients, tokens, webhook verification, persistence, and control-plane scheduling cannot cross into `agents-roles`.

The embedded `mcode` path remains serverless in the transport sense: the controller, workflows, specialists, and Mastra instance run in the CLI process. The `mz` path is deliberately server-backed: Studio singularly owns that state and the terminal is a REST/SSE client. Factory remains a separate server host of the same canonical definitions.

The remote backend, authoritative snapshot, and cloud-export disablement live in the pinned RLabs Mastra fork at commit `d31defff03`. This checkout consumes the corresponding immutable tarballs from `vendor/mastra/`; `scripts/vendor-mastra-fork.mjs` rebuilds them from the external fork checkout while normalizing the release-train versions used by the toolkit. The vendored closure is intentional: registry releases do not yet expose the remote-TUI contract, and committing the artifacts keeps a clean toolkit checkout installable and deployable without relying on an unpublished registry version.

## Run containment and local artifacts

Every top-level run consumes the same bounded orchestration policy: at most eight delegated scopes, one active task per agent, four host-wide background tasks, 64 aggregate tool calls, 256,000 retained tool-output characters, and 20 minutes wall clock. Identical in-flight or completed delegation scopes are rejected. A failed external issue, pull-request, or project write is treated as an uncertain outcome and cannot be retried unchanged until the caller reconciles remote state. Command traces retain a compact preview while bounded results preserve both their beginning and end.

Normal close, cancellation, and startup failure stop controller intervals, close project resources and MCP, drain the host runtime, and release MCode thread locks. Project-local `.mastracode/tmp/` is transient scratch owned by the project or user; `.mastracode/audits/` is durable evidence. Runtime shutdown never deletes either path implicitly. A workflow that creates scratch data must remove only the files it owns after successful publication; audit deletion always requires an explicit user operation.

## Sandbox and deployment

One checkout or worktree maps to one workspace root and one sandbox context. `packages/sandbox` is runtime code; `deployment/*` describes how concrete runtime targets are built and operated. `deployment/mcode-sandbox` is activated for Factory repository execution and owns the two profile images plus their native validation probes. `deployment/studio-server` remains an inactive checkpoint.

Ephemeral Factory environments receive short-lived task credentials. Persistent operations environments may receive scoped deployment credentials only at runtime with audit and rotation. Neither model YAML, sandbox specifications, images, nor repository settings may contain resolved secrets.

## Fork policy

MCode is an extension/composition package, not a source fork. Issue #125 still does not permit a controller fork, dependency patch, or copied controller implementation; its Factory construction gap remains open until an official upstream release exposes the required narrow input. GitHub Projects V2 uses the separate, minimal Factory automation and verified-webhook seams proposed in upstream PR `mastra-ai/mastra#20885`. Toolkit validation consumes a stable `@mastra/factory@0.5.0` backport pinned to RLabs fork commit `ec57e0f97f`; it does not consume the upstream alpha dependency graph.

The external Factory checkout is `/Users/zzmc/dev/workspace/upstreams/mastra-factory-0.5.0`, with RLabs `origin` `https://github.com/rlabs88/mastra.git` and authoritative `upstream` `https://github.com/mastra-ai/mastra.git`, pinned to commit `ec57e0f97f`. Its vendored artifact is limited to the governed automation-command and verified-webhook observer seams unavailable in the public `0.5.0` release, including Intake preparation without agent kickoff, canonical GitHub issue metadata for rule dispatch, and authoritative Factory-project model inheritance for each rule-created role session. Factory remains browser-disabled and otherwise compositionally unchanged by `mz`.

Fork checkouts are external trust boundaries and are not npm workspace members. Each must record an RLabs `origin`, authoritative `upstream`, pinned commit, reason for divergence, and consumer validation.

## Invariants

1. Canonical roles, prompts, tools, model aliases, and sandbox providers have one owner.
2. Project discovery does not grant execution authority; workflow tool publication is explicit.
3. Hot reload activates a complete generation or retains the prior generation.
4. User-selected valid models and Code preferences are preserved; proxy keys are never persisted.
5. Provider failure is explicit and cannot silently weaken sandbox or model policy.
6. Applications remain thin and consume package public exports only.
7. Host adapters are siblings: Factory does not consume MCode, and canonical packages plus their aggregation boundary do not depend on either host.
8. Process shutdown awaits host resources and the shared Mastra runtime exactly once.
9. Every host constructs exactly one controller; shared contracts, bindings, and projections contain no controller instance.

## Validation gates

- Root: `npm run typecheck`, `npm test`, and `npm run build`.
- Package: the owning package's `npm run check`.
- MCode: local project boot, six modes, native subagent targets, project workflow tools, and PTY/CUA evidence when UI behavior changes.
- Factory: auth, storage migration, the delegation-blocker contract, sandbox, an `agent-browser` browser pass, and CUA evidence for visible workflows.
- Studio: browser validation when the Studio host or shared mounted runtime changes.
- Repository: `git diff --check`, checkpoint verification, secret scan, and generated-state inspection.
