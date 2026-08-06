import type { WorkspaceSandbox } from "@mastra/core/workspace";
import type { SandboxProvider, SandboxSpec } from "./spec.js";
import type { SandboxRuntimeProfileName } from "./runtime-profile.js";

export interface SandboxMachineBaseOptions {
  readonly workspaceRoot: string;
  readonly specification: SandboxSpec;
  readonly runtimeImage?: string;
}

export interface PlatformSandboxCredentials {
  readonly environmentId: string;
  readonly projectId: string;
  readonly secretKey: string;
}

export interface SandboxMachineOptions extends SandboxMachineBaseOptions {
  readonly provider: SandboxProvider;
  readonly platform?: PlatformSandboxCredentials | undefined;
  readonly runtimeProfile?: SandboxRuntimeProfileName;
}

export type CloneableSandboxMachine = WorkspaceSandbox & {
  readonly provider: SandboxProvider;
  clone(options?: {
    id?: string;
    sandboxId?: string;
    idleTimeoutMinutes?: number;
  }): CloneableSandboxMachine;
};
