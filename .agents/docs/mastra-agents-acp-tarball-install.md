# Mastra Agents ACP Tarball Install

Use this when `mastra-agents-acp` needs to be installed as a user-global binary on another machine before the package is stable enough for npm publishing.

The standalone source package now lives in the sibling private repository:

```bash
/container/shared/workspace/projects/mastra-acp-adapter
```

Do not package ACP from `mastra-system/compiled`. The installed binary must come
from the standalone adapter tarball and point inside that package's `dist/`
directory.

## Build The Tarball

From the source machine:

```bash
cd /container/shared/workspace/projects/mastra-acp-adapter
npm run build
npm version patch --no-git-tag-version
npm pack
```

This creates a package like:

```bash
mastrasystem-mastra-agents-acp-0.1.1.tgz
```

If the version should not be bumped, skip `npm version patch --no-git-tag-version`, but prefer bumping before sharing upgrades so the receiving machine can clearly identify the installed build.

## Install On Another Machine

Copy the `.tgz` file to the target machine, then install it globally for the current user:

```bash
npm install -g ./mastrasystem-mastra-agents-acp-0.1.1.tgz
```

Verify the binary:

```bash
command -v mastra-agents-acp
mastra-agents-acp --agent-id orchestrator-agent --cwd "$PWD" --mastra-base-url http://127.0.0.1:4111 --env-file "$PWD/.env"
```

The command will normally wait for ACP JSON-RPC over stdio. Use `command -v` as the primary binary check; use an ACP smoke client when available for a full handshake.

## Runtime Env And Proxy Model

`mastra-agents-acp` only loads env files explicitly passed with `--env-file`.
Keep `--cwd` pointed at the Mastra workspace root and pass `--env-file` when
editor-spawned ACP processes need the same model and proxy settings as the
local Mastra server.

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
cd /container/shared/workspace/projects/mastra-acp-adapter
npm run build
npm version patch --no-git-tag-version
npm pack
```

On the target machine:

```bash
npm install -g ./mastrasystem-mastra-agents-acp-0.1.2.tgz
```

Reinstalling a newer tarball updates the global `mastra-agents-acp` command.

## Client Config Shape

After global install, clients should invoke the binary by name rather than using absolute paths to `src/acp/stdio.js`.

Example args:

```bash
mastra-agents-acp --agent-id supervisor-agent --cwd /path/to/workspace --mastra-base-url http://127.0.0.1:4111 --env-file /path/to/workspace/.env
mastra-agents-acp --agent-id orchestrator-agent --cwd /path/to/workspace --mastra-base-url http://127.0.0.1:4111 --env-file /path/to/workspace/.env
```

Keep `--cwd` explicit for editor/ACP clients because it defines the workspace root for the session. The installed binary path should not be hard-coded.

The binary should resolve runtime model config from the explicit `--env-file`.
If a client's model picker shows `openai/gpt-5.5` before
`proxy/openai/gpt-5.5`, the ACP process is not seeing the intended workspace
env or is running an older tarball.

## Docker Image Install

`docker/mastra-server.Dockerfile` accepts an optional release tarball URL:

```bash
docker build \
  -f docker/mastra-server.Dockerfile \
  --build-arg MASTRA_ACP_ADAPTER_TARBALL_URL=https://github.com/EugeneChan00/mastra-acp-adapter/releases/download/v0.1.1/mastrasystem-mastra-agents-acp-0.1.1.tgz \
  .
```

For private GitHub release assets, pass a token as a BuildKit secret rather than
as a build arg:

```bash
GITHUB_TOKEN_FILE="$(mktemp)"
printf '%s' "$GITHUB_TOKEN" > "$GITHUB_TOKEN_FILE"
docker build \
  -f docker/mastra-server.Dockerfile \
  --secret id=github_token,src="$GITHUB_TOKEN_FILE" \
  --build-arg MASTRA_ACP_ADAPTER_TARBALL_URL=<release-asset-url> \
  .
rm -f "$GITHUB_TOKEN_FILE"
```
