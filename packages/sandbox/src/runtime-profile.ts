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

const SANDBOX_RUNTIME_PROFILES = {
  "ephemeral-development": {
    profile: "ephemeral-development",
    lifecycle: "ephemeral",
    packageLayers: ["mcode-runtime", "project-development"],
    credentials: "task-scoped",
  },
  "persistent-operations": {
    profile: "persistent-operations",
    lifecycle: "persistent",
    packageLayers: ["mcode-runtime", "project-development", "operations"],
    credentials: "runtime-secret-provider",
    secretProvider: {
      kind: "infisical",
      projectId: "0b0f6354-029f-45a7-9c1c-b65968b5f46c",
      environment: "dev",
      path: "/mastra-toolkit",
    },
  },
} as const satisfies Record<SandboxRuntimeProfileName, SandboxRuntimeProfile>;

export function resolveSandboxRuntimeProfile(profile: SandboxRuntimeProfileName): SandboxRuntimeProfile {
  return SANDBOX_RUNTIME_PROFILES[profile];
}
