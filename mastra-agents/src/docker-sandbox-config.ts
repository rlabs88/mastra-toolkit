/**
 * Docker sandbox configuration for Mastra-System.
 *
 * When running with Docker Compose, the sandbox container is started by
 * `compose.yml` with all infrastructure config (image, volumes, env,
 * network, labels) already applied. `DockerSandbox` reconnects to it by
 * matching the `mastra.sandbox.id` label — no YAML config file needed.
 *
 * The env var overrides below serve as escape hatches for non-Compose
 * scenarios (CI, bare `docker run`, etc.).
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Sandbox runtime env defaults — matches the Compose env_file values. */
const sandboxRuntimeEnv = {
  SERENA_PROJECT: "/workspace",
  SERENA_CONTEXT: "codex",
  SERENA_MCP_PORT: "8084",
  CODE_REVIEW_GRAPH_REPO: "/workspace",
  CODE_REVIEW_GRAPH_MCP_PORT: "8085",
  AGENT_SERVICES_AUTOSTART: "false",
  LOCAL_MCP_AUTOSTART: "false",
  JUPYTER_AUTOSTART: "false",
  JUPYTER_HOST: "127.0.0.1",
  JUPYTER_PORT: "8888",
  JUPYTER_WORKDIR: "/workspace",
  PASEO_AUTOSTART: "false",
  PASEO_HOME: "/home/daytona/.paseo",
  PASEO_LISTEN: "0.0.0.0:16767",
  PASEO_HOST: "127.0.0.1:16767",
  PASEO_HOSTNAMES: "localhost,127.0.0.1,.localhost,.proxy.localhost",
  PASEO_RELAY_ENABLED: "true",
  PASEO_MCP_ENABLED: "true",
  PASEO_INJECT_MCP_ENABLED: "true",
} as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Resolve bind mounts for the Docker sandbox. */
export function resolveDockerBindMounts(): Record<string, string> {
  const mounts: Record<string, string> = {};

  const workspaceRoot = readEnv("MASTRA_WORKSPACE_ROOT") ?? path.resolve(process.cwd(), "../..");
  mounts[workspaceRoot] = "/workspace";

  // Host /container/shared is mounted as /shared in the sandbox.
  // The image already includes agents via brew tap + git clone — no .agents bind mount needed.
  if (existsSync("/container/shared")) {
    mounts["/container/shared"] = "/shared";
  }

  const extraMountsRaw = readEnv("MASTRA_DOCKER_SANDBOX_EXTRA_MOUNTS");
  if (extraMountsRaw) {
    for (const entry of extraMountsRaw.split(",")) {
      const [host, container] = entry.trim().split(":", 2);
      if (host && container) {
        mounts[host] = container;
      }
    }
  }

  return mounts;
}

/** Resolve runtime env for the Docker sandbox. */
export function resolveDockerSandboxRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, fallback] of Object.entries(sandboxRuntimeEnv)) {
    env[name] = readEnv(name) ?? fallback;
  }

  // Pass DATABASE_URL so agents inside the sandbox can reach Postgres
  const databaseUrl = readEnv("DATABASE_URL") ?? "postgresql://mastra:mastra@mastra-postgres:5432/mastra";
  env.DATABASE_URL = databaseUrl;

  return env;
}

/** Default sandbox ID — matches the `mastra.sandbox.id` label in compose.yml. */
export const defaultDockerSandboxId = "mastra-agents-coding";

/** Default sandbox image — a prebuilt coding image artifact, not Daytona services. */
export const defaultDockerSandboxImage = "ghcr.io/eugenechan00/daytona-agents/snapshot-mastra-agents:dev";

/** Default Docker network — matches the Compose project network. */
export const defaultDockerSandboxNetwork = "mastra-system_default";
