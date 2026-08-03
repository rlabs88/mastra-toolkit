import { LocalSandbox, type WorkspaceSandbox } from "@mastra/core/workspace";
import { DockerSandbox } from "@mastra/docker";
import { PlatformSandbox } from "@mastra/platform-workspace";
import type { SandboxProvider, ToolkitConfig } from "../config.js";
import type { SandboxSpec } from "./spec.js";

export interface SandboxMachineOptions {
  readonly provider: SandboxProvider;
  readonly workspaceRoot: string;
  readonly platform?: ToolkitConfig["platform"];
  readonly specification: SandboxSpec;
}

export type CloneableSandboxMachine = WorkspaceSandbox & {
  readonly provider: SandboxProvider;
  clone(options?: { id?: string; sandboxId?: string; idleTimeoutMinutes?: number }): CloneableSandboxMachine;
};

export function createSandboxMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
  switch (options.provider) {
    case "local": return createLocalMachine(options);
    case "docker": return createDockerMachine(options);
    case "platform": return createPlatformMachine(options);
  }
}

function createLocalMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
  const policy = options.specification.spec.local;
  const detection = LocalSandbox.detectIsolation();
  const isolation = policy.isolation === "auto" ? (detection.available ? detection.backend : "none") : policy.isolation;
  return new LocalSandbox({
    workingDirectory: options.workspaceRoot,
    isolation,
    nativeSandbox: {
      allowNetwork: policy.allowNetwork,
      allowSystemBinaries: policy.allowSystemBinaries,
      readOnly: policy.readOnly,
      readOnlyPaths: policy.readOnlyPaths,
      readWritePaths: policy.readWritePaths,
    },
    env: allowedLocalEnvironment(),
    timeout: options.specification.spec.commandTimeoutMs,
  }) as CloneableSandboxMachine;
}

function createDockerMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
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

function createPlatformMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
  if (!options.platform) throw new Error("Platform sandbox requires environment, project, and secret-key configuration");
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

function allowedLocalEnvironment(): NodeJS.ProcessEnv {
  const keys = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  return Object.fromEntries(keys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
}
