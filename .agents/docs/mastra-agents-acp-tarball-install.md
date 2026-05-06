# Mastra Agents ACP Tarball Install

Use this when `mastra-agents-acp` needs to be installed as a user-global binary on another machine before the package is stable enough for npm publishing.

## Build The Tarball

From the source machine:

```bash
cd /container/shared/workspace/projects/mastra-system
npm run acp:pack --workspace mastra-agents
```

This creates a package like:

```bash
compiled/mastra-agents/tarballs/mastrasystem-agents-0.1.0.tgz
```

If the version should be bumped before sharing an upgrade, update `mastra-agents/package.json` first. Do not use raw `npm pack --workspace mastra-agents` for ACP distribution because the workspace package's development `bin` points at ignored repo-local compiled output.

## Install On Another Machine

Copy the `.tgz` file to the target machine, then install it globally for the current user:

```bash
mkdir -p "$HOME/.local/bin"
npm install -g --prefix "$HOME/.local" ./mastrasystem-agents-0.1.0.tgz
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile";; esac
```

Verify the binary:

```bash
command -v mastra-agents-acp
readlink -f "$(command -v mastra-agents-acp)"
mastra-agents-acp --agent-id orchestrator-agent --cwd "$PWD" --mastra-base-url http://127.0.0.1:4111
```

The command will normally wait for ACP JSON-RPC over stdio. Use `command -v` as the primary binary check; use an ACP smoke client when available for a full handshake.

## Runtime Env And Proxy Model

`mastra-agents-acp` loads `.env` from the workspace passed with `--cwd` before it creates the ACP agent. When `--cwd` points at the repository root, the launcher also loads `mastra-agents/.env` after the root `.env` so this app's model and proxy settings win over legacy workspace settings. Keep `--cwd` pointed at the Mastra workspace root so editor-spawned ACP processes bind sessions to the right working tree.

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
cd /container/shared/workspace/projects/mastra-system
npm run acp:pack --workspace mastra-agents
```

On the target machine:

```bash
npm install -g --prefix "$HOME/.local" ./mastrasystem-agents-0.1.0.tgz
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
