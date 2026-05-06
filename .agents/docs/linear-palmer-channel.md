# Palmer Linear Channel

Palmer is the Linear app actor currently connected to `supervisor-agent`.

## Architecture

Keep the channel attachment inside the Mastra agent constructor, with adapter mechanics owned by `mastra-agents/src/adapters/channels/`:

```ts
import { initChannels } from "../adapters/channels/index.js";

new Agent({
  id: "supervisor-agent",
  channels: initChannels(),
});
```

Do not create a separate Chat SDK app instance for Palmer, and do not create a custom OAuth subsystem under `src/`. Mastra core owns the `AgentChannels` bridge: it creates the internal Chat SDK instance, registers the webhook route, and routes Linear events into the agent stream.

Linear, Slack, and GitHub connector setup belongs under `src/adapters/channels/{linear,slack,github}/`, not in agent composition files. The supervisor agent decides whether to attach the initialized channel runtime; the channel runtime owns Chat SDK adapter configuration, env gating, and shared persistent state.

## Current Palmer Target

Use supervisor only:

```txt
https://webbb.renaissancelab.org/api/agents/supervisor-agent/channels/linear/webhook
```

Do not point the Palmer Linear app at the orchestrator webhook for this setup.

## OAuth App Actor

The Linear OAuth app must be installed as an app actor:

```txt
actor=app
scope=read,write,comments:create,issues:create,app:mentionable,app:assignable
```

Runtime env should use app-tenant OAuth credentials:

```txt
LINEAR_BOT_USERNAME=Palmer
LINEAR_CHANNEL_MODE=agent-sessions
LINEAR_MODE=agent-sessions
LINEAR_CLIENT_ID=<linear client id>
LINEAR_CLIENT_SECRET=<linear client secret>
LINEAR_REDIRECT_URI=https://webbb.renaissancelab.org/api/linear/callback
LINEAR_WEBHOOK_SECRET=<linear webhook secret>
LINEAR_OAUTH_SCOPES=read,write,comments:create,issues:create,app:mentionable,app:assignable
```

Leave personal fallback auth empty for this app-actor install:

```txt
LINEAR_API_KEY=
LINEAR_ACCESS_TOKEN=
```

## State Persistence

Chat SDK's Linear adapter stores OAuth workspace installations through its `StateAdapter` with keys like:

```txt
linear:installation:{organizationId}
```

Mastra's default `MastraStateAdapter` persists thread subscriptions, but its generic cache is in-memory. That means Linear OAuth installs can disappear after a server restart. Use an official Chat SDK persistent state adapter through the existing `channels.state` field. This repo uses `@chat-adapter/state-pg` because the stack already has Postgres.

This is still the lean Mastra channel path: `Agent.channels -> Chat SDK Linear adapter -> official persistent state`.
