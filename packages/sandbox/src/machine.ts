import { createDockerSandboxMachine } from "./docker.js";
import { createLocalSandboxMachine } from "./local.js";
import { createPlatformSandboxMachine } from "./platform.js";
import type { CloneableSandboxMachine, SandboxMachineOptions } from "./types.js";

export function createSandboxMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
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
