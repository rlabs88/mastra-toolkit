import type { WorkspaceSandbox } from "@mastra/core/workspace";
import type { SandboxProvider, SandboxSpec } from "./spec.js";

export interface SandboxMachineBaseOptions {
  readonly workspaceRoot: string;
  readonly specification: SandboxSpec;
}

export interface PlatformSandboxCredentials {
  readonly environmentId: string;
  readonly projectId: string;
  readonly secretKey: string;
}

export interface SandboxMachineOptions extends SandboxMachineBaseOptions {
  readonly provider: SandboxProvider;
  readonly platform?: PlatformSandboxCredentials | undefined;
}

export type CloneableSandboxMachine = WorkspaceSandbox & {
  readonly provider: SandboxProvider;
  clone(options?: {
    id?: string;
    sandboxId?: string;
    idleTimeoutMinutes?: number;
  }): CloneableSandboxMachine;
};
