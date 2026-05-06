import type { ApiRoute } from "@mastra/core/server";

import { StdioLinearAcpRuntimeClient } from "./acp-client.js";
import { LinearAcpClientBridge } from "./bridge.js";
import { resolveLinearAcpClientConfig, type LinearAcpClientConfig } from "./config.js";
import { LinearAcpClientSdkClient, LinearSdkWebhookVerifier, type LinearAcpClientWebhookVerifier } from "./linear-sdk.js";
import { FileLinearAcpClientStateStore } from "./state.js";
import type { LinearAcpRuntimeClient, LinearAgentSessionClient, LinearAcpClientStateStore } from "./types.js";

type Logger = {
  info?: (message: string, args?: unknown) => void;
  warn?: (message: string, args?: unknown) => void;
  error?: (message: string, args?: unknown) => void;
};

export interface LinearAcpClientRouteDeps {
  config?: LinearAcpClientConfig;
  verifier?: LinearAcpClientWebhookVerifier;
  state?: LinearAcpClientStateStore;
  linear?: LinearAgentSessionClient;
  acp?: LinearAcpRuntimeClient;
  logger?: Logger;
}

export function createLinearAcpClientWebhookRoute(deps: LinearAcpClientRouteDeps = {}): ApiRoute {
  const config = deps.config ?? resolveLinearAcpClientConfig();
  return {
    path: config.webhookPath,
    method: "POST",
    _mastraInternal: true,
    requiresAuth: false,
    createHandler: async () => {
      const verifier = deps.verifier ?? new LinearSdkWebhookVerifier(config.webhookSecret ?? "");
      const bridge = new LinearAcpClientBridge({
        state: deps.state ?? new FileLinearAcpClientStateStore(config.stateFile),
        linear: deps.linear ?? new LinearAcpClientSdkClient(config),
        acp: deps.acp ?? new StdioLinearAcpRuntimeClient(config),
        config,
        logger: deps.logger,
      });

      return async (c) => {
        if (!config.enabled) {
          return c.json({ error: config.disabledReason ?? "linear-acp-client is disabled" }, 404);
        }

        const signature = c.req.raw.headers.get("linear-signature");
        if (!signature) return c.json({ error: "Missing Linear signature" }, 400);

        let payload;
        try {
          const rawBody = Buffer.from(await c.req.raw.arrayBuffer());
          payload = await verifier.parse(rawBody, signature, c.req.raw.headers.get("linear-timestamp"));
        } catch {
          return c.json({ error: "Invalid Linear webhook" }, 400);
        }

        void bridge.handleAgentSessionEvent(payload).catch((error) => {
          deps.logger?.error?.("[linear-acp-client] async webhook handling failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return c.json({ accepted: true }, 202);
      };
    },
  } satisfies ApiRoute;
}

export function linearAcpClientApiRoutes(config = resolveLinearAcpClientConfig()): ApiRoute[] {
  return config.enabled ? [createLinearAcpClientWebhookRoute({ config })] : [];
}
