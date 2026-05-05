import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "../../..");
const bundleDir = path.join(packageRoot, ".cache/channels-test");
const bundlePath = path.join(bundleDir, "channels.mjs");
const esbuildBin = path.resolve(packageRoot, "../node_modules/.bin/esbuild");
const publicChannelAgentId = "supervisor-agent";

function buildChannelsBundle() {
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  execFileSync(esbuildBin, [
    "src/adapters/channels/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
    "--external:@chat-adapter/*",
  ], { cwd: packageRoot, stdio: "pipe" });
}

function readChannelState(env) {
  const script = `
    import { Agent } from "@mastra/core/agent";
    import { pathToFileURL } from "node:url";

    const channels = await import(pathToFileURL(${JSON.stringify(bundlePath)}));
    const channelConfig = channels.initChannels();
    const agent = new Agent({
      id: ${JSON.stringify(publicChannelAgentId)},
      name: "Supervisor",
      instructions: "test",
      model: () => {
        throw new Error("model should not be resolved during route inspection");
      },
      channels: channelConfig,
    });
    const orchestratorAgent = new Agent({
      id: "orchestrator-agent",
      name: "Orchestrator",
      instructions: "test",
      model: () => {
        throw new Error("model should not be resolved during route inspection");
      },
    });
    const routes = agent.getChannels()?.getWebhookRoutes().map((route) => ({
      method: route.method,
      path: route.path,
    })) ?? [];
    const orchestratorRoutes = orchestratorAgent.getChannels?.()?.getWebhookRoutes?.() ?? [];
    const apiRoutes = channels.channelWebhookApiRoutesForAgents({ supervisorAgent: agent, orchestratorAgent }).map((route) => ({
      method: route.method,
      path: route.path,
      internal: route._mastraInternal,
    }));
    const linearAdapter = channelConfig?.adapters?.linear;
    console.log(JSON.stringify({
      enabled: channels.listEnabledChannelPlatforms(),
      expected: channels.expectedChannelWebhookRoutes(${JSON.stringify(publicChannelAgentId)}).map(({ method, path }) => ({ method, path })),
      supervisorExpected: channels.expectedChannelWebhookRoutes("supervisor-agent").map(({ method, path }) => ({ method, path })),
      apiRoutes,
      orchestratorRoutes,
      routes,
      status: channels.resolveAgentChannelStatus(),
      linearAdapter: linearAdapter ? {
        mode: linearAdapter.mode,
        hasDefaultClient: Boolean(linearAdapter.defaultClient),
        hasClientCredentials: Boolean(linearAdapter.clientCredentials),
        hasOAuthClient: Boolean(linearAdapter.oauthClientId),
      } : null,
    }));
    process.exit(0);
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

test("channel status requires webhook secrets and auth before enabling adapters", () => {
  buildChannelsBundle();
  const state = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    ENABLE_GITHUB_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "",
    SLACK_BOT_TOKEN: "",
    SLACK_CLIENT_ID: "",
    SLACK_CLIENT_SECRET: "",
    GITHUB_WEBHOOK_SECRET: "",
    GITHUB_TOKEN: "",
    GITHUB_APP_ID: "",
    GITHUB_PRIVATE_KEY: "",
    LINEAR_WEBHOOK_SECRET: "",
    LINEAR_API_KEY: "",
    LINEAR_ACCESS_TOKEN: "",
    LINEAR_CLIENT_ID: "",
    LINEAR_CLIENT_SECRET: "",
    LINEAR_CLIENT_CREDENTIALS_CLIENT_ID: "",
    LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET: "",
  });

  assert.deepEqual(state.enabled, []);
  assert.equal(state.status.slack.enabled, false);
  assert.equal(state.status.github.enabled, false);
  assert.equal(state.status.linear.enabled, false);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.orchestratorRoutes, []);
});

test("enabled channels generate supervisor webhook routes", () => {
  buildChannelsBundle();
  const state = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    ENABLE_GITHUB_CHANNEL: "true",
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITHUB_TOKEN: "github-token",
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    LINEAR_API_KEY: "linear-api-key",
    LINEAR_CHANNEL_MODE: "comments",
  });

  assert.deepEqual(state.enabled, ["slack", "github", "linear"]);
  assert.deepEqual(state.expected, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/linear/webhook" },
  ]);
  assert.deepEqual(state.routes, state.expected);
  assert.deepEqual(state.apiRoutes, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook", internal: true },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook", internal: true },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/linear/webhook", internal: true },
  ]);
  assert.deepEqual(state.supervisorExpected, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook" },
    { method: "POST", path: "/api/agents/supervisor-agent/channels/linear/webhook" },
  ]);
  assert.equal(state.status.linear.mode, "comments");
  assert.deepEqual(state.orchestratorRoutes, []);
});

test("Slack and GitHub channel connectors are gated independently", () => {
  buildChannelsBundle();
  const slackOnly = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    ENABLE_GITHUB_CHANNEL: "true",
    GITHUB_WEBHOOK_SECRET: "",
    GITHUB_TOKEN: "github-token",
    LINEAR_WEBHOOK_SECRET: "",
    LINEAR_API_KEY: "",
  });
  const githubOnly = readChannelState({
    ENABLE_SLACK_CHANNEL: "true",
    SLACK_SIGNING_SECRET: "",
    SLACK_BOT_TOKEN: "xoxb-test",
    ENABLE_GITHUB_CHANNEL: "true",
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITHUB_TOKEN: "github-token",
    LINEAR_WEBHOOK_SECRET: "",
    LINEAR_API_KEY: "",
  });

  assert.deepEqual(slackOnly.enabled, ["slack"]);
  assert.deepEqual(slackOnly.routes, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/slack/webhook" },
  ]);
  assert.deepEqual(githubOnly.enabled, ["github"]);
  assert.deepEqual(githubOnly.routes, [
    { method: "POST", path: "/api/agents/supervisor-agent/channels/github/webhook" },
  ]);
});

test("Linear multi-tenant OAuth credentials take precedence over API key fallback", () => {
  buildChannelsBundle();
  const state = readChannelState({
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    LINEAR_API_KEY: "stale-local-api-key",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    LINEAR_CHANNEL_MODE: "agent-sessions",
  });

  assert.deepEqual(state.enabled, ["linear"]);
  assert.equal(state.status.linear.mode, "agent-sessions");
  assert.deepEqual(state.linearAdapter, {
    mode: "agent-sessions",
    hasDefaultClient: false,
    hasClientCredentials: false,
    hasOAuthClient: true,
  });
});
