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

The shared `supervisorAgent` now supports Mastra Channels with the official Chat SDK Slack adapter.

- Adapter package: `@chat-adapter/slack`
- Enable Slack adapter: set `ENABLE_SLACK_CHANNEL=true`
- Credentials are sourced from Chat SDK standard env vars (for webhook mode):
  - `SLACK_BOT_TOKEN`
  - `SLACK_SIGNING_SECRET`

When enabled, Mastra exposes this webhook endpoint for Slack events:

- `/api/agents/supervisor-agent/channels/slack/webhook`

Recommended Slack behavior for this integration:

- Use app mentions and thread replies as the primary interaction surface.
- Keep responses thread-continuous for follow-ups.
- Use webhook signature verification (via Slack signing secret) and dedupe in upstream webhook ingress/middleware.

## Linear Channel Integration (RT88-68)

The shared `supervisorAgent` supports Mastra Channels with the official Chat SDK Linear adapter.

- Adapter package: `@chat-adapter/linear`
- Required webhook secret: `LINEAR_WEBHOOK_SECRET`
- Required auth: one of `LINEAR_API_KEY`, `LINEAR_ACCESS_TOKEN`, `LINEAR_CLIENT_ID` + `LINEAR_CLIENT_SECRET`, or `LINEAR_CLIENT_CREDENTIALS_CLIENT_ID` + `LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET`
- Inbound mode: `LINEAR_CHANNEL_MODE=comments` or `LINEAR_CHANNEL_MODE=agent-sessions`

When configured, Mastra exposes this webhook endpoint for Linear events:

- `/api/agents/supervisor-agent/channels/linear/webhook`

`comments` mode uses Linear comment webhooks. `agent-sessions` mode is for Linear app-actor agent session events.

## GitHub Channel Integration

The shared `supervisorAgent` supports Mastra Channels with the official Chat SDK GitHub adapter.

- Adapter package: `@chat-adapter/github`
- Enable GitHub adapter: set `ENABLE_GITHUB_CHANNEL=true`
- Required webhook secret: `GITHUB_WEBHOOK_SECRET`
- Required auth: either `GITHUB_TOKEN` or `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY`
- Optional single-tenant GitHub App install: `GITHUB_INSTALLATION_ID`

When enabled, Mastra exposes this webhook endpoint for GitHub events:

- `/api/agents/supervisor-agent/channels/github/webhook`

Configure GitHub webhooks or GitHub App events for issue comments and pull request review comments.

## Webhook Server With Cloudflare Tunnel

The stack in `compose.webhooks.yml` runs:

- `webhook-server`: a small raw-body HTTP proxy that forwards webhook requests to the Mastra server already running on the Docker host.
- `cloudflare-webhook-tunnel`: a Cloudflare Tunnel connector forwarding public HTTPS traffic to `webhook-server`.

Create a remotely managed Cloudflare Tunnel in Cloudflare Zero Trust, copy its connector token into `CLOUDFLARED_TUNNEL_TOKEN`, and configure a public hostname for the tunnel with this service target:

```text
http://webhook-server:8080
```

By default the proxy forwards to host Mastra at:

```text
http://host.docker.internal:4111
```

If Docker cannot reach `host.docker.internal` from this workspace, set `MASTRA_UPSTREAM_URL` to the workspace container IP, for example `http://172.30.10.102:4111`.

Then start the webhook stack:

```bash
docker compose -f compose.webhooks.yml --env-file mastra-agents/.env up -d --build
```

Use the public hostname for platform webhooks:

```text
https://your-webhook-domain.example.com/api/agents/supervisor-agent/channels/slack/webhook
https://your-webhook-domain.example.com/api/agents/supervisor-agent/channels/linear/webhook
https://your-webhook-domain.example.com/api/agents/supervisor-agent/channels/github/webhook
```
