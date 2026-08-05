import { DockerSandbox } from "@mastra/docker";
import type { CloneableSandboxMachine, SandboxMachineBaseOptions } from "./types.js";

export function createDockerSandboxMachine(
  options: SandboxMachineBaseOptions,
): CloneableSandboxMachine {
  const { docker, entrypointProfile, commandTimeoutMs, workdir } = options.specification.spec;
  return new DockerSandbox({
    image: entrypointProfile.image,
    command: entrypointProfile.command,
    workingDir: workdir,
    volumes: { [options.workspaceRoot]: workdir },
    timeout: commandTimeoutMs,
    readonlyRootfs: docker.readonlyRootfs,
    capDrop: docker.capDrop,
    securityOpt: docker.securityOpt,
    pidsLimit: docker.pidsLimit,
    memory: docker.memoryBytes,
    tmpfs: docker.tmpfs,
    labels: {
      "ai.mastra.toolkit": "true",
      "ai.mastra.entrypoint-profile": entrypointProfile.id,
      "ai.mastra.provisioning-version": options.specification.apiVersion,
    },
  }) as CloneableSandboxMachine;
}
