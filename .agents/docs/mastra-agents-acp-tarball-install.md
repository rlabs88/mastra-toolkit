# Mastra Agents ACP Tarball Install

Use this when `mastra-agents-acp` needs to be installed as a user-global binary on another machine before the package is stable enough for npm publishing.

## Build The Tarball

From the source machine:

```bash
cd /container/shared/workspace/projects/mastra-system/mastra-agents
npm run acp:build
npm version patch --no-git-tag-version
npm pack
```

This creates a package like:

```bash
mastrasystem-agents-0.1.1.tgz
```

If the version should not be bumped, skip `npm version patch --no-git-tag-version`, but prefer bumping before sharing upgrades so the receiving machine can clearly identify the installed build.

## Install On Another Machine

Copy the `.tgz` file to the target machine, then install it globally for the current user:

```bash
npm install -g ./mastrasystem-agents-0.1.1.tgz
```

Verify the binary:

```bash
command -v mastra-agents-acp
mastra-agents-acp --agent-id orchestrator-agent --cwd "$PWD" --mastra-base-url http://127.0.0.1:4111
```

The command will normally wait for ACP JSON-RPC over stdio. Use `command -v` as the primary binary check; use an ACP smoke client when available for a full handshake.

## Upgrade Later

On the source machine:

```bash
cd /container/shared/workspace/projects/mastra-system/mastra-agents
npm run acp:build
npm version patch --no-git-tag-version
npm pack
```

On the target machine:

```bash
npm install -g ./mastrasystem-agents-0.1.2.tgz
```

Reinstalling a newer tarball updates the global `mastra-agents-acp` command.

## Client Config Shape

After global install, clients should invoke the binary by name rather than using absolute paths to `src/acp/stdio.js`.

Example args:

```bash
mastra-agents-acp --agent-id supervisor-agent --cwd /path/to/workspace --mastra-base-url http://127.0.0.1:4111
mastra-agents-acp --agent-id orchestrator-agent --cwd /path/to/workspace --mastra-base-url http://127.0.0.1:4111
```

Keep `--cwd` explicit for editor/ACP clients because it defines the workspace root for the session. The installed binary path should not be hard-coded.
