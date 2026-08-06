import { DockerSandbox } from "@mastra/docker";
import { immutableSandboxImageSchema, SANDBOX_RUNTIME_IMAGE_ENV } from "./image.js";
import type { CloneableSandboxMachine, SandboxMachineBaseOptions } from "./types.js";

export function createDockerSandboxMachine(
  options: SandboxMachineBaseOptions,
): CloneableSandboxMachine {
  const { docker, entrypointProfile, commandTimeoutMs, workdir } = options.specification.spec;
  const image = immutableSandboxImageSchema.parse(options.runtimeImage ?? entrypointProfile.image);
  return new DockerSandbox({
    image,
    ...(options.runtimeImage ? { env: { [SANDBOX_RUNTIME_IMAGE_ENV]: image } } : {}),
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
      ...(options.runtimeImage ? { "ai.mastra.runtime-image": image } : {}),
    },
  }) as CloneableSandboxMachine;
}
