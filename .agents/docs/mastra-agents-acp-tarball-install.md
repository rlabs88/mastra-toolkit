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

## Runtime Env And Proxy Model

`mastra-agents-acp` loads `.env` from the workspace passed with `--cwd` before it creates the ACP agent. Keep `--cwd` pointed at the Mastra workspace root so editor-spawned ACP processes see the same model and proxy settings as the local Mastra server.

The expected proxy-backed model config is:

```bash
MASTRA_SUPERVISOR_MODEL=proxy/openai/gpt-5.5
PROXY_API_KEY=<proxy bearer key>
```

Do not configure ACP clients with `openai/gpt-5.5` as the default model. That bypasses the registered Mastra `proxy` gateway and makes the runtime ask for `OPENAI_API_KEY`.

Do not use `rl/openai/...` model IDs for this ACP app. The Mastra gateway registered by this repo is `proxy`, so the model ID passed to Mastra must keep the `proxy/` prefix.

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

The binary should resolve runtime model config from the workspace `.env`. If a client's model picker shows `openai/gpt-5.5` before `proxy/openai/gpt-5.5`, the ACP process is not seeing the intended workspace env or is running an older tarball.
