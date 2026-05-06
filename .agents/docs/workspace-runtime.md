# Workspace Runtime Configuration

This note records the workspace runtime assumptions that should be preserved when this repository is packaged or copied into an agent tarball.

## Default Access Model

The Mastra workspace is configured like a regular coding-agent deployment:

- File tools default to the user home directory, `/container`, and `/shared`.
- Root-owned system areas such as `/root`, `/etc/systemd`, and system service configuration paths are outside the default file-tool roots.
- `MASTRA_WORKSPACE_ACCESS_ROOTS` can override file-tool access when a deployment needs a different boundary.
- Relative workspace paths still resolve from `MASTRA_WORKSPACE_ROOT`.
- The command sandbox uses `MASTRA_WORKSPACE_COMMAND_CWD` as its default working directory.
- Local command execution uses Mastra's native sandbox isolation when available (`bwrap` on Linux, `seatbelt` on macOS) and binds only the configured workspace access roots as writable paths.
- System binary paths may remain available read-only to allow normal development commands to run, but root-owned service/configuration paths should not be included in workspace access roots.

## Built-In Workspace Tools

Use Mastra's built-in workspace tools instead of adding duplicate custom tools.

- Shell execution is provided by `WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND`.
- Do not add a separate custom `bash` tool for this runtime.
- Skills are provided by the Workspace `skills` configuration and exposed as Mastra's built-in `skill`, `skill_read`, and `skill_search` tools.
- Do not add custom skill listing or skill reading tools unless Mastra's native skill interface is intentionally replaced.

## Docker Sandbox Path Mapping

When `MASTRA_WORKSPACE_SANDBOX=docker`, there are two path roots to keep distinct:

- `MASTRA_WORKSPACE_FILESYSTEM_ROOT` is the Mastra server-side filesystem root used by built-in `mastra_workspace_*` file tools. In Compose this is `/app`.
- `MASTRA_WORKSPACE_MOUNT_ROOT` is the path agents should use in prompts and tool calls. In Compose this is `/workspace`.
- `MASTRA_DOCKER_SANDBOX_HOST_WORKSPACE_ROOT` is the host path used when `@mastra/docker` has to create a sandbox container. In Compose this defaults to the host project path.

The built-in workspace file tools strip `/workspace` and resolve the remainder through `MASTRA_WORKSPACE_FILESYSTEM_ROOT`. The sandbox container also mounts the same project at `/workspace`, so inherited specialist workspace tools and sandbox shell paths describe the same repository through client-facing `/workspace/...` notation.

## Skill Paths

The workspace imports skills from:

- `.agents/skills`
- `~/.agents/skills`

This keeps project-local skills available while also allowing the user's home-level agent skills to be used by the same runtime.

## Current Source Of Truth

The implementation lives in:

- `mastra-agents/src/workspace.ts`
- `mastra-agents/src/workspace-paths.ts`

The root `README.md` documents the user-facing environment variables and default access behavior.

## ACP Source And Build Output

ACP TypeScript source lives in `mastra-agents/acp`.

The compiled ACP runtime is emitted to `compiled/mastra-agents/acp` by `npm run acp:build --workspace @mastrasystem/agents`. That output is ignored by git through the root `compiled/` ignore rule.

Do not edit generated ACP files. Edit `mastra-agents/acp/*.ts`, then rebuild.
