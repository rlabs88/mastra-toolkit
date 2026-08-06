import { createDockerSandboxMachine } from "./docker.js";
import { createLocalSandboxMachine } from "./local.js";
import { createPlatformSandboxMachine } from "./platform.js";
import { enforceSandboxRuntimeProfile } from "./profile-machine.js";
import type { CloneableSandboxMachine, SandboxMachineOptions } from "./types.js";

type SandboxProviderMachineFactory = (options: SandboxMachineOptions) => CloneableSandboxMachine;

export function createSandboxMachine(
  options: SandboxMachineOptions,
): CloneableSandboxMachine {
  return createSandboxMachineWithProvider(options, createProviderMachine);
}

export function createSandboxMachineWithProvider(
  options: SandboxMachineOptions,
  providerFactory: SandboxProviderMachineFactory,
): CloneableSandboxMachine {
  const machine = providerFactory(options);
  if (options.provider === "local" || !options.runtimeProfile) return machine;
  return enforceSandboxRuntimeProfile(machine, options.runtimeProfile, options.runtimeImage);
}

function createProviderMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
  switch (options.provider) {
    case "local":
      return createLocalSandboxMachine(options);
    case "docker":
      return createDockerSandboxMachine(options);
    case "platform":
      if (!options.platform) {
        throw new Error("Platform sandbox requires environment, project, and secret-key configuration");
      }
      return createPlatformSandboxMachine({
        workspaceRoot: options.workspaceRoot,
        specification: options.specification,
        platform: options.platform,
      });
  }
}
