# @mastrasystem/agents

Core Mastra agents package — supervisor pattern with specialist agents, createTool workflows, and Mastra server bootstrap.

## Package Structure

```
src/
  agents/        — Agent definitions (supervisor, scout, researcher, architect,
                    advisor, developer, validator, control)
  tools/          — createTool + Zod schema patterns
  workflows/      — createWorkflow definitions
  scorers/        — Eval/scorer configs
  mastra/         — Mastra server bootstrap
```

## Key Patterns

- **Supervisor-delegation**: One orchestrator (`supervisorAgent`) delegates to specialist Mastra Agent instances
- **Strict prompt discipline**: Evidence discipline + blocker protocol fragments
- **Zod-typed tools**: Every tool uses `createTool` with typed input/output schemas
- **Composite storage**: PostgresStore + DuckDBStore via MastraCompositeStore
- **Step ceilings**: Each agent has a hard `maxSteps` default to prevent runaway loops

## Slack Channel Integration (RT88-66)

The shared `orchestratorAgent` and `supervisorAgent` support Mastra Channels with the official Chat SDK Slack adapter.

- Adapter package: `@chat-adapter/slack`
- Enable Slack adapter: set `ENABLE_SLACK_CHANNEL=true`
- Credentials are sourced from Chat SDK standard env vars (for webhook mode):
  - `SLACK_BOT_TOKEN`
  - `SLACK_SIGNING_SECRET`

When enabled, Mastra exposes agent-owned webhook endpoints for Slack events:

- `/api/agents/orchestrator-agent/channels/slack/webhook`
- `/api/agents/supervisor-agent/channels/slack/webhook`

Recommended Slack behavior for this integration:

- Use app mentions and thread replies as the primary interaction surface.
- Keep responses thread-continuous for follow-ups.
- Use webhook signature verification (via Slack signing secret) and dedupe in upstream webhook ingress/middleware.

## Linear Channel Integration (RT88-68)

The shared `supervisorAgent` supports the Palmer Linear app actor through Mastra Channels with the official Chat SDK Linear adapter.

- Adapter package: `@chat-adapter/linear`
- Required webhook secret: `LINEAR_WEBHOOK_SECRET`
- Required auth for the production app: `LINEAR_CLIENT_ID` + `LINEAR_CLIENT_SECRET`
- Required mode for the app actor: `LINEAR_CHANNEL_MODE=agent-sessions`
- Recommended token encryption: `LINEAR_ENCRYPTION_KEY`
- Install scopes: `read,write,comments:create,issues:create,app:mentionable,app:assignable`
- Persistent channel state: `@chat-adapter/state-pg` using `DATABASE_URL`

When configured, Mastra exposes the supervisor-owned webhook endpoint for Palmer Linear events:

- `/api/agents/supervisor-agent/channels/linear/webhook`

The Linear OAuth app should enable both Comments and Agent session events, plus Issues and Emoji reactions if those events are needed by the agent. `agent-sessions` mode is required for Linear app-actor sessions; the code explicitly prefers top-level OAuth app credentials over fallback API-key auth when `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` are set. OAuth workspace installations are stored in Chat SDK state, so the channel config uses the official Postgres state adapter rather than Mastra's default in-memory cache for generic `state.get/set` keys.

Use `npm run linear:install-url` to generate the Linear app-actor install URL from `LINEAR_CLIENT_ID`, `LINEAR_REDIRECT_URI`, and `LINEAR_OAUTH_SCOPES`. This is an operator helper only; runtime traffic still uses the Mastra channel webhook route.

## linear-acp-client Integration

`linear-acp-client` is the direct Linear Agent Session to ACP bridge. It is separate from Palmer and does not use the Chat SDK Linear adapter.

- Webhook endpoint: `/api/linear-acp-client/linear/webhook`
- Enable flag: `ENABLE_LINEAR_ACP_CLIENT=true`
- Required webhook secret: `LINEAR_ACP_CLIENT_WEBHOOK_SECRET`
- Required outbound Linear auth for smoke testing: `LINEAR_ACP_CLIENT_API_KEY` or `LINEAR_ACP_CLIENT_ACCESS_TOKEN`
- Default state file: `.mastra/linear-acp-client-state.json`

For a production Linear agent app, create a separate Linear OAuth app for `linear-acp-client`, enable Agent session events, request `read,write,comments:create,issues:create,app:mentionable,app:assignable`, and install with `actor=app`. The current bridge can consume an app actor token through env for a smoke test; full multi-workspace OAuth callback and token storage is a follow-up if this app needs normal install/upgrade flow.

## GitHub Channel Integration

The shared `orchestratorAgent` and `supervisorAgent` support Mastra Channels with the official Chat SDK GitHub adapter.

- Adapter package: `@chat-adapter/github`
- Enable GitHub adapter: set `ENABLE_GITHUB_CHANNEL=true`
- Required webhook secret: `GITHUB_WEBHOOK_SECRET`
- Required auth: either `GITHUB_TOKEN` or `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY`
- Optional single-tenant GitHub App install: `GITHUB_INSTALLATION_ID`

When enabled, Mastra exposes agent-owned webhook endpoints for GitHub events:

- `/api/agents/orchestrator-agent/channels/github/webhook`
- `/api/agents/supervisor-agent/channels/github/webhook`

Configure GitHub webhooks or GitHub App events for issue comments and pull request review comments.

## Proxy Gateway

The Mastra server registers the hosted OpenAI-compatible proxy as a custom model gateway with ID `proxy`.

- Gateway-facing model ID: `proxy/openai/gpt-5.5`
- Proxy endpoint: `https://aa.renaissancelab.org/v1`
- Proxy auth: set `PROXY_API_KEY`
- Upstream reference: [`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI), also indexed on [DeepWiki](https://deepwiki.com/router-for-me/CLIProxyAPI)

The proxy expects the upstream model name without the gateway/provider namespace, for example `gpt-5.5`. ACP thinking levels use CLIProxy's model suffix shape, for example `proxy/openai/gpt-5.5` with `High` thinking is sent through Mastra as `proxy/openai/gpt-5.5(high)` and reaches the proxy as `gpt-5.5(high)`.

## Compose Dev Stack

The stack in top-level `compose.yml` runs:

- `mastra-server`: Mastra dev server and Studio via `npm run dev`, exposed on port `4111` by default.
- `mastra-sandbox`: the DockerSandbox execution container. It uses the prebuilt `daytona-agents` snapshot image as a coding image artifact; it does not start Daytona services.
- `mastra-postgres`: Postgres storage for Mastra memory, workflows, and control-plane state.
- `webhook-server`: a small raw-body HTTP proxy that forwards webhook requests to `mastra-server` over the Compose network.
- `cloudflare-webhook-tunnel`: an optional Cloudflare Tunnel connector forwarding public HTTPS traffic to `webhook-server`.

The stack intentionally does not run the Daytona control plane. Daytona remains a reference/source repo for the sandbox image and PTY/computer-use research, not a service in this Compose graph.

Start the local stack:

```bash
docker compose --env-file mastra-agents/.env up -d --build
```

The deployed internal Docker network endpoints are:

```text
http://mastra-server:4111
http://webhook-server:8080
postgresql://mastra:mastra@mastra-postgres:5432/mastra
```

From the Docker host, the default endpoints are:

```text
http://localhost:4111
postgresql://mastra:mastra@localhost:5433/mastra
```

Set `MASTRA_SERVER_HOST_PORT` or `POSTGRES_HOST_PORT` if either host port is already in use.
Set `WEBHOOK_MASTRA_UPSTREAM_URL` only when the webhook relay should forward somewhere other than the Compose-managed `mastra-server`.

## Public Webhook Tunnel

Create a remotely managed Cloudflare Tunnel in Cloudflare Zero Trust, copy its connector token into `CLOUDFLARED_TUNNEL_TOKEN`, and configure a public hostname for the tunnel with this service target:

```text
http://webhook-server:8080
```

Start the stack with the public tunnel profile:

```bash
docker compose --env-file mastra-agents/.env --profile public-webhook up -d --build
```

Use the deployed public hostname for platform webhooks:

```text
https://webbb.renaissancelab.org/api/agents/orchestrator-agent/channels/slack/webhook
https://webbb.renaissancelab.org/api/agents/orchestrator-agent/channels/github/webhook
https://webbb.renaissancelab.org/api/agents/supervisor-agent/channels/slack/webhook
https://webbb.renaissancelab.org/api/agents/supervisor-agent/channels/linear/webhook
https://webbb.renaissancelab.org/api/agents/supervisor-agent/channels/github/webhook
https://webbb.renaissancelab.org/api/linear-acp-client/linear/webhook
```
