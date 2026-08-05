import { LocalSandbox } from "@mastra/core/workspace";
import type { CloneableSandboxMachine, SandboxMachineBaseOptions } from "./types.js";

const LOCAL_ENVIRONMENT_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function createLocalSandboxMachine(
  options: SandboxMachineBaseOptions,
): CloneableSandboxMachine {
  const policy = options.specification.spec.local;
  const detection = LocalSandbox.detectIsolation();
  const isolation = policy.isolation === "auto"
    ? (detection.available ? detection.backend : "none")
    : policy.isolation;

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

function allowedLocalEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(LOCAL_ENVIRONMENT_KEYS.flatMap(key => {
    const value = process.env[key];
    return value ? [[key, value]] : [];
  }));
}
