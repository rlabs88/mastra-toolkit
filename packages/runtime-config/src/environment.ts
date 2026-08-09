import { mkdir, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_ACTIVE_ALIAS, loadModelProfile, resolveAliasModelId, type ModelProfile } from "./profile.js";

const runtimeEnvironmentSchema = z.object({
  MASTRA_TOOLKIT_MODE: z.enum(["standalone", "factory"]).default("standalone"),
  PROXY_BASE_URL: z.url().optional(),
  PROXY_API_KEY: z.string().min(1).optional(),
  CLI_PROXY_API_KEY: z.string().min(1).optional(),
  PROXY_MODEL: z.string().min(1).default(DEFAULT_ACTIVE_ALIAS),
});

export type RuntimeMode = "standalone" | "factory";

export interface ModelHostConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
}

export interface RuntimeConfig {
  readonly mode: RuntimeMode;
  readonly proxy: ModelHostConfig;
}

export type ToolkitHostId = "mcode" | "studio" | "factory";

export interface HostDataPaths {
  readonly rootDirectory: string;
  readonly directory: string;
  readonly databasePath: string;
  readonly settingsPath?: string;
  readonly vectorDatabasePath?: string;
  readonly observabilityDatabasePath?: string;
  readonly controlPlaneDirectory?: string;
}

export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  profile: ModelProfile = loadModelProfile(),
): RuntimeConfig {
  const parsed = runtimeEnvironmentSchema.parse(environment);
  resolveAliasModelId(profile, parsed.PROXY_MODEL);

  const profileApiKey = parseProfileApiKey(environment[profile.provider.apiKeyEnv]);
  const apiKey = parsed.PROXY_API_KEY ?? profileApiKey;
  if (!apiKey) {
    throw new Error(`Missing required model credential: ${profile.provider.apiKeyEnv}`);
  }
  const modelHost = {
    baseUrl: (parsed.PROXY_BASE_URL ?? profile.provider.baseUrl).replace(/\/+$/, ""),
    model: parsed.PROXY_MODEL,
  };
  return {
    mode: parsed.MASTRA_TOOLKIT_MODE,
    proxy: { ...modelHost, apiKey },
  };
}

export function resolveHostDataPaths(
  host: ToolkitHostId,
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): HostDataPaths {
  const rootDirectory = resolve(userHome, ".mastra-toolkit");
  const directory = resolve(environment.MASTRA_APP_DATA_DIR ?? join(rootDirectory, host));
  if (host === "factory") {
    return {
      rootDirectory,
      directory,
      databasePath: join(directory, "factory.db"),
      controlPlaneDirectory: join(directory, "control-plane"),
    };
  }
  return {
    rootDirectory,
    directory,
    databasePath: join(directory, "mastra.db"),
    settingsPath: join(directory, "settings.json"),
    vectorDatabasePath: join(directory, "mastra-vectors.db"),
    observabilityDatabasePath: join(directory, "observability.duckdb"),
  };
}

export async function prepareHostDataDirectory(
  host: ToolkitHostId,
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): Promise<HostDataPaths> {
  const paths = resolveHostDataPaths(host, environment, userHome);
  if (!environment.MASTRA_APP_DATA_DIR) await migrateLegacyHostData(host, paths);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  return paths;
}

export function resolveProjectHostDataPaths(
  host: Extract<ToolkitHostId, "mcode" | "studio">,
  canonicalProjectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): HostDataPaths {
  const projectId = createHash("sha256").update(resolve(canonicalProjectRoot)).digest("hex").slice(0, 16);
  const base = resolveHostDataPaths(host, environment, userHome);
  return resolveHostDataPaths(host, {
    ...environment,
    MASTRA_APP_DATA_DIR: join(base.directory, "projects", projectId),
  }, userHome);
}

export async function prepareProjectHostDataDirectory(
  host: Extract<ToolkitHostId, "mcode" | "studio">,
  canonicalProjectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): Promise<HostDataPaths> {
  const paths = resolveProjectHostDataPaths(host, canonicalProjectRoot, environment, userHome);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  return paths;
}

async function migrateLegacyHostData(host: ToolkitHostId, paths: HostDataPaths): Promise<void> {
  const legacyDirectory = host === "mcode"
    ? join(paths.rootDirectory, "code-sdk")
    : host === "factory"
      ? join(paths.rootDirectory, "data")
      : undefined;
  if (!legacyDirectory) return;

  const names = host === "factory"
    ? ["factory.db", "factory.db-wal", "factory.db-shm"]
    : [
        "settings.json",
        "mastra.db",
        "mastra.db-wal",
        "mastra.db-shm",
        "mastra-vectors.db",
        "mastra-vectors.db-wal",
        "mastra-vectors.db-shm",
        "observability.duckdb",
      ];
  const legacyEntries = await directoryEntries(legacyDirectory);
  const destinationEntries = await directoryEntries(paths.directory);
  const legacyData = names.filter(name => legacyEntries.has(name));
  const destinationData = names.filter(name => destinationEntries.has(name));
  if (legacyData.length === 0) return;
  if (destinationData.length > 0) {
    throw new Error(`Legacy and destination directories both contain local data for ${host}`);
  }

  try {
    await rename(legacyDirectory, paths.directory);
  } catch (error) {
    throw new Error(`Unable to atomically migrate legacy local data for ${host}`, { cause: error });
  }
}

async function directoryEntries(directory: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(directory));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
}

function parseProfileApiKey(value: string | undefined): string | undefined {
  return z.string().min(1).optional().parse(value);
}
