# Linear Channel Webhook Issue — Orchestrator & Supervisor Agent

## Problem Statement

The Linear webhook endpoint (`/api/agents/{agentId}/channels/linear/webhook`) returns **404 Not Found** despite having a valid `LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET` configured.

## Root Cause

### 1. Channels assigned post-construction (original bug)

In `src/agents/agent.ts`, channels were assigned **after** the `Agent` constructor finished:

```typescript
(orchestratorAgent as typeof orchestratorAgent & { channels?: unknown }).channels = createSupervisorChannelsConfig();
```

Mastra's `Agent` class reads `config.channels` **only during construction** into a private `#agentChannels` field. Post-construction assignment does **not** update the internal field, so `agent.getChannels()` returns `null` and Mastra never registers webhook routes.

### 2. Constructor fix and agent-owned URLs

We moved `buildAgentChannels()` into the `Agent` constructor for both `orchestratorAgent` and `supervisorAgent`:

```typescript
export const orchestratorAgent = withAgentModes(new Agent({
  id: "orchestrator-agent",
  channels: buildAgentChannels(), // ← now in constructor
  ...
}), ...);
```

The dev server logs should confirm:
- `AgentChannels` initializes successfully
- Linear auth completes (`botUserId`, `organizationId` populated)
- Chat SDK reports: `Chat instance initialized { adapters: [ 'linear' ] }`

Mastra owns the generated channel handlers from the agent constructor. In this dev server line, those generated routes must also be passed into `server.apiRoutes` early and marked `_mastraInternal` so the server accepts the `/api` path. Do not rewrite URLs or add a custom middleware bridge. Each configured agent owns its own route:

- `/api/agents/orchestrator-agent/channels/linear/webhook`
- `/api/agents/supervisor-agent/channels/linear/webhook`

With the current local env, Slack and GitHub stay disabled unless `ENABLE_SLACK_CHANNEL=true` or `ENABLE_GITHUB_CHANNEL=true`; Linear is enabled when `LINEAR_WEBHOOK_SECRET` and Linear auth are present.

## Files Changed

- `src/agents/channels.ts` — new generic `buildAgentChannels()` factory
- `src/agents/channels.ts` — exposes `channelWebhookApiRoutesForAgents()` to pass Mastra-generated internal routes into server startup
- `src/agents/orchestrator-agent.ts` — added `channels: buildAgentChannels()` to constructor
- `src/agents/agent.ts` — removed broken post-construction assignment; added `channels: buildAgentChannels()` to `supervisorAgent`
- `src/mastra/index.ts` — registers the generated channel routes during server construction
- `package.json` — updated `mastra` to `1.8.1` and `@mastra/core` to `1.32.1`

## Environment Config (verified)

```bash
LINEAR_WEBHOOK_SECRET=lin_wh_...
LINEAR_API_KEY=lin_api_...
LINEAR_CHANNEL_MODE=comments
CLOUDFLARE_WEBHOOK_PUBLIC_URL=https://webb.renaissancelab.org
```

## Open Questions / Next Steps

1. **Full restart**: Restart `npm run dev` on port 4111 after changing constructor-level channel config.

2. **Linear-only verification**: With Slack/GitHub disabled, verify only:
   - `/api/agents/orchestrator-agent/channels/linear/webhook`
   - `/api/agents/supervisor-agent/channels/linear/webhook`

3. **Route ownership**: Select the agent-specific URL in Linear based on which agent should handle the event. Do not share one custom handler across agents.

4. **Expected probe result**: Unsigned local probe requests should return `400 Missing webhook signature`, not `404 Not Found`.

## References

- Mastra docs: channels must be passed in constructor — https://mastra.ai/docs/agents/channels
- PR #14642: agent-level chat channels via Chat SDK adapters — https://github.com/mastra-ai/mastra/pull/14642
- `AgentChannels.getWebhookRoutes()` generates `POST /api/agents/{agentId}/channels/{platform}/webhook`
