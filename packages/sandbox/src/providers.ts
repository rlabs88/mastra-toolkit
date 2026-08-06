import { LocalSandbox, type SandboxCloneOptions } from "@mastra/core/workspace";

import { type CloneableSandboxMachine, type SandboxMachineBaseOptions, immutableSandboxImageSchema, SANDBOX_RUNTIME_IMAGE_ENV, type PlatformSandboxCredentials, type SandboxRuntimeProfileName } from "./contract.js";

import { DockerSandbox } from "@mastra/docker";

import { PlatformSandbox } from "@mastra/platform-workspace";



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

export interface PlatformSandboxMachineOptions extends SandboxMachineBaseOptions {
  readonly platform: PlatformSandboxCredentials;
}

export function createPlatformSandboxMachine(
  options: PlatformSandboxMachineOptions,
): CloneableSandboxMachine {
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

const RUNTIME_PROBE = "/usr/local/bin/mastra-toolkit-runtime-probe";

type ManagedSandboxMachine = CloneableSandboxMachine & {
  _start?: () => Promise<void>;
  _stop?: () => Promise<void>;
  _destroy?: () => Promise<void>;
};

export function enforceSandboxRuntimeProfile(
  machine: CloneableSandboxMachine,
  profile: SandboxRuntimeProfileName,
  runtimeImage?: string,
): CloneableSandboxMachine {
  if (!machine.executeCommand) {
    throw new Error(`Sandbox provider '${machine.provider}' cannot verify the ${profile} runtime profile`);
  }

  const managed = machine as ManagedSandboxMachine;
  const startProvider = managed._start?.bind(machine) ?? machine.start?.bind(machine);
  const stopProvider = managed._stop?.bind(machine) ?? machine.stop?.bind(machine);
  const destroyProvider = managed._destroy?.bind(machine) ?? machine.destroy?.bind(machine);
  const executeProvider = machine.executeCommand.bind(machine);
  let admitted = false;
  let admissionPromise: Promise<void> | undefined;
  let lifecycleGeneration = 0;

  const ensureAdmitted = (): Promise<void> => {
    if (admitted) return Promise.resolve();
    if (admissionPromise) return admissionPromise;
    const admissionGeneration = lifecycleGeneration;
    admissionPromise = (async () => {
      try {
        await startProvider?.();
        const args = runtimeImage ? [profile, runtimeImage] : [profile];
        const result = await executeProvider(RUNTIME_PROBE, args);
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
          throw new Error(detail);
        }
        if (admissionGeneration !== lifecycleGeneration) {
          throw new AdmissionInterruptedError();
        }
        admitted = true;
      } catch (error) {
        if (error instanceof AdmissionInterruptedError) {
          throw new Error(`Sandbox ${profile} runtime admission was interrupted by lifecycle shutdown`, { cause: error });
        }
        const cleanupDetail = await stopRejectedSandbox(destroyProvider, stopProvider);
        const detail = error instanceof Error ? error.message : String(error);
        const suffix = cleanupDetail ? `; cleanup: ${cleanupDetail}` : "";
        throw new Error(`Sandbox failed ${profile} runtime admission: ${detail}${suffix}`, { cause: error });
      } finally {
        admissionPromise = undefined;
      }
    })();
    return admissionPromise;
  };

  const clone = (options?: SandboxCloneOptions): CloneableSandboxMachine => {
    const cloneOptions = runtimeImage
      ? {
          ...options,
          env: { ...options?.env, [SANDBOX_RUNTIME_IMAGE_ENV]: runtimeImage },
        }
      : options;
    return enforceSandboxRuntimeProfile(
      machine.clone(cloneOptions) as CloneableSandboxMachine,
      profile,
      runtimeImage,
    );
  };
  const stop = async (): Promise<void> => {
    lifecycleGeneration += 1;
    admitted = false;
    await stopProvider?.();
  };
  const destroy = async (): Promise<void> => {
    lifecycleGeneration += 1;
    admitted = false;
    await destroyProvider?.();
  };

  const guardedProcesses = machine.processes
    ? new Proxy(machine.processes, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (["spawn", "list", "get", "kill"].includes(String(property)) && typeof value === "function") {
            return async (...args: unknown[]) => {
              await ensureAdmitted();
              return Reflect.apply(value, target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : undefined;
  const guardedNetworking = machine.networking
    ? new Proxy(machine.networking, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "getPortUrl" && typeof value === "function") {
            return async (...args: unknown[]) => {
              await ensureAdmitted();
              return Reflect.apply(value, target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : undefined;
  const guardedMounts = machine.mounts
    ? new Proxy(machine.mounts, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "processPending" && typeof value === "function") {
            return async (...args: unknown[]) => {
              await ensureAdmitted();
              return Reflect.apply(value, target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : undefined;

  return new Proxy(machine, {
    get(target, property) {
      if (property === "clone") return clone;
      if (property === "start" || property === "_start") return ensureAdmitted;
      if (property === "stop" || property === "_stop") return stop;
      if (property === "destroy" || property === "_destroy") return destroy;
      if (property === "executeCommand") {
        return async (...args: Parameters<NonNullable<CloneableSandboxMachine["executeCommand"]>>) => {
          await ensureAdmitted();
          return executeProvider(...args);
        };
      }
      if (property === "writeFiles" || property === "mount" || property === "unmount") {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await ensureAdmitted();
          return Reflect.apply(value, target, args);
        };
      }
      if (property === "processes") return guardedProcesses;
      if (property === "networking") return guardedNetworking;
      if (property === "mounts") return guardedMounts;
      if (property === "isReady") {
        return async () => admitted && (await machine.isReady?.() ?? true);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}

class AdmissionInterruptedError extends Error {}

async function stopRejectedSandbox(
  destroyProvider: (() => void | Promise<void>) | undefined,
  stopProvider: (() => void | Promise<void>) | undefined,
): Promise<string | undefined> {
  if (destroyProvider) {
    try {
      await destroyProvider();
      return undefined;
    } catch (destroyError) {
      const destroyDetail = destroyError instanceof Error ? destroyError.message : String(destroyError);
      if (!stopProvider) return `destroy failed: ${destroyDetail}; stop unavailable`;
      try {
        await stopProvider();
        return `destroy failed: ${destroyDetail}; stop fallback succeeded`;
      } catch (stopError) {
        const stopDetail = stopError instanceof Error ? stopError.message : String(stopError);
        return `destroy failed: ${destroyDetail}; stop failed: ${stopDetail}`;
      }
    }
  }
  if (stopProvider) {
    try {
      await stopProvider();
      return undefined;
    } catch (stopError) {
      const detail = stopError instanceof Error ? stopError.message : String(stopError);
      return `stop failed: ${detail}`;
    }
  }
  return "no cleanup lifecycle available";
}
