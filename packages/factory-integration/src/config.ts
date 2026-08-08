import { loadRuntimeConfig, type ModelProfile, type RuntimeConfig } from "@rlabs/runtime-config";
import { loadGithubProjectsConfig, type GithubProjectsFactoryConfig } from "@rlabs/factory-github-projects";
import {
  loadSandboxConfig,
  resolveSandboxRuntimeProfile,
  type SandboxConfig,
  type SandboxRuntimeProfile,
  type SandboxRuntimeProfileName,
} from "@rlabs/sandbox";
import { z } from "zod";

const factoryProjectRuntimeProfileSchema = z.enum(["ephemeral-development", "persistent-operations"])
  .default("ephemeral-development");

const factoryEnvironmentSchema = z.object({
  FACTORY_PROJECT_RUNTIME_PROFILE: factoryProjectRuntimeProfileSchema,
  FACTORY_REPOSITORY_EXECUTION: z.enum(["enabled", "disabled"]).default("enabled"),
  FACTORY_PUBLIC_URL: z.string().url().default("http://localhost:4111"),
  FACTORY_ALLOWED_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().min(1).default("rlabs-mastra-toolkit"),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_PROJECTS_TOKEN: z.string().min(1).optional(),
  WORKOS_API_KEY: z.string().min(1).optional(),
  WORKOS_CLIENT_ID: z.string().min(1).optional(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),
});

const GITHUB_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;
const WORKOS_KEYS = ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"] as const;
const PERSISTENT_FACTORY_SECRET_KEYS = [
  ...WORKOS_KEYS,
  "DATABASE_URL",
  "REDIS_URL",
  "MASTRA_ENVIRONMENT_ID",
  "MASTRA_PROJECT_ID",
  "MASTRA_PLATFORM_SECRET_KEY",
] as const;

export type FactoryProjectRuntimeProfile = SandboxRuntimeProfileName;
export type FactoryProjectRuntimeConfig = SandboxRuntimeProfile;

export interface FactoryConfig {
  readonly runtime: RuntimeConfig;
  readonly sandbox?: SandboxConfig;
  readonly projectRuntime: FactoryProjectRuntimeConfig;
  readonly server: {
    readonly publicUrl: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly databaseUrl?: string;
  readonly redisUrl?: string;
  readonly github?: {
    readonly GITHUB_APP_ID: string;
    readonly GITHUB_APP_PRIVATE_KEY: string;
    readonly GITHUB_APP_CLIENT_ID: string;
    readonly GITHUB_APP_CLIENT_SECRET: string;
    readonly GITHUB_APP_SLUG: string;
    readonly GITHUB_APP_WEBHOOK_SECRET?: string;
  };
  readonly githubProjects?: {
    readonly token: string;
    readonly config: GithubProjectsFactoryConfig;
  };
  readonly workos?: {
    readonly apiKey: string;
    readonly clientId: string;
    readonly cookiePassword: string;
  };
}

export function requiredFactorySecretNames(environment: NodeJS.ProcessEnv): readonly string[] {
  const profile = factoryProjectRuntimeProfileSchema.parse(environment.FACTORY_PROJECT_RUNTIME_PROFILE);
  if (profile !== "persistent-operations") return [];
  return environment.GITHUB_PROJECTS_CONFIG?.trim()
    ? [...PERSISTENT_FACTORY_SECRET_KEYS, "GITHUB_PROJECTS_TOKEN"]
    : PERSISTENT_FACTORY_SECRET_KEYS;
}

export function loadFactoryConfig(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
  profile?: ModelProfile,
): FactoryConfig {
  const parsed = factoryEnvironmentSchema.parse(environment);
  const githubProjects = loadGithubProjectsConfig(environment);
  const publicUrl = normalizeOrigin(parsed.FACTORY_PUBLIC_URL, "FACTORY_PUBLIC_URL");
  const allowedOrigins = parsed.FACTORY_ALLOWED_ORIGINS
    ? parsed.FACTORY_ALLOWED_ORIGINS.split(",").map((value, index) =>
      normalizeOrigin(value.trim(), `FACTORY_ALLOWED_ORIGINS entry ${index + 1}`))
    : [publicUrl];
  assertCompleteGroup(parsed, GITHUB_KEYS, "GitHub App");
  assertCompleteGroup(parsed, WORKOS_KEYS, "WorkOS");
  if (githubProjects && !parsed.GITHUB_APP_ID) {
    throw new Error("GitHub Projects V2 requires the canonical GitHub App integration");
  }
  if (githubProjects && !parsed.GITHUB_PROJECTS_TOKEN) {
    throw new Error("GitHub Projects V2 requires its host-injected GITHUB_PROJECTS_TOKEN");
  }
  if (
    !parsed.WORKOS_API_KEY
    && (!isLoopbackOrigin(publicUrl) || allowedOrigins.some(origin => !isLoopbackOrigin(origin)))
  ) {
    throw new Error("Factory local authentication requires loopback-only public and allowed origins");
  }
  if (
    environment.NODE_ENV === "production"
    && parsed.WORKOS_API_KEY
    && (!publicUrl.startsWith("https://") || allowedOrigins.some(origin => !origin.startsWith("https://")))
  ) {
    throw new Error("Production WorkOS authentication requires HTTPS Factory public and allowed origins");
  }
  if (parsed.GITHUB_APP_ID && !parsed.GITHUB_APP_WEBHOOK_SECRET && !parsed.WORKOS_COOKIE_PASSWORD) {
    throw new Error("GitHub App configuration requires a replica-stable state secret from GITHUB_APP_WEBHOOK_SECRET or WorkOS");
  }
  if (
    parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations"
    && parsed.FACTORY_REPOSITORY_EXECUTION === "disabled"
  ) {
    throw new Error("The persistent-operations project runtime requires a configured repository sandbox");
  }
  const sandbox = parsed.FACTORY_REPOSITORY_EXECUTION === "enabled"
    ? loadSandboxConfig(environment, startDirectory)
    : undefined;
  if (sandbox?.provider === "docker" && !sandbox.runtimeImage) {
    throw new Error("Docker Factory repository execution requires SANDBOX_RUNTIME_IMAGE at an immutable digest");
  }
  if (parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations" && sandbox?.provider !== "platform") {
    throw new Error("The persistent-operations project runtime requires the Platform sandbox provider");
  }
  if (parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations" && !sandbox?.platform) {
    throw new Error("The persistent-operations project runtime requires complete Platform identity");
  }
  if (parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations") {
    const missing = [
      ...(!parsed.DATABASE_URL ? ["DATABASE_URL"] : []),
      ...(!parsed.REDIS_URL ? ["REDIS_URL"] : []),
    ];
    if (missing.length > 0) {
      throw new Error(`The persistent-operations project runtime requires durable Factory state; missing ${missing.join(", ")}`);
    }
    if (!parsed.WORKOS_API_KEY) {
      throw new Error("The persistent-operations project runtime requires WorkOS deployment authentication");
    }
    if (!publicUrl.startsWith("https://") || allowedOrigins.some(origin => !origin.startsWith("https://"))) {
      throw new Error("The persistent-operations project runtime requires HTTPS Factory public and allowed origins");
    }
    if (environment.NODE_ENV !== "production") {
      throw new Error("The persistent-operations project runtime requires NODE_ENV=production for secure WorkOS cookies");
    }
  }
  const base = {
    runtime: loadRuntimeConfig(environment, profile),
    projectRuntime: resolveSandboxRuntimeProfile(parsed.FACTORY_PROJECT_RUNTIME_PROFILE),
    server: { publicUrl, allowedOrigins },
    ...(sandbox ? { sandbox } : {}),
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    ...(parsed.REDIS_URL ? { redisUrl: parsed.REDIS_URL } : {}),
  };
  const github = parsed.GITHUB_APP_ID ? {
    GITHUB_APP_ID: parsed.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: parsed.GITHUB_APP_PRIVATE_KEY!,
    GITHUB_APP_CLIENT_ID: parsed.GITHUB_APP_CLIENT_ID!,
    GITHUB_APP_CLIENT_SECRET: parsed.GITHUB_APP_CLIENT_SECRET!,
    GITHUB_APP_SLUG: parsed.GITHUB_APP_SLUG,
    ...(parsed.GITHUB_APP_WEBHOOK_SECRET
      ? { GITHUB_APP_WEBHOOK_SECRET: parsed.GITHUB_APP_WEBHOOK_SECRET }
      : {}),
  } : undefined;
  const workos = parsed.WORKOS_API_KEY ? {
    apiKey: parsed.WORKOS_API_KEY,
    clientId: parsed.WORKOS_CLIENT_ID!,
    cookiePassword: parsed.WORKOS_COOKIE_PASSWORD!,
  } : undefined;
  return {
    ...base,
    ...(github ? { github } : {}),
    ...(githubProjects ? { githubProjects: { config: githubProjects.config, token: parsed.GITHUB_PROJECTS_TOKEN! } } : {}),
    ...(workos ? { workos } : {}),
  };
}

function normalizeOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an HTTP or HTTPS origin`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${label} must be an origin without a path, query, credentials, or fragment`);
  }
  return url.origin;
}

function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertCompleteGroup(
  environment: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const present = keys.filter(key => Boolean(environment[key]));
  if (present.length === 0 || present.length === keys.length) return;
  throw new Error(`${label} configuration is incomplete; missing ${keys.filter(key => !environment[key]).join(", ")}`);
}

import { MastraAuthWorkos } from "@mastra/auth-workos";
import {
  SimpleAuth,
  type MastraAuthRequest,
} from "@mastra/core/server";

interface LocalFactoryUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly organizationId: string;
}

const LOCAL_USER: LocalFactoryUser = {
  id: "local-user",
  email: "local@mastra-toolkit.invalid",
  name: "Local Mastra Toolkit",
  organizationId: "local-org",
};

class LocalFactoryAuth extends SimpleAuth<LocalFactoryUser> {
  constructor() {
    super({ tokens: { local: LOCAL_USER } });
  }

  override async authenticateToken(_token: string, _request: MastraAuthRequest): Promise<LocalFactoryUser> {
    return LOCAL_USER;
  }
}

export function createFactoryAuth(
  workos: FactoryConfig["workos"],
  nodeEnvironment = process.env.NODE_ENV,
  server: FactoryConfig["server"] = {
    publicUrl: "http://localhost:4111",
    allowedOrigins: ["http://localhost:4111"],
  },
  mastraDevelopment = process.env.MASTRA_DEV === "true" || process.env.MASTRA_FACTORY_DEV === "true",
): MastraAuthWorkos | LocalFactoryAuth {
  if (workos) {
    const secure = server.publicUrl.startsWith("https://");
    const crossSite = server.allowedOrigins.some(origin => origin !== server.publicUrl);
    return new MastraAuthWorkos({
      apiKey: workos.apiKey,
      clientId: workos.clientId,
      redirectUri: `${server.publicUrl}/auth/callback`,
      session: {
        cookiePassword: workos.cookiePassword,
        secure,
        sameSite: crossSite ? "None" : "Lax",
      },
    });
  }
  if (nodeEnvironment === "production" && !mastraDevelopment) {
    throw new Error("WorkOS credentials are required for Factory in production");
  }
  return new LocalFactoryAuth();
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LibSQLFactoryStorage } from "@mastra/libsql";
import { PgFactoryStorage, PgVector } from "@mastra/pg";

export function createFactoryStorage(databaseUrl?: string, localDatabasePath?: string) {
  if (databaseUrl) {
    const factoryStorage = new PgFactoryStorage({
      id: "mastra-toolkit-storage",
      connectionString: databaseUrl,
    });
    return {
      factoryStorage,
      storage: factoryStorage.getMastraStorage(),
      vector: new PgVector({ id: "mastra-toolkit-vectors", connectionString: databaseUrl }),
    };
  }
  if (!localDatabasePath) throw new Error("Local Factory storage requires a resolved database path");
  const databasePath = localDatabasePath;
  mkdirSync(dirname(databasePath), { recursive: true });
  const factoryStorage = new LibSQLFactoryStorage({
    id: "mastra-toolkit-storage",
    url: `file:${databasePath}`,
  });
  return { factoryStorage, storage: factoryStorage.getMastraStorage(), vector: undefined };
}

import type { FactoryStorage } from "@mastra/core/storage";
import {
  A1_PROXY_PROVIDER_ID,
  A1_PROXY_PROVIDER_NAME,
  getA1ProxyModelId,
  type RuntimeDefaultsV1,
} from "@rlabs/runtime-config";

interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

const LOCAL_ORG_ID = "local-org";
const LOCAL_USER_ID = "local-user";

interface CustomProvidersDomain {
  ensureReady(): Promise<void>;
  upsert(input: { orgId: string; userId: string; input: { providerId: string; name: string; url: string; apiKey?: string; models: string[] } }): Promise<unknown>;
}

interface ProjectsDomain {
  ensureReady(): Promise<void>;
  list(input: { orgId: string }): Promise<Array<{ id: string; defaultModelId: string | null }>>;
  update(input: { orgId: string; id: string; input: { defaultModelId: string } }): Promise<unknown>;
}

type ModeModels = Record<"build" | "plan" | "fast", string>;

interface ModelPacksDomain {
  ensureReady(): Promise<void>;
  list(input: { orgId: string }): Promise<Array<{ name: string; models: ModeModels }>>;
  upsert(input: { orgId: string; userId: string; input: { name: string; models: ModeModels } }): Promise<unknown>;
}

type ModelMemorySettings = {
  observerModelId: string | null;
  reflectorModelId: string | null;
  observationThreshold: number | null;
  reflectionThreshold: number | null;
};
type ModelMemorySettingsPatch = {
  observerModelId?: string;
  reflectorModelId?: string;
  observationThreshold?: number;
  reflectionThreshold?: number;
};
type ModelMemorySettingsFillIfUnset = {
  observerModelId?: string;
  reflectorModelId?: string;
};

interface MemorySettingsDomain {
  ensureReady(): Promise<void>;
  get(input: { orgId: string; userId: string }): Promise<ModelMemorySettings | null>;
  patch(input: {
    orgId: string;
    userId: string;
    patch: ModelMemorySettingsPatch;
    fillIfUnset?: ModelMemorySettingsFillIfUnset;
  }): Promise<unknown>;
}

/**
 * What a stored model id is allowed to be. Built from the same declared alias list the gateway
 * publishes, so storage and catalog cannot disagree about which ids exist.
 */
export interface StoredModelCatalog {
  readonly aliases: ReadonlySet<string>;
  readonly defaultModelId: string;
}

export async function prepareLocalA1Provider(
  storage: FactoryStorage,
  provider: A1ProviderOptions,
  defaults: RuntimeDefaultsV1,
): Promise<void> {
  const catalog: StoredModelCatalog = {
    aliases: new Set(provider.models),
    defaultModelId: defaults.codeSdk.activeModelId,
  };
  await seedProvider(storage, provider);
  await migrateProjectDefaults(storage, catalog);
  await migrateModelPacks(storage, catalog);
  await migrateMemorySettings(storage, defaults, catalog);
  await migrateThreadMetadata(storage, catalog);
}

async function seedProvider(storage: FactoryStorage, provider: A1ProviderOptions): Promise<void> {
  const domain = getDomain<CustomProvidersDomain>(storage, "custom-providers");
  await domain.ensureReady();
  await domain.upsert({
    orgId: LOCAL_ORG_ID,
    userId: LOCAL_USER_ID,
    input: {
      providerId: A1_PROXY_PROVIDER_ID,
      name: A1_PROXY_PROVIDER_NAME,
      url: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      models: [...provider.models],
    },
  });
}

async function migrateProjectDefaults(storage: FactoryStorage, catalog: StoredModelCatalog): Promise<void> {
  const domain = getDomain<ProjectsDomain>(storage, "projects");
  await domain.ensureReady();
  for (const project of await domain.list({ orgId: LOCAL_ORG_ID })) {
    const modelId = normalizeStoredModelId(project.defaultModelId, catalog);
    if (modelId && modelId !== project.defaultModelId) {
      await domain.update({ orgId: LOCAL_ORG_ID, id: project.id, input: { defaultModelId: modelId } });
    }
  }
}

async function migrateModelPacks(storage: FactoryStorage, catalog: StoredModelCatalog): Promise<void> {
  const domain = getDomain<ModelPacksDomain>(storage, "model-packs");
  await domain.ensureReady();
  for (const pack of await domain.list({ orgId: LOCAL_ORG_ID })) {
    const models = normalizeModeModels(pack.models, catalog);
    if (Object.keys(models).every(mode => models[mode as keyof ModeModels] === pack.models[mode as keyof ModeModels])) continue;
    await domain.upsert({ orgId: LOCAL_ORG_ID, userId: LOCAL_USER_ID, input: { name: pack.name, models } });
  }
}

async function migrateMemorySettings(storage: FactoryStorage, defaults: RuntimeDefaultsV1, catalog: StoredModelCatalog): Promise<void> {
  const domain = getDomain<MemorySettingsDomain>(storage, "memory-settings");
  await domain.ensureReady();
  const memory = await domain.get({ orgId: LOCAL_ORG_ID, userId: LOCAL_USER_ID });
  const memoryDefaults = defaults.factory;
  const normalizedModels = memory ? normalizeMemorySettings(memory, catalog) : {};
  const patch: ModelMemorySettingsPatch = {
    ...normalizedModels,
    ...(memory?.observationThreshold == null
      ? { observationThreshold: memoryDefaults.observationThreshold }
      : {}),
    ...(memory?.reflectionThreshold == null
      ? { reflectionThreshold: memoryDefaults.reflectionThreshold }
      : {}),
  };
  const fillIfUnset: ModelMemorySettingsFillIfUnset = {
    ...(memory?.observerModelId == null
      ? { observerModelId: memoryDefaults.observerModelId }
      : {}),
    ...(memory?.reflectorModelId == null
      ? { reflectorModelId: memoryDefaults.reflectorModelId }
      : {}),
  };
  if (Object.keys(patch).length > 0 || Object.keys(fillIfUnset).length > 0) {
    await domain.patch({
      orgId: LOCAL_ORG_ID,
      userId: LOCAL_USER_ID,
      patch,
      ...(Object.keys(fillIfUnset).length > 0 ? { fillIfUnset } : {}),
    });
  }
}

async function migrateThreadMetadata(storage: FactoryStorage, catalog: StoredModelCatalog): Promise<void> {
  const domain = await storage.getMastraStorage().getStore("memory");
  if (!domain) return;
  await domain.init();
  const { threads } = await domain.listThreads({ perPage: false });
  for (const thread of threads) {
    const metadata = normalizeModelReferences(thread.metadata ?? {}, catalog);
    if (metadata.changed) {
      await domain.updateThread({ id: thread.id, title: thread.title ?? "", metadata: metadata.value });
    }
  }
}

function normalizeModeModels(models: ModeModels, catalog: StoredModelCatalog): ModeModels {
  return Object.fromEntries(
    Object.entries(models).map(([mode, modelId]) => [mode, normalizeStoredModelId(modelId, catalog) ?? modelId]),
  ) as ModeModels;
}

function normalizeMemorySettings(memory: ModelMemorySettings, catalog: StoredModelCatalog): ModelMemorySettingsPatch {
  const observerModelId = normalizeStoredModelId(memory.observerModelId, catalog);
  const reflectorModelId = normalizeStoredModelId(memory.reflectorModelId, catalog);
  return {
    ...(observerModelId && observerModelId !== memory.observerModelId ? { observerModelId } : {}),
    ...(reflectorModelId && reflectorModelId !== memory.reflectorModelId ? { reflectorModelId } : {}),
  };
}

/**
 * Rewrites a stored model id onto a declared alias, so nothing the proxy does not serve under a
 * name we own can survive in storage.
 *
 * The rule is a catalog membership test, not a table of known-bad ids. The previous version mapped
 * one upstream name (`gpt-5.6-luna`) back to one alias, which could never be complete — the proxy
 * renames and re-points aliases, and each new upstream id it exposed produced the same bug again
 * (`gpt-5.6-sol` reaching storage as `openai/gpt-5.6-sol`, resolving against the OpenAI provider,
 * and failing with a missing `OPENAI_API_KEY`).
 *
 * Worse, that table could not be correct even in principle. The proxy distinguishes tiers by
 * `reasoning.effort` over a shared upstream model, so the mapping is many-to-one: `gpt-5.6-luna`
 * serves both `code-workhorse-high` and `-low`, and `gpt-5.6-sol` serves all three frontier tiers.
 * Mapping an upstream id back to one alias silently re-tiers everything else that shared it.
 *
 * So an unrecognised id resets to the host's documented default rather than guessing. That is
 * lossy on purpose: the tier is genuinely unrecoverable, and a caller that wants a specific tier
 * must name a declared alias. Any prefix form the id already carries is preserved when the alias
 * is valid, so a gateway-qualified id is not rewritten into a provider-qualified one.
 */
export function normalizeStoredModelId(
  modelId: string | null | undefined,
  catalog: StoredModelCatalog,
): string | undefined {
  if (!modelId) return undefined;
  const hosted = modelId.startsWith("mastracode/") ? modelId.slice("mastracode/".length) : modelId;
  const alias = hosted.split("/").at(-1);
  if (alias && catalog.aliases.has(alias)) return hosted;
  return catalog.defaultModelId;
}

/**
 * A key whose value is a model id: anything containing `model`, plus `modes`, which holds model ids
 * without naming them. Observed live in thread metadata as `modeModelId_build`, `currentModelId`,
 * `observerModelId`, and `subagentModels`.
 */
const MODEL_KEY = /model/i;
const MODEL_KEY_EXACT = new Set(["modes"]);
const isModelKey = (key: string): boolean => MODEL_KEY.test(key) || MODEL_KEY_EXACT.has(key);

/**
 * Rewrites the model references inside a stored metadata object, leaving everything else untouched.
 *
 * Selection is by key, never by value. `normalizeStoredModelId` maps anything outside the catalog
 * onto the default, which is correct for a value already known to be a model id and destructive for
 * anything else — applied to every string in the object it would turn thread titles, branch names,
 * and ids into a model id. Arrays inherit the key that introduced them, so a list of model ids is
 * still normalised.
 */
export function normalizeModelReferences(input: Record<string, unknown>, catalog: StoredModelCatalog): {
  value: Record<string, unknown>;
  changed: boolean;
} {
  let changed = false;
  const visit = (value: unknown, underModelKey: boolean): unknown => {
    if (typeof value === "string") {
      if (!underModelKey) return value;
      const normalized = normalizeStoredModelId(value, catalog);
      if (normalized && normalized !== value) changed = true;
      return normalized ?? value;
    }
    if (Array.isArray(value)) return value.map(entry => visit(entry, underModelKey));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(
        ([key, entry]) => [key, visit(entry, isModelKey(key))],
      ));
    }
    return value;
  };
  return { value: visit(input, false) as Record<string, unknown>, changed };
}

function getDomain<T>(storage: FactoryStorage, name: string): T {
  return storage.getDomain(name) as unknown as T;
}
