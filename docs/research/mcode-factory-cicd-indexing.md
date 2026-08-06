# MCode-to-Factory CI/CD and capability indexing

Research date: **2026-08-05** (America/Vancouver)

Repository snapshot: branch `codex/issue-119-mcode-config`, commit `ec0ddb32ac2b0f69c9c7ad7b5ec0444302623917`.

External snapshot: official Mastra documentation and `mastra-ai/mastra` commit [`45a914741f578754d79d8b7de7b4e4f304d8e14a`](https://github.com/mastra-ai/mastra/tree/45a914741f578754d79d8b7de7b4e4f304d8e14a), inspected on the research date. DeepWiki was used only to locate upstream areas; every material upstream claim below is verified against official documentation, first-party source, or public package metadata.

## Summary

Factory should not discover MCode by importing a mounted local runtime, scanning source, or polling a registry. The least-coupled path is for `@rlabs/mcode` to export one typed, host-neutral **controller construction projection** plus a derived, secret-free **capability descriptor**; Factory supplies the projection to its own `prepareAgentControllerMount()` call before its single controller is constructed, while the descriptor provides release admission, observability, and rollback identity.

At the inspected upstream versions, the Code SDK already accepts the needed modes, subagents, tools, state, settings, workspace, and lifecycle inputs, but Factory does not expose a construction input for its internally owned controller. A narrow upstream Factory seam is therefore required unless one appears before implementation. Repository-scoped instructions, skills, hooks, commands, plugins, MCP, specialists, and workflows remain per-session sandbox concerns and must not be serialized into the host-level capability index.

## Decision question and operational definition

[Issue #125](https://github.com/rlabs88/mastra-toolkit/issues/125) asks Factory to consume the canonical MCode projection while keeping the controller host-owned and resolving executable project configuration from the persisted sandbox clone. It is the remaining composition work under [#119](https://github.com/rlabs88/mastra-toolkit/issues/119), whose target is one governed project runtime with durable sandbox provision, reattachment, recovery, and explicit failure.

For this work, **“indexed in Factory” means all four of the following**:

1. A Factory release declares the exact MCode construction-contract version and capability digest it was built and tested with.
2. Factory validates that contract before constructing its single `AgentController`, and rejects an unsupported or mismatched projection.
3. Factory records the admitted digest on its deployment diagnostics and on newly created session metadata so a session can be related to its controller and sandbox release.
4. Operators can promote or roll back to a previously admitted pair of Factory release and sandbox image without reconstructing behavior from source.

It does **not** mean that Factory has a second agent registry, that it scans `packages/mcode/src`, or that it dynamically imports project code on the control-plane host. The accepted direction makes one checkout/worktree plus one contained sandbox the operating unit and defines Factory as an alternate host of the same canonical behavior, not another source of it ([executive direction:7-31](../executive-direction.md#L7-L31)).

## Current repository evidence

### Canonical composition and local MCode lifecycle

- `agents-roles` owns role identity, prompt composition, model policy, and agent factories; `runtime-config` owns the secret-free model catalog and resolves credentials only at process start ([workspace architecture:51-53](../workspace-architecture.md#L51-L53)). The model schema validates aliases and role defaults, and the loader rejects unknown aliases rather than substituting a model ([profile.ts:6-71](../../packages/runtime-config/src/profile.ts#L6-L71)).
- MCode currently detects the project root, resolves runtime and sandbox configuration, creates the shared workspace and canonical agents, then constructs six modes and three native subagents before calling the Code SDK mount ([mount.ts:64-113](../../packages/mcode/src/mount.ts#L64-L113)). It folds the canonical agents, proxy gateway, workspace, and worker policy into the caller-owned `Mastra` constructor arguments ([mount.ts:119-136](../../packages/mcode/src/mount.ts#L119-L136)).
- Finalization creates the Project Mounting Manager against that same `Mastra`, finalizes the Code controller, and only then starts resource watching ([mount.ts:138-180](../../packages/mcode/src/mount.ts#L138-L180)). The convenience mount creates `new Mastra(prepared.mastraArgs)` only after preparation ([mount.ts:186-189](../../packages/mcode/src/mount.ts#L186-L189)).
- The six mode IDs are a deterministic cross-product of `cortex|flux|zen` and `scope|build`; each mode refers to the canonical `Agent` instance and a shared model alias default ([modes/index.ts:12-50](../../packages/mcode/src/modes/index.ts#L12-L50)). The subagents reuse canonical archetypes, composed prompts, model-role mappings, and step limits ([subagents.ts:8-19](../../packages/mcode/src/subagents.ts#L8-L19)).
- Local lifecycle is separate from construction: it mounts the runtime, creates one checkout-scoped session, wires Code session concerns, and then optionally constructs the TUI ([local-runtime.ts:21-67](../../packages/mcode/src/local-runtime.ts#L21-L67)). This is why `MountedMcodeRuntime` is the wrong Factory input: it already contains a `Mastra`, controller, local project, mounting manager, and close lifecycle ([mount.ts:45-62](../../packages/mcode/src/mount.ts#L45-L62)).
- Existing tests prove the local controller has the six modes, three leaf subagents, canonical agent objects, dynamic project workflow/specialist tools, independent session mode state, and one caller-owned `Mastra` ([local-project-runtime.test.ts:9-102](../../test/local-project-runtime.test.ts#L9-L102)). They do not yet prove the same mode/subagent projection in Factory.

The existing `prepareCodeSdkSettings()` is useful but is not yet the full construction boundary. It updates a host settings file, preserves valid explicit mode, approval, thinking, and memory selections, projects canonical subagent model defaults, and deliberately omits proxy credentials ([settings.ts:44-101](../../packages/mcode/src/settings.ts#L44-L101), [code-sdk.test.ts:8-39](../../test/code-sdk.test.ts#L8-L39), [code-sdk.test.ts:65-100](../../test/code-sdk.test.ts#L65-L100)). Its default path is host-global application data, so the Factory adapter must not copy that file or its mutable preferences into a project sandbox.

### Factory composition today

- The Factory application independently calls `createToolkitAgents()`, creates Factory, awaits `factory.prepare()`, constructs the one server-owned `Mastra`, and then finalizes Factory ([apps/factory/src/index.ts:6-30](../../apps/factory/src/index.ts#L6-L30)).
- `createToolkitFactory()` currently imports only the MCode settings helper/provider type. It prepares settings, storage, auth, integrations, PubSub, and the sandbox fleet template before instantiating `MastraFactory` ([factory create.ts:19-63](../../packages/factory-integration/src/create.ts#L19-L63)). It cannot pass modes or subagents through the installed `MastraFactoryConfig`.
- Toolkit Factory tools are contributed through a Factory integration. That integration owns bounded delegation tools and the sandbox-bound `project_workflow` bridge; it does not configure the Code controller's mode registry ([toolkit-integration.ts:14-34](../../packages/factory-integration/src/toolkit-integration.ts#L14-L34)).
- Factory's package policy explicitly permits only a narrow dependency on `mcode` for hosted Code sessions/provider state, while retaining authentication, storage, integrations, and sandbox composition in Factory ([factory policy:17-22](../../packages/factory-integration/AGENTS.md#L17-L22)). This is consistent with a construction projection and inconsistent with importing `MountedMcodeRuntime`.
- The root and relevant workspace packages are currently private and source-linked; `@rlabs/mcode` and `@rlabs/factory-integration` both export their TypeScript source and have no publish script ([mcode package.json:1-23](../../packages/mcode/package.json#L1-L23), [factory package.json:1-30](../../packages/factory-integration/package.json#L1-L30)). The root defines typecheck, test, Studio build, and secret-check commands but this snapshot has no `.github/workflows` directory ([package.json:21-35](../../package.json#L21-L35)). Therefore a remote package registry or event stream is not a current delivery primitive.

### Project Mounting Manager and sandbox boundary

- The Project Mounting Manager is host-neutral: model resolution, MCP lifecycle, tool snapshots, and host registration are ports with prepared `commit()` and `rollback()` phases ([ports.ts:4-33](../../packages/project-mounting-manager/src/ports.ts#L4-L33)).
- Reloads are serialized. Discovery and validation happen before MCP/host preparation; both stages commit before the new generation becomes current, and failure asks the prepared ports to roll back while the previous store snapshot remains active ([manager.ts:46-83](../../packages/project-mounting-manager/src/manager.ts#L46-L83), [manager.ts:112-183](../../packages/project-mounting-manager/src/manager.ts#L112-L183)). Each concrete port must prove that its external effects really are reversible. This generation is the correct unit for project-resource rollback, not a process-wide Factory capability record.
- Factory already executes explicitly published workflows inside the bound sandbox: the tool requires a sandbox-backed workspace and runs the shared Project Mounting Manager runner with approval, cancellation, and structured output ([project-workflow.ts:19-98](../../packages/factory-integration/src/project-workflow.ts#L19-L98)). The runner imports and validates workflow modules inside the checkout and never serializes Factory request context into project code ([sandbox-workflows.ts:104-180](../../packages/project-mounting-manager/src/sandbox-workflows.ts#L104-L180)). Specialists and transactional MCP generations still need a sandbox-backed Factory adapter under #125.
- Factory's sandbox template is projected with an explicit runtime profile and optional immutable image identity ([factory create.ts:66-78](../../packages/factory-integration/src/create.ts#L66-L78)). The admission proxy runs the profile probe before commands, processes, networking, writes, or mounts and destroys/stops a rejected sandbox ([profile-machine.ts:14-75](../../packages/sandbox/src/profile-machine.ts#L14-L75), [profile-machine.ts:131-163](../../packages/sandbox/src/profile-machine.ts#L131-L163)).
- The image runtime layer currently declares only `@mastra/core`, `esbuild`, `tsx`, and `zod` as direct dependencies; it does not declare the MCode host package ([runtime package.json:1-11](../../deployment/mcode-sandbox/runtime/package.json#L1-L11)). A mode or prompt projection change therefore does not inherently require a sandbox image rebuild. A workflow compiler/runtime dependency or sandbox ABI change does.
- Hosted CI is allowed to validate image source contracts but may not publish the native ARM64 images. Native build, publication, immutable digest capture, and live reconciliation are OPS-owned ([deployment policy:47-55](../../deployment/mcode-sandbox/AGENTS.md#L47-L55)). The existing native verifier labels images with the exact source commit, checks the inherited ABI, profile probe, a real workflow, architecture, image history, and credential-shaped material ([deployment README:14-28](../../deployment/mcode-sandbox/README.md#L14-L28)).

## Current official/upstream evidence

At the time of this historical research snapshot, the installed repository versions were `@mastra/code-sdk@1.1.1`, `@mastra/factory@0.3.0`, and `@mastra/core@1.55.0`. The repository has since upgraded; version-sensitive statements in this note refer to the inspected snapshot. On the research date, upstream commit `45a9147` published package metadata for `@mastra/code-sdk@1.1.3` and `@mastra/factory@0.5.0`, both from the same Mastra monorepo and both as public packages ([Code SDK package](https://github.com/mastra-ai/mastra/blob/45a914741f578754d79d8b7de7b4e4f304d8e14a/mastracode/sdk/package.json#L1-L44), [Factory package](https://github.com/mastra-ai/mastra/blob/45a914741f578754d79d8b7de7b4e4f304d8e14a/mastracode/factory/package.json#L1-L60)).

The relevant upstream facts are stable across the installed and inspected current source:

1. Mastra Code is officially a composable library. Its documented factory accepts custom modes, subagents, and extra tools ([Customization](https://code.mastra.ai/customization), [API reference](https://code.mastra.ai/reference)). The current source type also accepts modes, subagents, request-aware tools, input processors, settings/state, storage, workspace, MCP, browser, PubSub, and other host inputs ([MastraCodeConfig](https://github.com/mastra-ai/mastra/blob/45a914741f578754d79d8b7de7b4e4f304d8e14a/mastracode/sdk/src/index.ts#L232-L320)).
2. The Code SDK constructs an inert controller from those inputs and deliberately defers initialization so it can be mounted into a server-owned `Mastra`; the modes and subagents are applied before controller creation ([controller construction](https://github.com/mastra-ai/mastra/blob/45a914741f578754d79d8b7de7b4e4f304d8e14a/mastracode/sdk/src/index.ts#L971-L1037)).
3. `mountAgentControllerOnMastra()` and `prepareAgentControllerMount()` preserve one server-owned `Mastra`; the latter returns constructor arguments plus a finalize phase and registers the controller before initialization ([mount lifecycle](https://github.com/mastra-ai/mastra/blob/45a914741f578754d79d8b7de7b4e4f304d8e14a/mastracode/sdk/src/index.ts#L1158-L1257)).
4. Current Factory owns that exact lifecycle. Its public config accepts auth, storage, vector, PubSub, sandbox, integrations, rules, and platform overrides, but no `MastraCodeConfig`, modes, subagents, or controller-construction callback ([Factory config](https://github.com/mastra-ai/mastra/blob/45a914741f578754d79d8b7de7b4e4f304d8e14a/mastracode/factory/src/factory.ts#L91-L180)).
5. Factory internally calls `prepareAgentControllerMount()` with its own workspace, storage, processors, tools, observer, PubSub, API routes, and server config. No caller-provided modes/subagents are merged at that call ([Factory controller mount](https://github.com/mastra-ai/mastra/blob/45a914741f578754d79d8b7de7b4e4f304d8e14a/mastracode/factory/src/factory.ts#L597-L695)).

This proves a concrete extension-point gap. It does not justify copying or patching Factory inside this repository. The current execution direction forbids a Mastra fork for #125, so the toolkit can prepare and diagnose the compatibility boundary but must wait for an official upstream extension API ([workspace architecture](../workspace-architecture.md#fork-policy)).

## Mechanisms considered

| Mechanism | Runtime coupling | Freshness / discovery | Rollback | Multi-project isolation | Deployment cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Import `prepareMcodeRuntime()` or `MountedMcodeRuntime` into Factory | **Very high.** Imports local project detection, workspace, `Mastra`, controller, PMM watcher, settings, and close lifecycle. Competes with Factory ownership. | Immediate at process start, but from the Factory checkout rather than the bound project clone. | Entangles controller, project generation, and deployment rollback. | Unsafe: one process-level project/runtime can bleed across sessions. | Low initially, high operationally. | Reject. It violates the host-owned controller and sandbox boundaries. |
| Typed MCode controller construction projection | **Low.** Factory depends on one narrow public type/function; canonical packages remain behind it. | Compile/build-time exactness; a new Factory release consumes a new projection automatically. | Exact package/revision and capability digest select the prior behavior. | Safe for process-global modes/policy when repository resources remain session-scoped. | Small upstream seam plus consumer tests. | **Recommend as the runtime path.** |
| Generated capability manifest only | Low data coupling, but it cannot carry `Agent`, tool, processor, or mode objects. | Excellent for comparing releases and diagnostics. | Excellent immutable identity. | Safe if it contains no project/user state. | Small generation/validation cost. | Use only as a derived index and admission artifact, never as runtime configuration. |
| Versioned `@rlabs/mcode` package contract | Moderate distribution coupling; the typed projection remains the API. | Registry/version resolution makes releases discoverable across repositories. | Pin exact version and integrity/provenance. | Safe if each deployment and session records the admitted digest. | Requires package ownership, publishing, provenance, retention, and consumer automation. Packages are private today. | Future distribution wrapper; not required for the monorepo slice. |
| Registry/event/webhook-based capability indexing | Low compile coupling but high operational coupling to registry availability and event ordering. | Near-real-time, eventually consistent. | Requires durable event history and artifact retention. | Requires tenant/project scoping and authorization from day one. | Highest: service, schema, authentication, retries, reconciliation. | Defer until a multi-project control plane has a demonstrated need. |
| Scan source files or prompts in CI/Factory | Tight coupling to internal layout and syntax; semantic behavior is not reconstructible from source names. | Appears fresh but is brittle and can index uncommitted/generated state. | Cannot reliably reconstruct an executable release. | Risks indexing the Factory checkout rather than the session clone. | Ongoing parser and security burden. | Reject. |

Typed construction and a derived manifest are complementary: the typed object graph is executable; the manifest is inspectable. Neither should be replaced by the other.

## Recommended minimal contract

### 1. One host-neutral executable projection

`@rlabs/mcode` should expose a narrow constructor such as `createMcodeControllerIngredients()` and a versioned return type such as `McodeControllerIngredientsV1`. Names are illustrative; the ownership and shape are the decision.

```ts
interface McodeControllerIngredientsV1 {
  readonly contract: "rlabs.mcode-controller/v1";
  readonly modes: readonly AgentControllerMode[];
  readonly subagents: readonly AgentControllerSubagent[];
  readonly safeInitialState: Readonly<Partial<MastraCodeState>>;
  readonly capabilities: McodeCapabilityDescriptorV1;
}
```

The recipe constructor should take already resolved, host-neutral inputs: the one `ModelProfile`, the sandbox-owned `command_run` tool, and explicit agent host options. It constructs the canonical agents plus controller ingredients but must not re-read environment variables, instantiate `Mastra`, create/init a controller, select a sandbox provider, start PMM, create a session, or construct a TUI. This removes the former internal `createCodeModes()` profile reload and preserves the repository rule to resolve a model profile once at startup.

For v1, the executable projection should contain only:

- the six canonical modes, including prompt overlays, canonical `Agent` references, and default model aliases;
- the three native leaf subagents and model/step policy;
- allowlisted Code initial-state defaults that are safe in both hosts; and
- the derived capability descriptor.

Do **not** put the following in v1:

- `workspace`, storage, vector, PubSub, auth, routes, integrations, controller ID, session lifecycle, or worker policy — Factory owns them;
- Factory integration tools or audit observers — Factory must retain its collision checks, request context, and governance hooks;
- PMM generations or repository-discovered resources — they belong to the bound sandbox/session;
- resolved credentials, host environment, host-global skill paths, mutable user settings, or raw provider model IDs.

Canonical agent tools remain attached to the canonical agents; Factory session tools continue through `FactoryIntegration`; PMM tools remain dynamically resolved per project generation. If a later slice proves a genuinely shared controller-level processor/tool contribution, add a named, ordered contribution field in a new compatible contract rather than accepting an arbitrary `MastraCodeConfig` spread.

### 2. A narrow upstream Factory seam

Upstream `MastraFactoryConfig` should accept construction ingredients **before** its internal call to `prepareAgentControllerMount()`. The smallest #125 seam is conceptually:

```ts
interface FactoryCodeConstruction {
  readonly modes?: MastraCodeConfig["modes"];
  readonly subagents?: MastraCodeConfig["subagents"];
  readonly initialState?: Readonly<FactorySafeInitialState>;
}

interface MastraFactoryConfig {
  // existing fields...
  readonly codeConstruction?: FactoryCodeConstruction;
}
```

`FactorySafeInitialState` must be an upstream Factory-owned allowlist, not an alias for all of `Partial<MastraCodeState>`. The upstream implementation must merge these fields explicitly, not spread an arbitrary `MastraCodeConfig`:

- projected `modes` and `subagents` are passed before controller creation;
- safe projected state is applied first and Factory's `skipGlobalInstructions`, storage-backed memory policy, and other security state win last;
- Factory retains exclusive ownership of workspace, storage, vector, PubSub, input processors, integration tools, post-tool audit observers, routes, server config, and controller ID;
- duplicate tool/processor contribution remains a named error, never last-write-wins;
- invalid construction fails `MastraFactory.prepare()` before the server becomes ready.

If settings-path injection is later necessary, add it as an explicit field with a host-only policy. Local MCode may use its settings file; Factory should project allowlisted defaults and persist user selections in Factory-owned storage. Neither path copies settings into a sandbox. The issue's requirement to preserve explicit selections means a missing or removed persisted mode/model must produce a compatibility error or an explicit migration, not silently choose a profile default.

Until this seam is accepted and released upstream, keep Factory construction capability explicit and unsupported. Do not fork Mastra, subclass Factory to reach private fields, monkey-patch `prepare()`, or reproduce its internal mount code.

### 3. One derived capability descriptor

The executable projection should generate, not hand-maintain, a serializable descriptor:

```ts
interface McodeCapabilityDescriptorV1 {
  readonly schemaVersion: 1;
  readonly constructionContract: "1.0.0";
  readonly toolkitRevision: string;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly testedMastra: {
    readonly codeSdk: string;
    readonly factory: string;
    readonly core: string;
  };
  readonly modeIds: readonly string[];
  readonly subagentIds: readonly string[];
  readonly features: readonly string[];
  readonly sandboxRuntimeContract: string;
  readonly capabilityDigest: string;
}
```

The digest covers canonical, ordered IDs and version/policy markers, not secret values or serialized prompt/tool implementations. The exact build artifact and Git revision provide provenance for executable code. The descriptor is an index of what the release contains, not a second definition of how it behaves.

Compatibility rules:

- `schemaVersion` changes only when the descriptor parser must change.
- Construction-contract **major** changes alter ownership, merge order, field meaning, or persisted-session interpretation; Factory must reject an unsupported major.
- **Minor** changes are additive fields/capabilities/IDs and still require normal promotion evidence.
- **Patch** changes preserve the declared surface. The exact capability digest still changes when behaviorally relevant markers change.
- Factory pins exact package/revision integrity even when it accepts a compatible contract range. A range controls parsing; it is not permission to deploy an untested build.

### 4. Session and project identities

Factory should record at least `factoryRelease`, `constructionContract`, `capabilityDigest`, and `sandboxImageDigest` on session/deployment diagnostics. PMM separately records its active `generation.id` for that sandbox checkout. This keeps three rollback axes explicit:

1. process-global controller construction;
2. sandbox runtime image/ABI; and
3. per-checkout project-resource generation.

New deployments must not hot-swap process-global modes or subagents in a running controller. A persisted session whose selected mode is absent in the new descriptor must resume on the old release, be explicitly migrated, or fail compatibility; it must not silently default to `cortex/build`. PMM hot reload remains allowed within one sandbox because its prepared-generation rollback contract already preserves last-known-good state.

## CI/CD lifecycle

```mermaid
sequenceDiagram
    actor Dev as MCode/canonical change
    participant CI as Source CI
    participant Art as Typed packages + capability descriptor
    participant FCI as Factory consumer gate
    participant Ops as OPS native build/promotion
    participant Factory as Factory release/index
    participant SB as Bound session sandbox

    Dev->>CI: Commit on reviewed source revision
    CI->>CI: typecheck, tests, build, secret/diff checks
    CI->>Art: Pack exact source + emit descriptor/digest
    Art->>FCI: Install artifact, compile upstream seam
    FCI->>FCI: local/Factory parity, policy merge, isolation, resume tests
    alt Host-only construction change
        FCI-->>Factory: Promote Factory artifact + admitted digest
    else Sandbox runtime/ABI change
        FCI-->>Ops: Eligible source revision + required runtime contract
        Ops->>Ops: Native ARM64 build, probe, workflow, secret/provenance checks
        Ops-->>Factory: Promote Factory release + immutable image digest
    end
    Factory->>Factory: Validate contract/digest before controller construction
    Factory->>SB: Clone or reattach session with expected profile/image
    SB->>SB: Runtime admission probe; resolve project config in clone
    SB-->>Factory: Session metadata + PMM generation/diagnostics
    alt Regression or incompatibility
        Factory->>Factory: Route new/resumed sessions to prior admitted release
        Factory->>SB: Select prior compatible immutable image when required
    end
```

### Source CI gates

Every change affecting `agents-roles`, `agent-tools`, `runtime-config`, MCode projection, Factory integration, PMM, or sandbox contracts should run:

1. Root typecheck, tests, and build plus `git diff --check` and a credential/generated-state inspection, as already required by repository policy ([workspace architecture:99-105](../workspace-architecture.md#L99-L105)).
2. A projection unit test that constructs ingredients once from a supplied profile and canonical agents, validates the descriptor schema, and verifies deterministic ordering/digest.
3. Local MCode contracts for modes, leaf subagents, settings preservation, tool surfaces, PMM generation, and local session lifecycle.
4. A Factory consumer contract using the actual pinned official `@mastra/factory` package. Once the upstream seam exists, it must prove exactly one controller, mode/subagent parity, Factory-owned storage/workspace/routes, tool-collision behavior, and fail-closed invalid construction.
5. A packed-artifact smoke test. Install produced tarballs into a clean fixture rather than relying only on npm workspace `*` links; compile and start both local MCode and Factory from their public exports.
6. Two Factory sessions against different checkout bindings, including restart/reattachment, persisted-mode compatibility, no host path/settings leakage, PMM last-known-good rollback, and escaping/invalid project configuration rejection.
7. A descriptor compatibility check. A breaking descriptor or session change without a construction-contract major bump fails CI.

The source artifact becomes **eligible**, not automatically live. At this repository stage, the simplest artifact identity is the exact Git commit plus packed package checksums embedded in the Factory server build. There is no need to publish private `@rlabs/*` packages merely to move code within the same monorepo.

### Sandbox-image trigger and gate

CI classifies the change by declared runtime contract and changed ownership boundary:

- mode prompts, agent construction, model defaults, Factory host adapters, UI, or control-plane routes: rebuild/test the Factory application; no sandbox image rebuild by default;
- PMM sandbox runner, workflow compiler/runtime dependencies, package layers, entrypoint ABI, runtime probe, or sandbox profile: require a new sandbox image candidate;
- both: promote only a tested Factory/image pair.

For image candidates, hosted CI stops after source validation. OPS runs `deployment/mcode-sandbox/build-validate.sh` on the approved native ARM64 builder; the script already refuses dirty provenance and builds/verifies every canonical profile ([build-validate.sh:4-45](../../deployment/mcode-sandbox/build-validate.sh#L4-L45)). OPS publishes immutable digests, records the descriptor/runtime compatibility pair, and updates the selected Factory/Platform environment. Factory admission already rejects profile or image mismatch before execution ([runtime-probe.sh:4-43](../../deployment/mcode-sandbox/runtime-probe.sh#L4-L43)).

### Promotion, observability, and rollback

Promotion should be staged: artifact eligibility, Factory consumer acceptance, optional image acceptance, non-production/canary session, then live traffic. At startup and session creation, emit structured, secret-free fields for Factory release, capability digest, construction contract, Code SDK/Factory versions, session ID, sandbox profile/image digest, and PMM generation. Count construction rejection, descriptor mismatch, sandbox admission failure, PMM rollback, missing persisted mode, and session reattachment failure.

Rollback selects the previous **known-good compatible tuple**:

```text
Factory server artifact
+ MCode capability digest
+ database/schema compatibility
+ sandbox profile and immutable image digest (when required)
```

Keep the old Factory release available while incompatible sessions drain. Select the previous immutable image digest rather than moving a tag. Persistent state migrations must be backward-compatible across the rollback window or have an independently tested restore/migration plan; changing the controller projection must never imply destructive state migration. PMM generation rollback remains local to the affected checkout and does not force a Factory deployment rollback.

Failure behavior is uniformly fail-closed:

- unsupported contract/schema, digest mismatch, missing canonical mode/subagent, or unsafe merge: Factory does not become ready;
- missing provider credential for the selected provider/model: reject startup/session use; do not switch provider or alias;
- incompatible persisted mode: reject or route to the old release; do not choose another mode;
- sandbox profile/image/runtime mismatch: reject and clean up the workspace; do not fall back to Local;
- invalid project generation: retain that sandbox's last-known-good PMM generation and report diagnostics.

## Staged implementation plan for #125 / #119

### Stage A — toolkit-only contract work (#125)

1. Refactor MCode construction into the host-neutral `McodeControllerIngredientsV1` builder. Pass the one startup-resolved `ModelProfile`; keep local runtime/session/TUI and PMM activation downstream.
2. Generate and validate `McodeCapabilityDescriptorV1` from the executable projection. Keep it derived and secret-free.
3. Adapt local MCode to consume the builder without behavior change; retain the existing local runtime contracts.
4. Add Factory-side adapter code that can consume the ingredients once the upstream seam exists. Do not import `PreparedMcodeRuntime` or `MountedMcodeRuntime`.
5. Add packed-artifact, local/Factory parity, explicit-settings, two-session isolation, restart/reattach, and compatibility-failure tests.

This stage can prepare all toolkit code and tests behind a fixture seam, but it cannot complete real Factory controller parity against the inspected upstream public API.

### Stage B — upstream Mastra seam (#125)

1. Add the narrow `codeConstruction` input to `MastraFactoryConfig` in the Mastra monorepo and merge only modes, subagents, and allowlisted initial state before `prepareAgentControllerMount()`.
2. Add upstream tests proving Factory still owns one controller, protected host fields cannot be replaced, state precedence is explicit, and custom modes/subagents appear in created sessions.
3. Consume a reviewed official upstream release. Record the upstream version/commit and run both upstream package tests and the toolkit consumer contract; no Mastra fork is permitted for this scope.
4. Pin the accepted package artifact in this repository and remove any temporary test shim. No upstream source copy belongs here.

### Stage C — sandbox-backed project configuration (#125 completing #119)

1. Preserve Code-compatible lookup in the persisted clone. Explicitly enumerate supported hosted surfaces and fail/report unsupported ones; never resolve from the Factory source checkout or host-global directories.
2. Add sandbox-backed PMM ports for specialists, transactional MCP, host registration/tool snapshots, and generation diagnostics. Reuse the PMM's validation and commit/rollback ownership rather than duplicating discovery in Factory.
3. Prove two-session checkout, credential, mutable-state, mode, and PMM-generation isolation; prove restart/reattachment and last-known-good rollback.
4. Record controller capability, sandbox image, and project generation identities in session diagnostics.

### Stage D — publication and deployment (OPS-owned #119)

1. Establish source CI for the documented gates and retain exact package/descriptor artifacts. Keep private workspace packages commit-bound unless cross-repository consumption creates a real need for a registry.
2. For runtime-layer changes, run the native ARM64 image gate, publish both required profile images under immutable digests, and record their compatible capability/runtime contracts.
3. Promote a tested Factory/image tuple, run live provision/reattach/health/secret-delivery evidence, and rehearse rollback with persistent and in-flight sessions.
4. Only after the single-project criteria pass should a future multi-project index/registry be considered. That later control plane may persist the same descriptor; it must not invent a second executable configuration format.

## Risks, blockers, and unknowns

- **Confirmed blocker:** installed Factory `0.3.0` and inspected upstream `0.5.0` expose no controller-construction input. Real Factory parity requires the narrow seam in an official upstream release.
- **Session merge semantics need proof:** upstream Factory stores model packs, memory settings, and session state. The exact precedence between projected defaults, persisted selections, Factory security state, and Code SDK settings must be contract-tested before implementation; it should not be inferred from the local settings file.
- **Hosted Code surfaces are incomplete:** current Factory has sandbox workflow execution, but specialist and transactional MCP activation are not yet wired per sandbox session. Hooks, commands, plugins, and skill refresh also need an explicit support matrix and trust policy.
- **Canonical agents in request-aware workspaces need integration evidence:** local agents are created against a checkout workspace, while Factory supplies a request-aware workspace factory. The parity test must prove canonical agent filesystem/command tools resolve the session workspace and never the Factory checkout.
- **Package publication is not designed:** all `@rlabs/*` packages are private workspace packages. Registry, signing/provenance, retention, and promotion ownership are future decisions, not prerequisites for the monorepo path.
- **Hosted CI is not implemented in this snapshot:** there is no checked-in workflow. The lifecycle above is a target contract, not evidence of an existing automation service.
- **External deployment assumptions remain unverified:** no live Platform, PostgreSQL, Redis, WorkOS, Infisical runtime-secret delivery, native ARM64 publication, canary routing, or persistent rollback was exercised in this research. Repository policy already assigns image publication/live reconciliation to OPS; exact artifact registry, deployment operator, and rollout commands are intentionally unspecified.

## Recommendation

Implement #125 around a typed `@rlabs/mcode` construction projection and a derived capability descriptor. Add the smallest upstream Factory input that accepts modes, subagents, and allowlisted initial defaults before Factory constructs its one controller, with Factory-owned fields protected by explicit merge rules. Build and promote Factory from an exact toolkit revision; rebuild the sandbox only when its runtime contract changes; record compatible release/image/session identities; and roll back to a prior admitted tuple without source scanning, runtime import, mutable tags, or silent fallback.
