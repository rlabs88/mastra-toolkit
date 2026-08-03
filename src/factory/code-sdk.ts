import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setCustomProvidersSource } from "@mastra/code-sdk/agents/custom-provider-source";
import { createMastraCodeGateway, type MastraCodeCustomProvider } from "@mastra/code-sdk/agents/model";

interface SettingsDocument {
  onboarding?: Record<string, unknown>;
  models?: Record<string, unknown> & { modeDefaults?: Record<string, string> };
  preferences?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
}

export async function prepareCodeSdkSettings(options: { readonly dataDirectory?: string; readonly model: string }): Promise<string> {
  const directory = options.dataDirectory ?? process.env.MASTRA_APP_DATA_DIR ?? join(homedir(), ".mastra-toolkit", "code-sdk");
  process.env.MASTRA_APP_DATA_DIR = directory;
  await mkdir(directory, { recursive: true });
  const settingsPath = join(directory, "settings.json");
  const existing = await readSettings(settingsPath);
  const modelId = `a1-proxy/${options.model}`;
  const settings: SettingsDocument = {
    ...existing,
    onboarding: { ...(existing.onboarding ?? {}), completedAt: new Date(0).toISOString(), quietModePreferenceSelected: true },
    models: {
      ...(existing.models ?? {}),
      modeDefaults: { ...(existing.models?.modeDefaults ?? {}), fast: modelId, plan: modelId, build: modelId },
    },
    preferences: { ...(existing.preferences ?? {}), yolo: false, thinkingLevel: "off" },
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

function createA1Provider(options: A1ProviderOptions): MastraCodeCustomProvider {
  return {
    name: "A1 Proxy",
    url: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    models: [options.model],
  };
}

export function registerA1CodeSdkProvider(options: A1ProviderOptions): void {
  setCustomProvidersSource(() => [createA1Provider(options)]);
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
