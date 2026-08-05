import type { ToolsInput } from "@mastra/core/agent";
import type { ProjectGenerationState } from "./generation.js";

export interface ModelAliasResolverPort {
  resolveSpecialistModel(alias: string | undefined): string;
}

export interface CurrentToolSnapshotPort {
  snapshot(): Readonly<ToolsInput> | Promise<Readonly<ToolsInput>>;
}

export interface PreparedMcpGeneration extends CurrentToolSnapshotPort {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface McpLifecyclePort {
  prepare(): Promise<PreparedMcpGeneration>;
  close(): Promise<void>;
}

export interface HostGenerationRegistration {
  readonly generation: ProjectGenerationState;
}

export interface PreparedHostRegistration {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface StagedHostRegistrationPort {
  prepare(registration: HostGenerationRegistration): Promise<PreparedHostRegistration>;
}
