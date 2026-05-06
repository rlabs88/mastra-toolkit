import { existsSync } from "node:fs";
import path from "node:path";

export interface LinearAcpClientConfig {
  enabled: boolean;
  disabledReason?: string;
  webhookPath: string;
  webhookSecret?: string;
  linearApiKey?: string;
  linearAccessToken?: string;
  linearCreateAsUser?: string;
  stateFile: string;
  acpCommand: string;
  acpArgs: string[];
  acpCwd: string;
  acpAgentId: string;
  mastraBaseUrl?: string;
  externalUrls: Array<{ label: string; url: string }>;
}

export function resolveLinearAcpClientConfig(env: NodeJS.ProcessEnv = process.env): LinearAcpClientConfig {
  const webhookPath = env.LINEAR_ACP_CLIENT_WEBHOOK_PATH?.trim() || "/api/linear-acp-client/linear/webhook";
  const webhookSecret = env.LINEAR_ACP_CLIENT_WEBHOOK_SECRET?.trim();
  const linearApiKey = env.LINEAR_ACP_CLIENT_API_KEY?.trim();
  const linearAccessToken = env.LINEAR_ACP_CLIENT_ACCESS_TOKEN?.trim();
  const acpCwd = env.LINEAR_ACP_CLIENT_ACP_CWD?.trim() || process.cwd();
  const acpAgentId = env.LINEAR_ACP_CLIENT_ACP_AGENT_ID?.trim() || env.MASTRA_ACP_AGENT_ID?.trim() || "supervisor-agent";
  const mastraBaseUrl = env.LINEAR_ACP_CLIENT_MASTRA_BASE_URL?.trim() || env.MASTRA_BASE_URL?.trim() || env.MASTRA_ACP_BASE_URL?.trim();
  const acpCommand = env.LINEAR_ACP_CLIENT_ACP_COMMAND?.trim() || process.execPath;
  const stateFile =
    env.LINEAR_ACP_CLIENT_STATE_FILE?.trim() ||
    path.resolve(acpCwd, ".mastra/linear-acp-client-state.json");
  const acpArgs = parseArgs(
    env.LINEAR_ACP_CLIENT_ACP_ARGS,
    defaultAcpArgs({ acpCwd, acpAgentId, mastraBaseUrl }),
  );
  const explicitEnable = env.ENABLE_LINEAR_ACP_CLIENT?.trim() === "true";

  let disabledReason: string | undefined;
  if (!explicitEnable) disabledReason = "ENABLE_LINEAR_ACP_CLIENT is not true";
  else if (!webhookSecret) disabledReason = "LINEAR_ACP_CLIENT_WEBHOOK_SECRET is not set";
  else if (!linearApiKey && !linearAccessToken) disabledReason = "linear-acp-client Linear auth is not configured";

  return {
    enabled: !disabledReason,
    disabledReason,
    webhookPath,
    webhookSecret,
    linearApiKey,
    linearAccessToken,
    linearCreateAsUser: env.LINEAR_ACP_CLIENT_CREATE_AS_USER?.trim() || "linear-acp-client",
    stateFile,
    acpCommand,
    acpArgs,
    acpCwd,
    acpAgentId,
    mastraBaseUrl,
    externalUrls: parseExternalUrls(env.LINEAR_ACP_CLIENT_EXTERNAL_URLS),
  };
}

function defaultAcpArgs(params: { acpCwd: string; acpAgentId: string; mastraBaseUrl?: string }): string[] {
  const entrypoint = defaultAcpEntrypoint();
  return [
    entrypoint,
    "--agent-id",
    params.acpAgentId,
    "--cwd",
    params.acpCwd,
    ...(params.mastraBaseUrl ? ["--mastra-base-url", params.mastraBaseUrl] : []),
  ];
}

function defaultAcpEntrypoint() {
  const candidates = [
    path.resolve(process.cwd(), "compiled/mastra-agents/acp/stdio.js"),
    path.resolve(process.cwd(), "../compiled/mastra-agents/acp/stdio.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function parseArgs(value: string | undefined, fallback: string[]) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function parseExternalUrls(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, ...urlParts] = entry.split("|");
      return { label: label.trim(), url: urlParts.join("|").trim() };
    })
    .filter((entry) => entry.label && entry.url);
}
