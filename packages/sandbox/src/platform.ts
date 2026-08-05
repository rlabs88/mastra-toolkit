import { PlatformSandbox } from "@mastra/platform-workspace";
import type {
  CloneableSandboxMachine,
  PlatformSandboxCredentials,
  SandboxMachineBaseOptions,
} from "./types.js";

export interface PlatformSandboxMachineOptions extends SandboxMachineBaseOptions {
  readonly platform: PlatformSandboxCredentials;
}

export function createPlatformSandboxMachine(
  options: PlatformSandboxMachineOptions,
): CloneableSandboxMachine {
  const policy = options.specification.spec.platform;
  return new PlatformSandbox({
    accessToken: options.platform.secretKey,
    projectId: options.platform.projectId,
    environmentId: options.platform.environmentId,
    timeout: options.specification.spec.commandTimeoutMs,
    idleTimeoutMinutes: policy.idleTimeoutMinutes,
    networkIsolation: policy.networkIsolation,
  }) as CloneableSandboxMachine;
}
