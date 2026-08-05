# Mastra Code project configuration

Research date: **2026-08-04** (America/Vancouver)

Installed code inspected: **`@mastra/code-sdk@1.1.1`** with **`@mastra/core@1.55.0`**, pinned by this repository's `package.json` / `package-lock.json`. “Official docs” below means the current first-party [Mastra Code configuration](https://code.mastra.ai/configuration), [customization](https://code.mastra.ai/customization), and [API reference](https://code.mastra.ai/reference). “Installed code” means the exact published files under `node_modules/@mastra/code-sdk/dist` in this checkout.

## Short answer

Mastra Code has no single project manifest. Its project is the Git top level detected from `cwd` (or the absolute `cwd` outside Git), and configuration is assembled from conventional files/directories plus programmatic factory options. The stable mental model is:

```text
project-root/                         # detected Git top level
├── AGENTS.md                         # or CLAUDE.md; first project match wins
├── .mcp.json                         # installed 1.1.1 compatibility input
├── .claude/
│   ├── settings.local.json           # lowest-priority MCP input
│   ├── commands/*.md
│   └── skills/*/SKILL.md
├── .agents/skills/*/SKILL.md
└── .mastracode/
    ├── AGENTS.md                     # fallback project instructions
    ├── database.json                 # resource/OM/storage legacy settings
    ├── mcp.json                      # highest-priority file MCP input
    ├── hooks.json                    # project hooks, appended after global
    ├── commands/*.md                 # highest-priority built-in command root
    ├── skills/*/SKILL.md             # highest-priority built-in skill root
    └── plugins/plugins.json          # project plugin registry
```

Global counterparts live under `~/.mastracode`, `~/.claude`, `~/.agents`, and selected `~/.config/...` instruction paths. The ordinary user settings file is different: it lives in the platform app-data directory (for example `~/Library/Application Support/mastracode/settings.json` on macOS), not in the project.

## Project root and identity

**Official docs.** `cwd` defaults to `process.cwd()` and drives project detection. Threads use a resource ID derived from Git remote or filesystem path; `MASTRA_RESOURCE_ID` or `.mastracode/database.json.resourceId` can override it ([API reference](https://code.mastra.ai/reference#create-mastra-code), [resource ID override](https://code.mastra.ai/configuration#resource-id-override)).

**Installed code.** `detectProject()` resolves `cwd`, asks Git for `rev-parse --show-toplevel`, records branch/worktree data, prefers `origin` (then the first remote), normalizes the remote URL, and produces `<slug>-<12-char-sha256>`. Without a remote it hashes the main-worktree path or root path ([project.js:56](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/utils/project.js:56)). Therefore a `cwd` nested inside a monorepo still gives the repository top level as filesystem/config root. A resource-ID override changes thread/observation grouping, not the workspace root. Override precedence is environment, project `<configDir>/database.json`, global `~/<configDir>/database.json`, then detected identity ([project.js:329](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/utils/project.js:329)). User identity is separate: `MASTRA_USER_ID`, then Git `user.email`, then OS username ([project.js:271](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/utils/project.js:271)).

## Files, scopes, and precedence

| Concern | Effective order, highest first | Merge rule / installed behavior |
|---|---|---|
| Instructions | Project: root `AGENTS.md`/`CLAUDE.md`, `.claude/`, `<configDir>/`; global: `~/.claude/`, `~/<configDir>/`, `~/.config/claude/`, `~/.config/<configDir-without-dot>/` | First non-empty match at each scope; `AGENTS.md` beats `CLAUDE.md` at one location. One global and one project file are both included, global first. Re-read while building each request's dynamic prompt ([official](https://code.mastra.ai/configuration#agent-instructions), [agent-instructions.js:129](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/prompts/agent-instructions.js:129)). |
| User settings | Programmatic options / `initialState` over global app-data `settings.json` defaults; `settingsPath` replaces the settings-file path | There is **no project `settings.json` primitive**. Settings persist onboarding, models, preferences, storage, LSP, browser, shell, voice, signals, and observability ([settings.js:8](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/onboarding/settings.js:8), [settings.js:150](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/onboarding/settings.js:150)). Project/global `<configDir>/database.json` is a narrower legacy file for LibSQL plus `resourceId`/`omScope`; storage precedence is env, global `settings.json`, project database file, global database file, local LibSQL ([project.js:170](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/utils/project.js:170)). |
| Skills | Project `<configDir>/skills`, `.claude/skills`, `.agents/skills`; then corresponding global roots; then plugin skill paths | Roots are ordered/deduplicated by realpath. Project skill symlinks are contained to the project root; plugin roots are appended ([official](https://code.mastra.ai/configuration#skills), [workspace.js:68](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:68)). |
| MCP | Programmatic `mcpServers`; project `<configDir>/mcp.json`; project `.mcp.json`; global `~/<configDir>/mcp.json`; project `.claude/settings.local.json` | Object merge by server name, later/higher source wins. Installed 1.1.1 reads `.mcp.json`, although the current docs' table omits it ([official](https://code.mastra.ai/configuration#mcp-servers), [mcp/config.js:5](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/mcp/config.js:5)). |
| Commands | Extra/plugin command dirs; project `<configDir>/commands`, `.claude/commands`, `.opencode/command`; global equivalents in that order | Markdown commands are keyed by derived command name; higher sources overwrite name collisions ([official](https://code.mastra.ai/configuration#custom-slash-commands), [slash-command-loader.js:86](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/utils/slash-command-loader.js:86)). |
| Hooks | Global `~/<configDir>/hooks.json`, then project `<configDir>/hooks.json` | Not override-by-name: arrays append by event, so global hooks execute first and project hooks second ([official](https://code.mastra.ai/configuration#hook-config-locations), [hooks/config.js:7](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/hooks/config.js:7)). |
| Plugins | Project `<configDir>/plugins/plugins.json` over global registry with the same plugin ID; disabled-ID sets combine | Installed-code feature, not described on current Code configuration/reference pages. V1 entries are `.ts` modules and may contribute tools, instructions, `skills/`, and `commands/` ([paths.js:5](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/paths.js:5), [registry.js:27](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/registry.js:27), [loader.js:8](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/loader.js:8)). |

`configDir` defaults to `.mastracode` and replaces that directory name in project/global MCP, hooks, commands, database, skills, plugins, and instruction discovery. `homeDir` affects the global hooks/plugins/skills roots exposed through the factory, but several older helpers still use OS home/environment directly; a custom `homeDir` is therefore not a complete virtual-home abstraction in 1.1.1.

## Programmatic create and mount surfaces

**Official docs.** `createMastraCode(options)` accepts `cwd`, `homeDir`, modes, subagents, extra/disabled tools, storage, memory, OM scope, `settingsPath`, `initialState`, interval handlers, workspace, `configDir`, programmatic MCP, browser/PubSub, and discovery disable flags ([API reference options](https://code.mastra.ai/reference#createmastracodeoptions)).

**Installed code.** The declarations are broader and split lifecycle explicitly ([index.d.ts:21](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.d.ts:21)):

- `createMastraCodeAgentController(config)` assembles an inert controller and shared resources.
- `bootLocalAgentController(config)` initializes it and creates one eager local session; `createMastraCode` is the backwards-compatible alias.
- `mountAgentControllerOnMastra({ mastra?, controllerId?, buildApiRoutes?, buildServerConfig?, ...config })` registers before initialization so a server-owned `Mastra` instance, storage, agents, and gateways are shared; clients then create isolated sessions ([index.d.ts:179](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.d.ts:179)).
- `prepareAgentControllerMount()` returns Mastra constructor arguments and a `finalize()` phase for generated server entrypoints ([index.d.ts:216](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.d.ts:216)).

Installed-only options absent or stale in the current public table include `inputProcessors`, `vector`, injected storage plus `storageBackend`, `disablePlugins`, `disableGithubSignals`, `disableSettingsOmSeed`, and `pluginManager`. Conversely, the public table still lists a `resolveModel` input option that the installed `MastraCodeConfig` declaration does not expose.

## Workspace and sandbox defaults

The default local workspace uses `LocalFilesystem(basePath = detected root)` and `LocalSandbox(workingDirectory = detected root)`. Outside-root access is limited to discovered skill roots, OS temp/plan directories, and per-session `sandboxAllowedPaths`; `/sandbox` / the `request_access` tool updates those session paths. LSP package runner is inferred from lockfiles ([workspace.js:163](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:163)).

Hosted repository sessions are different: when state includes `projectRepositoryId`, `sandboxId`, and `sandboxWorkdir`, the SDK reattaches the remote sandbox and binds both filesystem and command execution to `worktreePath || sandboxWorkdir`; only sandbox-relative project skills (plus an explicit skill extension) are present ([workspace.js:135](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/agents/workspace.js:135)). Passing `workspace` replaces the default resolver.

## Reload and hot-reload behavior

- Instructions are read when the dynamic prompt is built, so root/global instruction edits affect the next agent request without rebuilding the controller.
- MCP and hooks are startup snapshots with explicit `mcpManager.reload()` and `hookManager.reload()`; `/mcp` and `/hooks` expose reload in the bundled TUI. Neither manager installs a filesystem watcher ([mcp/manager.js:363](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/mcp/manager.js:363), [hooks/manager.js:28](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/hooks/manager.js:28)).
- Command discovery is a callable scan, not an SDK watcher. Skills belong to cached/reused Workspace instances; 1.1.1 provides no Code-level watcher contract for skill or command asset edits.
- Plugins expose `reload()` and listeners. Active local **entry files** are polled every 500 ms, and GitHub sources every 60 seconds; live tool proxies update. The factory snapshots plugin instructions/skill/command paths into initial state and does not itself subscribe to refresh those assets, so only plugin tools are reliably hot across reload without host wiring ([manager.js:47](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/manager.js:47), [manager.js:121](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/plugins/manager.js:121)).
- `settings.json` is read during construction (some model-use paths re-read it), so arbitrary settings changes are not a general live-reconfiguration mechanism.

## Explicit non-primitives

These are **not** Mastra Code project-configuration primitives in `@mastra/code-sdk@1.1.1`:

1. **Mastra framework file-based agents/workflows.** `src/mastra/agents/<name>/config.ts`, `instructions.md`, and `src/mastra/workflows/*` are Mastra CLI/deployer discovery conventions, not Code SDK config. The current first-party [file-based agents announcement](https://mastra.ai/blog/introducing-file-based-agents) describes that separate framework feature. The Code config type has no `agentsDir`, `workflowsDir`, or workflow registry option; mounting onto a `Mastra` that already owns agents/workflows does not automatically turn them into Code modes/tools.
2. **Submodule mounts.** The package has no `.gitmodules`, `git submodule`, or recursive-submodule mount/provisioning contract. An already checked-out submodule is merely a directory under the selected workspace; starting with `cwd` inside it may make that submodule's Git top level the project instead.
3. **A generic YAML project manifest.** YAML is used for Markdown frontmatter, but there is no `mastracode.yaml`, generic manifest loader, or schema that composes agents, workflows, mounts, and config. Supported top-level configuration is the typed factory API plus the named JSON/Markdown directory conventions above.

## Documented-versus-installed discrepancies to pin in tests

- Current MCP docs omit project-root `.mcp.json`; installed 1.1.1 loads it between global and `<configDir>/mcp.json`.
- Current public options omit several installed configuration fields and mention a `resolveModel` input absent from installed `MastraCodeConfig`.
- Plugins and the inert/server mount factories are present in installed public declarations but are not covered by the current Code configuration page.
- The public reference's state table says `yolo: false`, while customization says `true`; installed factory initial state starts at `true`, then global settings and `initialState` may override it ([index.js:528](/Users/zzmc/dev/workspace/repos/mastra-toolkit/node_modules/@mastra/code-sdk/dist/index.js:528)).

For integration work, treat the installed declaration and behavior as the pinned 1.1.1 contract, use the official docs for intended public concepts, and add contract tests around the discrepancies above before upgrading.
