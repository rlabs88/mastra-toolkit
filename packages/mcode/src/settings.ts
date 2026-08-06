import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMastraCodeGateway, type MastraCodeCustomProvider } from "@mastra/code-sdk/agents/model";
import { ONBOARDING_VERSION } from "@mastra/code-sdk/onboarding/index";
import {
  A1_PROXY_PROVIDER_ID,
  A1_PROXY_PROVIDER_NAME,
  getA1ProxyModelId,
  prepareHostDataDirectory,
  type RuntimeDefaultsV1,
  type ToolkitHostId,
} from "@rlabs/runtime-config";
import { CANONICAL_AGENT_IDS, CODE_MODE_IDS } from "./modes/index.js";

export const A1_CODE_PROVIDER_ID = A1_PROXY_PROVIDER_ID;
export const A1_CODE_PROVIDER_NAME = A1_PROXY_PROVIDER_NAME;

interface SettingsDocument {
  onboarding?: Record<string, unknown>;
  models?: Record<string, unknown> & {
    modeDefaults?: Record<string, string>;
    subagentModels?: Record<string, string>;
    observerModelOverride?: string | null;
    reflectorModelOverride?: string | null;
    omObservationThreshold?: number | null;
    omReflectionThreshold?: number | null;
  };
  preferences?: Record<string, unknown>;
  customProviders?: Array<{ name: string; url: string; models: string[] }>;
  [key: string]: unknown;
}

export interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export function getA1CodeModelId(model: string): string {
  return getA1ProxyModelId(model);
}

export async function prepareCodeSdkSettings(options: {
  readonly dataDirectory?: string;
  readonly host?: Extract<ToolkitHostId, "mcode" | "studio">;
  readonly environment?: NodeJS.ProcessEnv;
  readonly defaults: RuntimeDefaultsV1;
  readonly provider?: Omit<A1ProviderOptions, "apiKey">;
}): Promise<string> {
  const environment = options.environment ?? process.env;
  const directory = options.dataDirectory
    ?? (await prepareHostDataDirectory(options.host ?? "mcode", environment)).directory;
  process.env.MASTRA_APP_DATA_DIR = directory;
  await mkdir(directory, { recursive: true });
  const settingsPath = join(directory, "settings.json");
  const existing = await readSettings(settingsPath);
  const defaults = options.defaults.codeSdk;
  const existingModels = existing.models ?? {};
  const existingPreferences = existing.preferences ?? {};
  const settings: SettingsDocument = {
    ...existing,
    onboarding: {
      ...(existing.onboarding ?? {}),
      version: ONBOARDING_VERSION,
      completedAt: new Date(0).toISOString(),
      quietModePreferenceSelected: true,
    },
    models: {
      ...existingModels,
      modeDefaults: Object.fromEntries(CODE_MODE_IDS.map(id => [
        id,
        resolvePersistedModelId(existingModels.modeDefaults?.[id], options.defaults) ?? defaults.activeModelId,
      ])),
      subagentModels: Object.fromEntries(CANONICAL_AGENT_IDS.map(id => [
        id,
        options.defaults.models.roles[id].gatewayModelId,
      ])),
      observerModelOverride: resolvePersistedModelId(existingModels.observerModelOverride, options.defaults) ?? defaults.observerModelId,
      reflectorModelOverride: resolvePersistedModelId(existingModels.reflectorModelOverride, options.defaults) ?? defaults.reflectorModelId,
      omObservationThreshold: existingModels.omObservationThreshold ?? defaults.observationThreshold,
      omReflectionThreshold: existingModels.omReflectionThreshold ?? defaults.reflectionThreshold,
    },
    preferences: {
      ...existingPreferences,
      ...(!Object.hasOwn(existingPreferences, "yolo") ? { yolo: false } : {}),
      ...(!Object.hasOwn(existingPreferences, "thinkingLevel") ? { thinkingLevel: "off" } : {}),
    },
    ...(options.provider ? {
      customProviders: [
        ...(existing.customProviders ?? []).filter(provider => provider.name !== A1_CODE_PROVIDER_NAME),
        {
          name: A1_CODE_PROVIDER_NAME,
          url: options.provider.baseUrl,
          models: [...options.provider.models],
        },
      ],
    } : {}),
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

export function createA1CodeProvider(options: A1ProviderOptions): MastraCodeCustomProvider {
  return {
    // The matching name keeps the Code gateway catalog on the resolvable
    // `a1-proxy/<alias>` namespace instead of adding a MastraCode prefix.
    name: A1_CODE_PROVIDER_NAME,
    url: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    models: [...options.models],
  };
}

export function createA1MastraCodeGateway(options: A1ProviderOptions) {
  return createMastraCodeGateway({
    mastraGatewayBaseUrl: options.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""),
    routeThroughMastraGateway: false,
    customProviders: [createA1CodeProvider(options)],
  });
}

function resolvePersistedModelId(
  modelId: string | null | undefined,
  defaults: RuntimeDefaultsV1,
): string | undefined {
  if (!modelId) return undefined;
  const prefix = `${A1_CODE_PROVIDER_ID}/`;
  if (!modelId.startsWith(prefix)) {
    throw new Error(`Persisted model must use a stable A1 model alias: ${modelId}`);
  }
  const alias = modelId.slice(prefix.length);
  if (!defaults.models.aliases.includes(alias)) {
    throw new Error(`Persisted model must use a stable A1 model alias: ${modelId}`);
  }
  return modelId;
}

async function readSettings(settingsPath: string): Promise<SettingsDocument> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as SettingsDocument;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Mastra Code SDK settings: ${settingsPath}`, { cause: error });
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
