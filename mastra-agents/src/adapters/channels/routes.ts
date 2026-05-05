import type { AgentChannelsConfig } from "./types.js";
import { listEnabledChannelPlatforms } from "./init-channels.js";

export function expectedChannelWebhookRoutes(agentId: string, config: AgentChannelsConfig = {}) {
  return listEnabledChannelPlatforms(config).map((platform) => ({
    method: "POST",
    path: `/api/agents/${agentId}/channels/${platform}/webhook`,
    platform,
  }));
}

export function listConfiguredChannelWebhookRoutes(routes: Array<{ method?: string; path?: string }> = []) {
  return routes
    .filter((route) => route.method === "POST" && route.path?.includes("/channels/") && route.path.endsWith("/webhook"))
    .map((route) => ({ method: route.method ?? "POST", path: route.path ?? "" }));
}

export function channelWebhookApiRoutesForAgents(
  agents: Record<string, { getChannels?: () => { getWebhookRoutes?: () => unknown[] } | null }>,
) {
  const seen = new Set<string>();
  const routes: unknown[] = [];

  for (const agent of Object.values(agents)) {
    for (const route of agent.getChannels?.()?.getWebhookRoutes?.() ?? []) {
      const routeKey = routeKeyFor(route);
      if (seen.has(routeKey)) continue;
      seen.add(routeKey);
      routes.push(markMastraInternalRoute(route));
    }
  }

  return routes;
}

function markMastraInternalRoute(route: unknown) {
  if (!route || typeof route !== "object") return route;
  return {
    ...route,
    _mastraInternal: true,
  };
}

function routeKeyFor(route: unknown) {
  if (!route || typeof route !== "object") return String(route);
  const candidate = route as { method?: unknown; path?: unknown };
  return `${String(candidate.method ?? "")} ${String(candidate.path ?? "")}`;
}
