# Delegation capability matrix

This matrix records the supported delegation surfaces at the repository's pinned dependency set:

- `@mastra/core@1.57.0`
- `@mastra/code-sdk@1.1.3`
- `@mastra/factory@0.5.0`
- `mastracode@0.32.6`

The evidence is the installed public declarations and the public host contracts. In particular, `MastraCodeConfig` accepts `modes` and `subagents`, core `AgentConfig` accepts an `agents` map, and `MastraFactoryConfig` accepts neither those controller ingredients nor a controller-construction callback. `FactoryIntegration.agentTools()` can contribute tools only; it is not a controller configuration seam.

## Host capability

| Host surface | Delegation primitive | Targets and model policy | Controller ownership | Request workspace | Approval and cancellation | Recursion | Restart behavior |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MCode modes | AgentController-native `subagent` | Exactly `cortex`, `flux`, and `zen`, projected from the canonical role definitions, prompts, and role model mapping | Supported before construction through `@mastra/code-sdk` `MastraCodeConfig.subagents`; the mounted Code controller remains the only controller | The controller owns the bound project `Workspace`; each native leaf receives its constrained definition and the controller request context | Controller requests carry an `AbortSignal` and the parent session owns its approval gate. The toolkit does not promise nested interactive approval/resume behavior inside native leaves because that behavior is not a supported, verified public contract | Native definitions do not receive `subagent`; role-specific `use_*` and `delegate_*` tools are absent | The catalog is reconstructed from the same startup projection. Resuming an in-flight child run after process restart is not a toolkit guarantee |
| Studio registered agents | Generic Mastra supervisor `Agent({ agents })` | Each top-level Cortex, Flux, and Zen supervisor receives the same canonical leaf registry with all three roles | Studio registers ordinary agents on its one `Mastra`; this is distinct from the mounted Code controller used by Code-mode sessions | Supervisors and leaves resolve the same request-bound workspace through `mastraToolkitWorkspace`, with the host workspace as the fallback | Generic agent suspend/resume and abort behavior is Mastra Agent behavior, not the AgentController session approval contract. No cross-surface nested approval guarantee is claimed | Every supervisor points to distinct leaf agents; every leaf has an empty `agents` map | The topology is rebuilt at startup. In-flight supervisor-network recovery is not promised by this toolkit contract |
| Factory Code controller | Unavailable / upstream-blocked | Canonical agents can be registered on `Mastra`, but Factory cannot make them controller modes or native subagents through `@mastra/factory@0.5.0` | Factory constructs and owns exactly one Code controller internally | Factory already owns persisted project/user/session workspaces, but there is no public seam that safely attaches canonical delegation before controller construction | A tool adapter would bypass or have to reproduce controller-native approval, cancellation, and child lifecycle semantics, so no neutral adapter is installed | No `delegate_cortex`, `delegate_flux`, `delegate_zen`, `use_*`, or toolkit-owned `subagent` tool is exposed | Factory session and sandbox bindings remain durable; canonical child-run restart behavior remains unavailable because canonical delegation is not mounted |

## Exact Factory blocker

`@mastra/factory@0.5.0` publicly exposes `new MastraFactory(config)`, `prepare()`, `finalize()`, and `shutdown()`. Its `MastraFactoryConfig` has no `modes`, `subagents`, `MastraCodeConfig`, or controller-construction callback. Factory internally calls `prepareAgentControllerMount()` with its own workspace, storage, processors, tools, observer, PubSub, routes, and server configuration. By the time the toolkit's `ToolkitMastraFactory.prepare()` override receives `MastraArgs`, the single controller has already been constructed.

`FactoryIntegration.agentTools()` is insufficient as a neutral fallback. A toolkit-owned `subagent` tool there would execute outside the native controller child lifecycle and could not prove equivalent nested approvals, cancellation, persistence, or restart behavior. Constructing a second controller, patching Factory, or overriding protected internals is outside the supported contract. Factory delegation therefore stays unavailable until Factory exposes controller ingredients or a guarded pre-construction callback.

## Execution surface

Top-level and delegated roles do not expose `command_run` or `adhd_run`. Workspace-bound shell and file work uses Mastra's supported workspace/sandbox execution primitives. The legacy implementations remain library-only compatibility surfaces and are not part of delegation. The canonical supervisor/leaf registry, MCode native target enumeration, Studio `agents` maps, recursion boundary, and Factory blocker all use this native workspace contract.
