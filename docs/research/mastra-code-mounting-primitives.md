# Mastra Code mounting primitives

Research date: 2026-08-04 (America/Vancouver)

Installed versions inspected: `@mastra/code-sdk@1.1.1`, `@mastra/core@1.55.0`, `mastra@1.21.0`. The published SDK includes source maps with the original TypeScript; links below point to the shipped JavaScript or declarations so the findings are reproducible from this checkout.

Evidence labels used below:

- **Documented** — current official Mastra/Code documentation or first-party blog.
- **Installed code** — behavior/types in the exact installed package versions above.
- **Inference** — an architectural conclusion, not a promised upstream contract.

## Executive conclusion

Mastra Code does not have one generic “mount this project configuration” API. It has a runtime composition root plus several narrower resolvers:

1. `cwd` is resolved to a Git top-level directory (or the absolute filesystem path outside Git).
2. instruction, skill, MCP, hook, command, and plugin resolvers use that detected root.
3. `createMastraCodeAgentController()` constructs an inert controller and resources; `bootLocalAgentController()` initializes it for one local session; `mountAgentControllerOnMastra()` or `prepareAgentControllerMount()` attaches it to a server-owned `Mastra` instance.
4. Mastra framework **file-based agents and workflows are a separate build/dev-time bundler feature**. `createMastraCode()` does not discover `src/mastra/agents` or `src/mastra/workflows`.

For this repository, borrow the SDK's project detection, instruction/skill/MCP compatibility conventions, controller mount functions, and `Workspace` boundary. Build a thin toolkit-owned adapter that imports canonical agents/tools/workflows in code and passes them through public options. Do not duplicate canonical agents into Mastra Code file conventions or depend on the framework bundler to populate the Code runtime.

## 1. The core runtime mount

**Documented.** Mastra Code is described as a composable library: `createMastraCode()` accepts overrides and its `AgentController` can drive frontends other than the bundled TUI. Public options include `cwd`, `modes`, `subagents`, `extraTools`, `disabledTools`, `workspace`, `configDir`, programmatic `mcpServers`, and disable flags for discovery ([Customization](https://code.mastra.ai/customization), [API reference](https://code.mastra.ai/reference)).

**Installed code.** The current package has a more explicit three-way composition surface than the public Code reference page shows:

- `createMastraCodeAgentController(config)` builds storage, memory, MCP, hooks, plugins, agent, modes, workspace resolver, and controller, but deliberately does not initialize or create a session ([index.js:165](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:165), [index.d.ts:106](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.d.ts:106)).
- `bootLocalAgentController(config)` initializes the controller and creates the eager local session used by TUI/headless runs ([index.js:636](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:636)). `createMastraCode` is now its compatibility alias ([index.js:730](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:730)).
- `mountAgentControllerOnMastra()` mounts onto a caller-owned `Mastra`, or creates one, and `prepareAgentControllerMount()` exposes constructor arguments plus a `finalize()` phase for hosts whose entry file must visibly construct `new Mastra(...)` ([index.d.ts:179](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.d.ts:179), [index.js:657](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:657)).

The extension options in the installed declarations include custom modes/subagents, static or request-aware extra tools, input processors, post-tool observation, storage/vector/memory, a dynamic or static `Workspace`, MCP servers, plugin manager, browser, PubSub, and interval handlers ([index.d.ts:21](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.d.ts:21)).

**Inference.** `mountAgentControllerOnMastra()` is the best public seam for a shared Studio/Factory/Code server. `bootLocalAgentController()` is the right seam for a thin terminal wrapper. Canonical toolkit agents should be imported and supplied as mode/subagent objects; canonical tools should be supplied through `extraTools` or the agent definitions. This keeps one source of truth and avoids an upstream fork.

## 2. Project root, Git identity, and worktrees

**Documented.** The API says `cwd` defaults to `process.cwd()` and is used for project detection. Resource IDs are generated from the Git remote URL or filesystem path, and may be overridden for monorepo isolation or cross-repository sharing ([API reference](https://code.mastra.ai/reference), [Configuration — Resource ID override](https://code.mastra.ai/configuration#resource-id-override)). Mastra Code advertises project-scoped conversations and worktree support ([announcement](https://mastra.ai/blog/announcing-mastra-code)).

**Installed code.** `detectProject()`:

- resolves the input path;
- uses `git rev-parse --show-toplevel` as `rootPath` when inside Git;
- detects a linked worktree by comparing `--git-common-dir` with `.git`/`--git-dir`, and records `mainRepoPath`;
- takes `origin`, or the first available remote, and the current branch;
- hashes the normalized remote URL for project identity, falling back to the main repo path or detected root ([project.js:54](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/utils/project.js:54), [project.d.ts:7](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/utils/project.d.ts:7)).

The controller then scopes configuration, MCP, hooks, plugins, and default workspace to `project.rootPath`. Its local session ID is derived from the resource ID, while owner identity also includes the concrete root path ([index.js:241](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:241)). For a hosted sandbox, state may carry `sandboxWorkdir` and a more specific `worktreePath`; the workspace binds to `worktreePath || workdir` ([schema.d.ts:18](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/schema.d.ts:18), [workspace.js:128](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:128)).

**Inference.** Start the runtime with `cwd` at the intended checkout/worktree. Do not independently search upward for a toolkit manifest and then give Mastra Code a different `cwd`: its config and workspace boundaries are tied to the detected Git top-level. A monorepo wanting package-level thread isolation needs an explicit `resourceId`; that does not change the filesystem root.

## 3. `AGENTS.md` / `CLAUDE.md` mounting

**Documented.** Mastra Code loads project-specific instructions into the system prompt. At project scope it takes the first non-empty match across root, `.claude/`, then `.mastracode/`; at each location `AGENTS.md` wins over `CLAUDE.md`. It also loads one global match from the documented home/config locations ([Configuration — Agent instructions](https://code.mastra.ai/configuration#agent-instructions)).

**Installed code.** Static loading matches that order, returns global instructions first and project instructions second, and allows a custom `configDir` to replace `.mastracode` ([agent-instructions.js:11](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/prompts/agent-instructions.js:11), [agent-instructions.js:139](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/prompts/agent-instructions.js:139)). The full dynamic prompt composes base prompt, formatted instruction files, model prompt, and mode prompt on each request ([prompts/index.js:20](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/prompts/index.js:20)).

Nested instructions are not all eagerly mounted. An `AgentsMDInjector` processor reacts after a completed tool call references a path, walks that path's ancestry for `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md`, and injects a deduplicated reminder capped at 1,000 estimated tokens by default ([core agent bundle:16533](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/core/dist/agent-0y2cApTZ.js:16533), [core agent bundle:16653](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/core/dist/agent-0y2cApTZ.js:16653)). Statically loaded files are excluded from this reminder channel ([index.js:400](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:400)).

The state also models untrusted checkouts. With `untrustedCheckout: true`, project instructions are skipped unless `baseRef` is supplied; with a base ref they are read using `git show origin/<ref>:<path>` (then local ref) rather than from the checkout ([schema.d.ts:26](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/schema.d.ts:26), [agent-instructions.js:27](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/prompts/agent-instructions.js:27)).

**Inference.** Borrow both layers: deterministic root/global boot instructions and path-triggered nested reminders. Also preserve the trusted-ref reader for PR/review sandboxes. The dynamic processor's inclusion of `CONTEXT.md` is an installed-code capability not mentioned by current Code docs, so treat it as version-sensitive.

## 4. Skills

**Documented.** Mastra Code searches project `.mastracode/skills`, `.claude/skills`, `.agents/skills`, then corresponding global locations. A skill is a directory containing `SKILL.md`; symlink-installed skills are resolved. Skills can be directly activated or exposed as goal entry points through metadata ([Configuration — Skills](https://code.mastra.ai/configuration#skills)).

**Installed code.** `buildSkillPaths()` implements those roots, deduplicates by realpath, and constrains project-root symlink targets to remain within the project. Plugin skill roots are appended. Global roots are not subject to the project containment check ([workspace.js:25](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:25), [workspace.js:68](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:68)). In local mode the resulting paths are both workspace skill sources and explicitly allowed filesystem paths. In hosted sandbox mode only sandbox-relative project skill paths plus an optional `WorkspaceSkillExtension` are used; host-global skill directories are not implicitly exposed ([workspace.js:148](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:148), [workspace.d.ts:7](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.d.ts:7)).

Mastra framework also supports agent-level skills, but that is a separate agent primitive. Current docs say file-based agents can define skills under their agent folder, while code-defined agents use `createSkill()`; agent-level and workspace-level skills merge at runtime ([first-class skills announcement](https://mastra.ai/blog/introducing-first-class-skills)).

**Inference.** Put executable/project-context skills on the Code workspace, not just on canonical agent definitions. For hosted sandboxes, explicitly provide a `WorkspaceSkillExtension` or provision the skill files in the sandbox; do not assume developer-machine global skills cross the boundary.

## 5. MCP configuration

**Documented.** Mastra Code supports stdio and HTTP/SSE servers, OAuth, namespaced tools, startup connection, invalid-entry reporting, and `/mcp` status/reload. Current docs list project `.mastracode/mcp.json`, global `~/.mastracode/mcp.json`, and project `.claude/settings.local.json` in descending priority ([Configuration — MCP servers](https://code.mastra.ai/configuration#mcp-servers)).

**Installed code.** Version 1.1.1 additionally loads root `.mcp.json`. Actual merge order is:

1. `.claude/settings.local.json` (lowest),
2. global `<configDir>/mcp.json`,
3. project-root `.mcp.json`,
4. project `<configDir>/mcp.json`,
5. programmatic `mcpServers` (highest).

See [mcp/config.js:6](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/mcp/config.js:6) and [mcp/manager.js:84](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/mcp/manager.js:84). `reload()` disconnects, rereads files, reapplies programmatic servers, and reconnects; there is no filesystem watcher in the SDK manager ([mcp/manager.js:345](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/mcp/manager.js:345), [mcp/manager.d.ts:13](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/mcp/manager.d.ts:13)).

**Gap.** The current Code configuration page omits `.mcp.json`, and `getConfigPaths()` also omits it even though the loader consumes it. Use the installed behavior only with a contract test; prefer programmatic `mcpServers` for canonical toolkit-owned servers and leave file discovery for user/project overrides.

## 6. Plugins, watch, and reload

**Installed code (not currently documented on code.mastra.ai).** The SDK has a public `defineMastraCodePlugin()` type whose V1 payload can provide typed config, instructions, tools, and per-tool render metadata ([plugin.d.ts:48](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugin.d.ts:48)). Plugin directories may also contain `skills/` and `commands/`; registries live at project/global `<configDir>/plugins/plugins.json` ([plugins/paths.js:5](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/paths.js:5), [plugins/loader.js:33](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/loader.js:33)). Only `.ts` entry modules are accepted in V1, and entry/root traversal is guarded ([plugins/loader.js:78](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/loader.js:78)).

`PluginManager` exposes reload/list/install/enable/config/uninstall methods and reload/update listeners. Active local entry files are polled every 500 ms and reloaded on mtime change. GitHub plugin checkouts are polled every 60 seconds and refreshed, with a backup branch created for local divergence/changes before reset ([plugins/manager.d.ts:9](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/manager.d.ts:9), [plugins/manager.js:121](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/manager.js:121), [plugins/manager.js:160](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/manager.js:160)). Plugin tool objects are live proxies and refresh before execution.

**Gap/inference.** The factory snapshots plugin skill paths, command paths, and instructions into initial controller state, and does not itself subscribe to `PluginManager.onReload`; only tool proxies are inherently live ([index.js:509](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:509)). A custom host that wants hot plugin instructions/skills/commands must subscribe and update session state or rebuild the session. Also, only the entry file is watched; changes solely to plugin asset directories are not a guaranteed reload trigger. Because this surface is undocumented and V1-specific, treat plugins as optional/version-gated rather than the canonical toolkit mount.

## 7. File-based agents and workflows: build-time, not Code runtime

**Documented.** File-based agents are a beta Mastra framework feature added in `@mastra/core@1.50.0`. The `mastra dev` / `mastra build` bundler discovers conventions under `src/mastra`, imports modules, reads Markdown, copies workspace seeds, and registers assembled primitives. Directly importing a `Mastra` instance does not run discovery ([File-based agents](https://mastra.ai/docs/getting-started/file-based-agents)). Supported conventions include agent config/instructions/tools/skills/memory/workspace/processors/scorers/subagents and top-level `src/mastra/workflows/`.

**Installed code.** The deployer rejects symlinked discovery inputs, test files, and symlinked directories; discovers agent directories containing `config.(ts|js)` or `instructions.md`; and discovers only workflow modules with a default export ([deployer build:103](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/deployer/dist/build-KCOeHd4N.js:103), [deployer build:345](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/deployer/dist/build-KCOeHd4N.js:345), [deployer build:371](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/deployer/dist/build-KCOeHd4N.js:371)). It generates a wrapper that imports and registers discovered agents/workflows; in development the wrapper is regenerated when `instructions.md` changes ([deployer build:547](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/deployer/dist/build-KCOeHd4N.js:547)). `assembleAgentFromFsEntry()` is public, performs no filesystem I/O itself, and documents merge/precedence rules ([fs-routing declarations](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/core/dist/agent/fs-routing/index.d.ts:120)).

**Inference.** This is useful for Studio projects, but it is not a Mastra Code config mount. The Code SDK has no `agentsDir`, `workflowsDir`, or `workflows` option. A caller-owned `Mastra` passed to `mountAgentControllerOnMastra()` may already host registered workflows, but the controller does not automatically expose them as Code modes or tools. Reuse canonical code-defined agent/workflow exports across hosts; if a workflow must be callable from Code, expose a deliberately scoped tool or plugin tool that invokes it.

## 8. Workspace and sandbox boundary

**Documented.** A Mastra `Workspace` composes filesystem, sandbox, skills, search/LSP, and tool policy. Local files and commands should point at the same directory; cloud filesystems can be composed through non-overlapping mounts. `LocalFilesystem.allowedPaths` grants least-privilege access outside the base path and can be updated at runtime ([Workspace overview](https://mastra.ai/docs/workspace/overview), [workspace/security changelog](https://mastra.ai/blog/changelog-2026-02-19#least-privilege-filesystem-access-with-allowedpaths)). The Code API explicitly allows overriding `workspace` ([API reference](https://code.mastra.ai/reference)).

**Installed code.** The default local Code workspace uses:

- `LocalFilesystem({ basePath: projectPath, allowedPaths })`;
- `LocalSandbox({ workingDirectory: projectPath })`;
- project/global/plugin skill roots plus OS temp and plan directories as allowed paths;
- per-session `sandboxAllowedPaths`, updated through the suspending `request_access` tool ([workspace.js:163](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:163), [request-sandbox-access.js:7](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/tools/request-sandbox-access.js:7)).

Hosted project sessions reattach a persisted sandbox and use `SandboxFilesystem` so file and command tools see the same VM. Its path resolver prevents lexical escape, verifies realpaths to block symlink escape, and fails closed when canonicalization is impossible ([sandbox-filesystem.js:4](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/sandbox-filesystem.js:4), [sandbox-filesystem.js:51](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/sandbox-filesystem.js:51)). Sandbox reattachment itself is an explicit registered host extension point ([sandbox-reattach.js](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/sandbox-reattach.js:3)).

**Inference.** Override the Code workspace with the toolkit's cloneable sandbox-machine adapter only if it preserves the invariant that filesystem and command execution share one checkout and one containment root. Treat allowed external paths as session state, not global process state. Do not mount host credentials/global skills into ephemeral sandboxes implicitly.

## 9. Submodules and other gaps

**Installed-code search result.** No `submodule`, `.gitmodules`, or `--recurse-submodules` handling exists in the inspected Code SDK, Core file-router, or Mastra CLI files (excluding changelogs). Project detection simply asks Git for the top level of the supplied `cwd`; if launched inside an initialized submodule it will therefore identify that submodule repository, while launch from the superproject does not create separate submodule mounts.

**Inference.** Ordinary filesystem tools can traverse a checked-out submodule directory because it is under the workspace root, but cloning, initialization, trust, identity, and per-submodule instructions are not a supported mount contract. Build explicit submodule provisioning and trust policy only if a real use case requires it; otherwise treat submodules as pre-existing files inside the chosen workspace.

Other unknowns/version risks:

- Code docs do not currently document the plugin system or explicit inert/server mount factories.
- Docs and installed code disagree about root `.mcp.json` discovery.
- Framework file-based agents are beta and source/bundler driven; they are not safe as a stable cross-host canonical representation yet.
- The installed package contains no `mastracode` TUI package, so TUI-only plugin command refresh behavior could not be verified locally. Findings above are for `@mastra/code-sdk@1.1.1`.

## Recommendation: borrow vs. build

### Borrow directly

- `detectProject(cwd)` semantics and explicit `resourceId` override.
- `bootLocalAgentController()` for a local wrapper; `mountAgentControllerOnMastra()` / `prepareAgentControllerMount()` for server ownership.
- `AGENTS.md` / `CLAUDE.md` lookup, nested reminder processor, and trusted-base-ref reader.
- Workspace-based skills and Code's `.mastracode` / `.claude` / `.agents` compatibility roots.
- Programmatic `mcpServers` plus user/project file discovery and explicit reload.
- `Workspace` as the filesystem/command/skills/LSP boundary, including request-based external path approval.
- Public `modes`, `subagents`, `extraTools`, `inputProcessors`, `postToolObserver`, `workspace`, memory/storage, PubSub, and headless APIs.

### Build in the toolkit adapter

- One typed projection from canonical toolkit agents/tools/model profiles into Code modes/subagents/tools; no copied prompt or agent definitions.
- A shared workflow registry and deliberate workflow-as-tool adapters where Code actually needs workflow access.
- Sandbox-machine construction/reattachment and credential policy; pass the resulting workspace through the supported override.
- Contract tests pinning root/worktree identity, instruction precedence, skill roots, MCP merge order, and workspace containment against the installed SDK version.
- Optional plugin reload wiring for skills/instructions/commands if plugins are adopted.
- Explicit submodule provisioning/trust only when justified.

### Avoid for now

- An upstream fork for behavior already covered by these extension points.
- Treating `src/mastra/agents` file routing as the canonical Code mount; it is build-time Mastra CLI behavior and beta.
- Treating plugins as the canonical runtime definition format; the surface is currently undocumented and its non-tool hot reload needs host wiring.
- Broadly exposing the host filesystem or silently carrying global skills/credentials into remote sandboxes.
