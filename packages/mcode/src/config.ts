import { loadRuntimeConfig, type ModelProfile, type RuntimeConfig } from "@rlabs/runtime-config";
import { loadSandboxConfig, type SandboxConfig } from "@rlabs/sandbox";
import { z } from "zod";

const browserEnvironmentSchema = z.object({
  BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
  BROWSER_USER_DATA_DIR: z.string().min(1).optional(),
});

export interface McodeConfig {
  readonly runtime: RuntimeConfig;
  readonly sandbox: SandboxConfig;
  readonly browser: {
    readonly executablePath?: string;
    readonly userDataDir?: string;
  };
}

export function loadMcodeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
  profile?: ModelProfile,
): McodeConfig {
  const browser = browserEnvironmentSchema.parse(environment);
  return {
    runtime: loadRuntimeConfig(environment, profile),
    sandbox: loadSandboxConfig(environment, startDirectory),
    browser: {
      ...(browser.BROWSER_EXECUTABLE_PATH ? { executablePath: browser.BROWSER_EXECUTABLE_PATH } : {}),
      ...(browser.BROWSER_USER_DATA_DIR ? { userDataDir: browser.BROWSER_USER_DATA_DIR } : {}),
    },
  };
}
