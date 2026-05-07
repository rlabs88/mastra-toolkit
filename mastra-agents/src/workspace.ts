import { existsSync } from "node:fs";

import { LocalFilesystem, LocalSandbox, Workspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";

import { DaytonaAgentsDaytonaSandbox } from "./daytona/mastra-sandbox.js";
import {
  resolveDaytonaVolumeMounts,
  resolveSandboxRuntimeEnv,
} from "./daytona/sandbox-config.js";
import {
  allowedWorkspaceRootsDescription,
  resolveConfiguredPath,
  workspaceAccessRoots,
  workspaceCommandCwd,
  workspaceRoot,
} from "./workspace-paths.js";

const defaultSnapshot =
  process.env.MASTRA_DEFAULT_SNAPSHOT ??
  "daytona-agents/snapshot-coding-base:local";
const allowedLanguages = ["typescript", "javascript", "python"] as const;
const allowedLocalIsolation = ["none", "seatbelt", "bwrap"] as const;
const localSandboxAliases = new Set(["local", "current", "host", "docker"]);
const daytonaSandboxAliases = new Set(["daytona", "remote"]);

type DaytonaWorkspaceLanguage = (typeof allowedLanguages)[number];
type WorkspaceLocalIsolation = (typeof allowedLocalIsolation)[number];
type WorkspaceSandboxProvider = "local" | "daytona";

function resolveBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolveNumberEnv(value: string | undefined) {
  if (value === undefined || value === "") {
    return undefined;
  }

  const resolvedValue = Number(value);
  return Number.isFinite(resolvedValue) ? resolvedValue : undefined;
}

function resolveWorkspaceLanguage(value: string | undefined): DaytonaWorkspaceLanguage {
  if (allowedLanguages.includes(value as DaytonaWorkspaceLanguage)) {
    return value as DaytonaWorkspaceLanguage;
  }

  return "typescript";
}

function resolveWorkspaceSandboxProvider(value: string | undefined): WorkspaceSandboxProvider {
  const normalizedValue = value?.toLowerCase();

  if (normalizedValue !== undefined && localSandboxAliases.has(normalizedValue)) {
    return "local";
  }

  if (normalizedValue !== undefined && daytonaSandboxAliases.has(normalizedValue)) {
    return "daytona";
  }

  // When Mastra itself runs inside Daytona, use the current sandbox by default
  // so commands and file tools can see this sandbox's /home, /workspace, and
  // /shared volume mounts instead of creating a nested Daytona sandbox.
  if (process.env.DAYTONA_SANDBOX_ID) {
    return "local";
  }

  return "daytona";
}

function resolveLocalSandboxIsolation(value: string | undefined): WorkspaceLocalIsolation {
  if (allowedLocalIsolation.includes(value as WorkspaceLocalIsolation)) {
    return value as WorkspaceLocalIsolation;
  }

  const detected = LocalSandbox.detectIsolation();
  return detected.available ? detected.backend : "none";
}

function createLocalSandbox() {
  const runtimeEnv = resolveSandboxRuntimeEnv();
  const isolation = resolveLocalSandboxIsolation(process.env.MASTRA_WORKSPACE_LOCAL_ISOLATION);

  return new LocalSandbox({
    id: process.env.MASTRA_LOCAL_WORKSPACE_SANDBOX_ID ?? "daytona-agents-current-sandbox",
    workingDirectory: workspaceCommandCwd,
    env: {
      ...process.env,
      ...runtimeEnv,
    },
    timeout: resolveNumberEnv(process.env.MASTRA_WORKSPACE_COMMAND_TIMEOUT_MS) ?? 300_000,
    isolation,
    nativeSandbox: {
      allowNetwork: true,
      allowSystemBinaries: true,
      readWritePaths: workspaceAccessRoots.filter((root) => existsSync(root)),
    },
    instructions: ({ defaultInstructions }) =>
      `${defaultInstructions} This is the current sandbox environment. Shell commands and file tools are scoped to the configured workspace roots when local native isolation is available: ${allowedWorkspaceRootsDescription()}.`,
  });
}

function createDaytonaSandbox() {
  return new DaytonaAgentsDaytonaSandbox({
    id: process.env.DAYTONA_WORKSPACE_SANDBOX_ID ?? "daytona-agents-global-coding",
    name: process.env.DAYTONA_WORKSPACE_SANDBOX_NAME ?? "daytona-agents-global-coding",
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL ?? "http://daytona-api:3000/api",
    snapshot: process.env.DAYTONA_WORKSPACE_SNAPSHOT ?? defaultSnapshot,
    language: resolveWorkspaceLanguage(process.env.DAYTONA_WORKSPACE_LANGUAGE),
    ephemeral: resolveBooleanEnv(process.env.DAYTONA_WORKSPACE_EPHEMERAL, false),
    autoStopInterval: resolveNumberEnv(process.env.DAYTONA_WORKSPACE_AUTO_STOP_INTERVAL),
    autoArchiveInterval: resolveNumberEnv(process.env.DAYTONA_WORKSPACE_AUTO_ARCHIVE_INTERVAL),
    autoDeleteInterval: resolveNumberEnv(process.env.DAYTONA_WORKSPACE_AUTO_DELETE_INTERVAL),
    resources: {
      cpu: resolveNumberEnv(process.env.DAYTONA_WORKSPACE_CPU) ?? 4,
      memory: resolveNumberEnv(process.env.DAYTONA_WORKSPACE_MEMORY_GB) ?? 8,
      disk: resolveNumberEnv(process.env.DAYTONA_WORKSPACE_DISK_GB) ?? 50,
    },
    // Daytona creates sandboxes with volume mounts declared up front. The mount
    // paths below are the paths agents should use inside the Daytona sandbox;
    // Daytona handles the backend MinIO/S3 volume plumbing outside Mastra.
    volumes: resolveDaytonaVolumeMounts(),
    env: resolveSandboxRuntimeEnv(),
    labels: {
      app: "daytona-agents",
      role: "mastra-workspace",
      managedBy: "mastra-control",
    },
  });
}

function createLocalFilesystem(root: string) {
  return new LocalFilesystem({
    basePath: root,
    allowedPaths: workspaceAccessRoots.filter((accessRoot) => accessRoot !== root),
    // @mastra/core's symlink containment check treats "/" as a special case
    // poorly, so when the access root is the current sandbox root, rely on the
    // surrounding Daytona sandbox boundary rather than LocalFilesystem's
    // basePath containment.
    contained: root !== "/",
  });
}

function createWorkspaceFilesystemConfig() {
  // Use a single filesystem rooted at workspaceRoot so built-in Mastra
  // workspace tools resolve relative paths the same way our custom tools do.
  // Extra access roots remain available through LocalFilesystem.allowedPaths.
  return {
    filesystem: createLocalFilesystem(workspaceRoot),
  };
}

export function resolveWorkspacePath(filePath: string) {
  return resolveConfiguredPath(filePath, workspaceRoot);
}

export const workspaceSandboxProvider = resolveWorkspaceSandboxProvider(
  process.env.MASTRA_WORKSPACE_SANDBOX,
);

export const codingSandbox = workspaceSandboxProvider === "local"
  ? createLocalSandbox()
  : createDaytonaSandbox();

export const workspace = new Workspace({
  id: "daytona-agents",
  name: "Daytona Agents Workspace",
  sandbox: codingSandbox,
  ...createWorkspaceFilesystemConfig(),
  skills: [
    resolveConfiguredPath(".agents/skills", workspaceCommandCwd),
    resolveConfiguredPath("~/.agents/skills"),
  ],
  tools: {
    enabled: false,
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { enabled: true },
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: true },
    [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { enabled: true },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { enabled: true },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { enabled: true },
    [WORKSPACE_TOOLS.SEARCH.SEARCH]: { enabled: true },
    [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: { enabled: true },
  },
  onMount: ({ filesystem, mountPath, sandbox }) => {
    if (filesystem.provider !== "local") {
      return undefined;
    }

    if (sandbox?.provider === "local") {
      return { success: true, mountPath };
    }

    return false;
  },
});

export { workspaceAccessRoots, workspaceCommandCwd, workspaceRoot };
