import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMastraCodeGateway, type MastraCodeCustomProvider } from "@mastra/code-sdk/agents/model";
import { CODE_MODE_IDS } from "../agents/modes/index.js";
import {
  DEFAULT_ACTIVE_ALIAS,
  DEFAULT_OBSERVER_ALIAS,
  resolveAliasModelId,
  type ModelProfile,
} from "../models/profile.js";

export const A1_CODE_PROVIDER_ID = "a1-proxy";
export const A1_CODE_PROVIDER_NAME = "A1 Proxy";

interface SettingsDocument {
  onboarding?: Record<string, unknown>;
  models?: Record<string, unknown> & {
    modeDefaults?: Record<string, string>;
    observerModelOverride?: string | null;
    reflectorModelOverride?: string | null;
  };
  preferences?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export function getA1CodeModelId(model: string): string {
  const bareModel = model.replace(/^a1-proxy\//, "");
  return `${A1_CODE_PROVIDER_ID}/${bareModel}`;
}

export async function prepareCodeSdkSettings(options: {
  readonly dataDirectory?: string;
  readonly profile: ModelProfile;
}): Promise<string> {
  const directory = options.dataDirectory ?? process.env.MASTRA_APP_DATA_DIR ?? join(homedir(), ".mastra-toolkit", "code-sdk");
  process.env.MASTRA_APP_DATA_DIR = directory;
  await mkdir(directory, { recursive: true });
  const settingsPath = join(directory, "settings.json");
  const existing = await readSettings(settingsPath);
  const activeModelId = resolveAliasModelId(options.profile, DEFAULT_ACTIVE_ALIAS);
  const observerModelId = resolveAliasModelId(options.profile, DEFAULT_OBSERVER_ALIAS);
  const existingModels = existing.models ?? {};
  const existingPreferences = existing.preferences ?? {};
  const settings: SettingsDocument = {
    ...existing,
    onboarding: { ...(existing.onboarding ?? {}), completedAt: new Date(0).toISOString(), quietModePreferenceSelected: true },
    models: {
      ...existingModels,
      modeDefaults: Object.fromEntries(CODE_MODE_IDS.map(id => [
        id,
        existingModels.modeDefaults?.[id] ?? activeModelId,
      ])),
      observerModelOverride: existingModels.observerModelOverride ?? observerModelId,
      reflectorModelOverride: existingModels.reflectorModelOverride ?? observerModelId,
    },
    preferences: {
      ...existingPreferences,
      ...(!Object.hasOwn(existingPreferences, "yolo") ? { yolo: false } : {}),
      ...(!Object.hasOwn(existingPreferences, "thinkingLevel") ? { thinkingLevel: "off" } : {}),
    },
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

function createA1Provider(options: A1ProviderOptions): MastraCodeCustomProvider {
  return {
    // Matching the custom-provider id to MastraCodeGateway.id prevents core's
    // catalog from emitting the unresolvable `mastracode/a1-proxy/...` form.
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
    customProviders: [createA1Provider(options)],
  });
}

async function readSettings(settingsPath: string): Promise<SettingsDocument> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as SettingsDocument;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid Mastra Code SDK settings: ${settingsPath}`, { cause: error });
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
