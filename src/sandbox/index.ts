import { LocalSandbox, type WorkspaceSandbox } from "@mastra/core/workspace";
import { DockerSandbox } from "@mastra/docker";
import { PlatformSandbox } from "@mastra/platform-workspace";
import type { SandboxProvider, ToolkitConfig } from "../config.js";

export interface SandboxMachineOptions {
  readonly provider: SandboxProvider;
  readonly workspaceRoot: string;
  readonly platform?: ToolkitConfig["platform"];
  readonly dockerImage?: string;
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
  const detection = LocalSandbox.detectIsolation();
  return new LocalSandbox({
    workingDirectory: options.workspaceRoot,
    isolation: detection.available ? detection.backend : "none",
    env: allowedLocalEnvironment(),
    timeout: 300_000,
  }) as CloneableSandboxMachine;
}

function createDockerMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
  return new DockerSandbox({
    image: options.dockerImage ?? process.env.MASTRA_TOOLKIT_DOCKER_IMAGE ?? "mastra-toolkit-sandbox:local",
    workingDir: "/workspace",
    volumes: { [options.workspaceRoot]: "/workspace" },
    timeout: 300_000,
    readonlyRootfs: true,
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    pidsLimit: 512,
    memory: 4 * 1_024 * 1_024 * 1_024,
    tmpfs: { "/tmp": "rw,noexec,nosuid,size=512m", "/run": "rw,noexec,nosuid,size=64m" },
    labels: { "ai.mastra.toolkit": "true" },
  }) as CloneableSandboxMachine;
}

function createPlatformMachine(options: SandboxMachineOptions): CloneableSandboxMachine {
  if (!options.platform) throw new Error("Platform sandbox requires environment, project, and secret-key configuration");
  return new PlatformSandbox({
    accessToken: options.platform.secretKey,
    projectId: options.platform.projectId,
    environmentId: options.platform.environmentId,
    timeout: 300_000,
    networkIsolation: "PRIVATE",
  }) as CloneableSandboxMachine;
}

function allowedLocalEnvironment(): NodeJS.ProcessEnv {
  const keys = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  return Object.fromEntries(keys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
}
