import { z } from "zod";
import runtimeProfiles from "../config/runtime-profiles.json" with { type: "json" };

export type SandboxRuntimeProfileName = "ephemeral-development" | "persistent-operations";

export interface SandboxRuntimeProfile {
  readonly profile: SandboxRuntimeProfileName;
  readonly lifecycle: "ephemeral" | "persistent";
  readonly packageLayers: readonly string[];
  readonly credentials: "task-scoped" | "runtime-secret-provider";
  readonly secretProvider?: {
    readonly kind: "infisical";
    readonly projectId: string;
    readonly environment: "dev";
    readonly path: string;
  };
}

const packageLayersSchema = z.array(z.string().min(1)).min(1);
const secretProviderSchema = z.object({
  kind: z.literal("infisical"),
  projectId: z.string().uuid(),
  environment: z.literal("dev"),
  path: z.string().startsWith("/"),
});

const SANDBOX_RUNTIME_PROFILES = z.object({
  "ephemeral-development": z.object({
    profile: z.literal("ephemeral-development"),
    lifecycle: z.literal("ephemeral"),
    packageLayers: packageLayersSchema,
    credentials: z.literal("task-scoped"),
  }),
  "persistent-operations": z.object({
    profile: z.literal("persistent-operations"),
    lifecycle: z.literal("persistent"),
    packageLayers: packageLayersSchema,
    credentials: z.literal("runtime-secret-provider"),
    secretProvider: secretProviderSchema,
  }),
}).parse(runtimeProfiles) satisfies Record<SandboxRuntimeProfileName, SandboxRuntimeProfile>;

export function resolveSandboxRuntimeProfile(profile: SandboxRuntimeProfileName): SandboxRuntimeProfile {
  return SANDBOX_RUNTIME_PROFILES[profile];
}
