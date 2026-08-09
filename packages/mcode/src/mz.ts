import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";

import { detectProject } from "@mastra/code-sdk/utils/project";
import { prepareProjectHostDataDirectory, resolveHostDataPaths } from "@rlabs/runtime-config";

import type { McodeRuntimeDescriptor } from "./runtime.js";

export interface MzRuntimeBinding {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
  readonly projectRoot: string;
  readonly url: string;
  readonly controllerId: string;
  readonly resourceId: string;
  readonly contractDigest: `sha256:${string}`;
  readonly remoteTuiCapabilities: McodeRuntimeDescriptor["remoteTuiCapabilities"];
  readonly remoteTuiSubagents: McodeRuntimeDescriptor["remoteTuiSubagents"];
  readonly managed: boolean;
  readonly pid?: number;
  readonly logPath?: string;
  readonly startedAt?: string;
  readonly stopPath?: string;
}

export interface MzLaunchRequest {
  readonly projectRoot: string;
  readonly port: number;
  readonly url: string;
  readonly runtimeId: string;
}

export interface MzLaunchResult {
  readonly pid: number;
  readonly logPath: string;
  readonly url: string;
  readonly stopPath?: string;
}

export interface MzRuntimeManagerOptions {
  readonly projectRoot: string;
  readonly registryDirectory: string;
  readonly probe?: (url: string) => Promise<McodeRuntimeDescriptor | undefined>;
  readonly findAvailablePort?: (start: number) => Promise<number>;
  readonly launch: (request: MzLaunchRequest) => Promise<MzLaunchResult>;
  readonly readBinding?: () => Promise<MzRuntimeBinding | undefined>;
  readonly persistBinding?: (binding: MzRuntimeBinding) => Promise<void>;
  readonly terminate?: (pid: number) => void;
  readonly readinessAttempts?: number;
  readonly readinessDelayMs?: number;
}

export interface MzProjectContext {
  readonly projectRoot: string;
  readonly registryDirectory: string;
  readonly bindingPath: string;
  readonly manager: MzRuntimeManager;
}

export class MzRuntimeManager {
  readonly #options: MzRuntimeManagerOptions;
  readonly #projectRoot: string;

  constructor(options: MzRuntimeManagerOptions) {
    this.#options = options;
    this.#projectRoot = resolve(options.projectRoot);
  }

  async ensureRuntime(explicitUrl?: string): Promise<MzRuntimeBinding> {
    if (explicitUrl) {
      assertLoopbackRuntimeUrl(explicitUrl);
      const descriptor = await this.#probe(explicitUrl);
      if (!descriptor) throw new Error(`No Mastra Studio runtime is available at ${explicitUrl}`);
      const ready = this.#isReady(descriptor) ? descriptor : await this.#waitUntilReady(explicitUrl);
      const recorded = await this.#options.readBinding?.();
      const preservesManagedOwnership = recorded?.managed === true
        && recorded.runtimeId === ready.runtimeId;
      const binding = {
        ...this.#bindingForDescriptor(explicitUrl, ready, preservesManagedOwnership),
        ...(preservesManagedOwnership && recorded.pid !== undefined ? { pid: recorded.pid } : {}),
        ...(preservesManagedOwnership && recorded.logPath !== undefined ? { logPath: recorded.logPath } : {}),
        ...(preservesManagedOwnership && recorded.startedAt !== undefined ? { startedAt: recorded.startedAt } : {}),
        ...(preservesManagedOwnership && recorded.stopPath !== undefined ? { stopPath: recorded.stopPath } : {}),
      };
      await this.#options.persistBinding?.(binding);
      return binding;
    }

    const recorded = await this.#options.readBinding?.();
    if (recorded && isLoopbackRuntimeUrl(recorded.url)) {
      let descriptor = await (this.#options.probe ?? probeMcodeRuntime)(recorded.url);
      if (!descriptor && recorded.managed) {
        try {
          descriptor = await this.#waitUntilReady(recorded.url);
        } catch {
          descriptor = undefined;
        }
      }
      if (descriptor && this.#matches(descriptor)) {
        const ready = this.#isReady(descriptor) ? descriptor : await this.#waitUntilReady(recorded.url);
        const stillManaged = recorded.managed && recorded.runtimeId === ready.runtimeId;
        const binding = {
          ...this.#bindingForDescriptor(recorded.url, ready, stillManaged),
          ...(stillManaged && recorded.pid !== undefined ? { pid: recorded.pid } : {}),
          ...(stillManaged && recorded.logPath !== undefined ? { logPath: recorded.logPath } : {}),
          ...(stillManaged && recorded.startedAt !== undefined ? { startedAt: recorded.startedAt } : {}),
          ...(stillManaged && recorded.stopPath !== undefined ? { stopPath: recorded.stopPath } : {}),
        };
        await this.#options.persistBinding?.(binding);
        return binding;
      }
    }

    const defaultUrl = "http://127.0.0.1:4111";
    const existing = await this.#options.probe?.(defaultUrl) ?? await probeMcodeRuntime(defaultUrl);
    if (existing && this.#matches(existing)) {
      const ready = this.#isReady(existing) ? existing : await this.#waitUntilReady(defaultUrl);
      const binding = this.#bindingForDescriptor(defaultUrl, ready, false);
      await this.#options.persistBinding?.(binding);
      return binding;
    }

    const port = await (this.#options.findAvailablePort ?? findAvailableLoopbackPort)(existing ? 4112 : 4111);
    const url = `http://127.0.0.1:${port}`;
    const runtimeId = randomUUID();
    const launched = await this.#options.launch({ projectRoot: this.#projectRoot, port, url, runtimeId });
    let descriptor: McodeRuntimeDescriptor;
    try {
      descriptor = await this.#waitUntilReady(url);
      if (descriptor.runtimeId !== runtimeId) {
        throw new Error(`Mastra Studio at ${url} did not start with the expected runtime identity`);
      }
    } catch (error) {
      try {
        (this.#options.terminate ?? (pid => process.kill(pid, "SIGTERM")))(launched.pid);
      } catch (terminateError) {
        if (!(terminateError instanceof Error && "code" in terminateError && terminateError.code === "ESRCH")) {
          throw new AggregateError([error, terminateError], `Mastra Studio failed to start and could not be stopped`);
        }
      }
      throw error;
    }
    const binding: MzRuntimeBinding = {
      ...this.#bindingForDescriptor(url, descriptor, true),
      pid: launched.pid,
      logPath: launched.logPath,
      startedAt: new Date().toISOString(),
      ...(launched.stopPath ? { stopPath: launched.stopPath } : {}),
    };
    await this.#options.persistBinding?.(binding);
    return binding;
  }

  async #waitUntilReady(url: string): Promise<McodeRuntimeDescriptor> {
    let lastError: unknown;
    const attempts = this.#options.readinessAttempts ?? 120;
    const delayMs = this.#options.readinessDelayMs ?? 250;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const descriptor = await this.#probe(url);
        if (descriptor && this.#isReady(descriptor)) return descriptor;
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < attempts) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
    }
    throw new Error(`Mastra Studio did not become ready at ${url}`, { cause: lastError });
  }

  async #probe(url: string): Promise<McodeRuntimeDescriptor | undefined> {
    const descriptor = await (this.#options.probe ?? probeMcodeRuntime)(url);
    if (!descriptor) return undefined;
    if (!this.#matches(descriptor)) {
      throw new Error(`Mastra Studio at ${url} is mounted for ${descriptor.projectRoot}, not ${this.#projectRoot}`);
    }
    return descriptor;
  }

  #matches(descriptor: McodeRuntimeDescriptor): boolean {
    return descriptor.schemaVersion === 1
      && descriptor.remoteTuiProtocolVersion === 1
      && resolve(descriptor.projectRoot) === this.#projectRoot;
  }

  #isReady(descriptor: McodeRuntimeDescriptor): boolean {
    return descriptor.mounting.ready
      && descriptor.observability.enabled
      && descriptor.observability.export === "local-only";
  }

  #bindingForDescriptor(url: string, descriptor: McodeRuntimeDescriptor, managed: boolean): MzRuntimeBinding {
    if (!this.#matches(descriptor)) {
      throw new Error(`Mastra Studio at ${url} is mounted for ${descriptor.projectRoot}, not ${this.#projectRoot}`);
    }
    return {
      schemaVersion: 1,
      runtimeId: descriptor.runtimeId,
      projectRoot: this.#projectRoot,
      url,
      controllerId: descriptor.controllerId,
      resourceId: descriptor.resourceId,
      contractDigest: descriptor.contractDigest,
      remoteTuiCapabilities: descriptor.remoteTuiCapabilities,
      remoteTuiSubagents: descriptor.remoteTuiSubagents,
      managed,
    };
  }
}

export async function probeMcodeRuntime(url: string): Promise<McodeRuntimeDescriptor | undefined> {
  try {
    const response = await fetch(new URL("/mz/runtime", url), { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return undefined;
    return mcodeRuntimeDescriptorSchema.safeParse(await response.json()).data;
  } catch {
    return undefined;
  }
}

export async function createMzProjectContext(options: {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly toolkitRoot?: string;
} = {}): Promise<MzProjectContext> {
  const environment = options.environment ?? process.env;
  const detected = detectProject(resolve(options.cwd ?? process.cwd()));
  const projectRoot = await realpath(detected.rootPath);
  const registryDirectory = join(resolveHostDataPaths("studio", environment).rootDirectory, "mz");
  const bindingPath = mzBindingPath(registryDirectory, projectRoot);
  const toolkitRoot = options.toolkitRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const manager = new MzRuntimeManager({
    projectRoot,
    registryDirectory,
    readBinding: () => readMzBinding(bindingPath),
    persistBinding: binding => writeMzBinding(bindingPath, binding),
    launch: request => launchMzStudio({ ...request, environment, registryDirectory, toolkitRoot }),
  });
  return { projectRoot, registryDirectory, bindingPath, manager };
}

export async function ensureMzRuntime(options: {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly toolkitRoot?: string;
  readonly url?: string;
} = {}): Promise<{ context: MzProjectContext; binding: MzRuntimeBinding }> {
  const context = await createMzProjectContext(options);
  const lockPath = join(context.registryDirectory, "locks", `${mzProjectId(context.projectRoot)}.lock`);
  const portLockPath = join(context.registryDirectory, "locks", "port-allocation.lock");
  const binding = await withMzStartupLock(lockPath, () =>
    withMzStartupLock(portLockPath, () => context.manager.ensureRuntime(options.url))
  );
  return { context, binding };
}

export async function readMzBinding(path: string): Promise<MzRuntimeBinding | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<MzRuntimeBinding>;
    if (
      value.schemaVersion !== 1
      || typeof value.runtimeId !== "string"
      || typeof value.projectRoot !== "string"
      || typeof value.url !== "string"
      || !isLoopbackRuntimeUrl(value.url)
      || typeof value.controllerId !== "string"
      || typeof value.resourceId !== "string"
      || typeof value.contractDigest !== "string"
      || typeof value.remoteTuiCapabilities !== "object"
      || value.remoteTuiCapabilities === null
      || !Array.isArray(value.remoteTuiSubagents)
      || typeof value.managed !== "boolean"
    ) return undefined;
    return value as MzRuntimeBinding;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function stopMzRuntime(context: MzProjectContext, options: {
  readonly probe?: (url: string) => Promise<McodeRuntimeDescriptor | undefined>;
  readonly attempts?: number;
  readonly delayMs?: number;
} = {}): Promise<boolean> {
  const binding = await readMzBinding(context.bindingPath);
  if (!binding?.managed || !binding.stopPath) return false;
  const probe = options.probe ?? probeMcodeRuntime;
  const attempts = options.attempts ?? 100;
  const delayMs = options.delayMs ?? 100;
  let descriptor: McodeRuntimeDescriptor | undefined;
  const identityAttempts = Math.min(attempts, 50);
  for (let attempt = 0; attempt < identityAttempts; attempt++) {
    descriptor = await probe(binding.url);
    if (descriptor) break;
    if (attempt + 1 < identityAttempts) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
  }
  if (
    !descriptor
    || resolve(descriptor.projectRoot) !== context.projectRoot
    || descriptor.runtimeId !== binding.runtimeId
  ) return false;
  await mkdir(dirname(binding.stopPath), { recursive: true, mode: 0o700 });
  await writeFile(binding.stopPath, `${binding.runtimeId}\n`, { mode: 0o600 });
  // The supervisor allows its Studio child 5s to exit after TERM, then 2s
  // after KILL. Keep the client deadline beyond that entire escalation window.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await probe(binding.url);
    if (!current || current.runtimeId !== binding.runtimeId) break;
    if (attempt === attempts - 1) {
      throw new Error(`Timed out waiting for mz Studio runtime ${binding.runtimeId} to stop`);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
  }
  await unlink(context.bindingPath).catch(error => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
  return true;
}

export async function resolveMzCurrentBinding(
  context: MzProjectContext,
  probe: (url: string) => Promise<McodeRuntimeDescriptor | undefined> = probeMcodeRuntime,
): Promise<MzRuntimeBinding | undefined> {
  const recorded = await readMzBinding(context.bindingPath);
  if (recorded && isLoopbackRuntimeUrl(recorded.url)) {
    const live = await probe(recorded.url);
    if (
      live
      && live.schemaVersion === 1
      && live.remoteTuiProtocolVersion === 1
      && resolve(live.projectRoot) === context.projectRoot
      && live.runtimeId === recorded.runtimeId
    ) {
      return {
        schemaVersion: 1,
        runtimeId: live.runtimeId,
        projectRoot: context.projectRoot,
        url: recorded.url,
        controllerId: live.controllerId,
        resourceId: live.resourceId,
        contractDigest: live.contractDigest,
        remoteTuiCapabilities: live.remoteTuiCapabilities,
        remoteTuiSubagents: live.remoteTuiSubagents,
        managed: recorded.managed,
        ...(recorded.pid !== undefined ? { pid: recorded.pid } : {}),
        ...(recorded.logPath !== undefined ? { logPath: recorded.logPath } : {}),
        ...(recorded.startedAt !== undefined ? { startedAt: recorded.startedAt } : {}),
        ...(recorded.stopPath !== undefined ? { stopPath: recorded.stopPath } : {}),
      };
    }
  }
  const defaultUrl = "http://127.0.0.1:4111";
  const live = await probe(defaultUrl);
  if (
    !live
    || live.schemaVersion !== 1
    || live.remoteTuiProtocolVersion !== 1
    || resolve(live.projectRoot) !== context.projectRoot
  ) return undefined;
  return {
    schemaVersion: 1,
    runtimeId: live.runtimeId,
    projectRoot: context.projectRoot,
    url: defaultUrl,
    controllerId: live.controllerId,
    resourceId: live.resourceId,
    contractDigest: live.contractDigest,
    remoteTuiCapabilities: live.remoteTuiCapabilities,
    remoteTuiSubagents: live.remoteTuiSubagents,
    managed: false,
  };
}

function assertLoopbackRuntimeUrl(value: string): void {
  if (!isLoopbackRuntimeUrl(value)) {
    throw new Error("mz accepts only an HTTP Mastra Studio runtime on the local loopback interface");
  }
}

function isLoopbackRuntimeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "http:"
      && loopback
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

export async function runRemoteMzTui(binding: MzRuntimeBinding): Promise<void> {
  assertLoopbackRuntimeUrl(binding.url);
  const projectData = await prepareProjectHostDataDirectory("studio", binding.projectRoot, process.env);
  process.env.MASTRA_APP_DATA_DIR = projectData.directory;
  const loaded: unknown = await import("mastracode/tui");
  if (typeof loaded !== "object" || loaded === null) throw new Error("Unable to load mastracode/tui");
  const module = loaded as Record<string, unknown>;
  const createBackend = module.createRemoteMastraTUIBackend;
  const MastraTui = module.MastraTUI;
  if (typeof createBackend !== "function" || typeof MastraTui !== "function") {
    throw new Error("Installed mastracode does not include the remote TUI backend required by mz");
  }
  const backend = createBackend({
    baseUrl: binding.url,
    controllerId: binding.controllerId,
    resourceId: binding.resourceId,
    scope: binding.projectRoot,
    tags: { projectPath: binding.projectRoot },
    capabilities: binding.remoteTuiCapabilities,
    subagents: binding.remoteTuiSubagents,
  });
  const tui = Reflect.construct(MastraTui, [{ backend, appName: "mz" }]) as { run?: unknown };
  if (typeof tui.run !== "function") throw new Error("MastraTUI does not expose run()");
  await tui.run();
}

async function launchMzStudio(options: MzLaunchRequest & {
  readonly environment: NodeJS.ProcessEnv;
  readonly registryDirectory: string;
  readonly toolkitRoot: string;
}): Promise<MzLaunchResult> {
  const projectData = await prepareProjectHostDataDirectory("studio", options.projectRoot, options.environment);
  const logDirectory = join(options.registryDirectory, "logs");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const logPath = join(logDirectory, `${mzProjectId(options.projectRoot)}.log`);
  const controlDirectory = join(options.registryDirectory, "control");
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
  const stopPath = join(controlDirectory, `${mzProjectId(options.projectRoot)}-${options.runtimeId}.stop`);
  await unlink(stopPath).catch(error => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
  const log = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [
    join(options.toolkitRoot, "apps", "mcode", "bin", "mz-server.mjs"),
  ], {
    cwd: options.toolkitRoot,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...options.environment,
      MASTRA_TOOLKIT_PROJECT_ROOT: options.projectRoot,
      MZ_RUNTIME_ID: options.runtimeId,
      MZ_TOOLKIT_ROOT: options.toolkitRoot,
      MZ_DEV_ROOT: join(projectData.directory, "dev-root"),
      MZ_RESTART_FILE: join(projectData.directory, "restart-requested"),
      MZ_STOP_FILE: stopPath,
      MASTRA_APP_DATA_DIR: projectData.directory,
      MASTRA_AUTO_DETECT_URL: "true",
      MASTRA_HOST: "127.0.0.1",
      HOST: "127.0.0.1",
      PORT: String(options.port),
    },
  });
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
  } finally {
    await log.close();
  }
  if (child.pid === undefined) throw new Error("Mastra Studio did not provide a process ID");
  child.unref();
  return { pid: child.pid, logPath, url: options.url, stopPath };
}

async function withMzStartupLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        return await action();
      } finally {
        await handle.close();
        await unlink(path).catch(() => {});
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await reclaimDeadMzLock(path)) continue;
      if (Date.now() - startedAt > 30_000) throw new Error(`Timed out waiting for mz startup lock: ${path}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
  }
}

async function reclaimDeadMzLock(path: string): Promise<boolean> {
  let owner: number;
  try {
    owner = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) {
    try {
      const lock = await stat(path);
      // A live owner writes its PID immediately after the exclusive create.
      // Give that tiny window one second; malformed state older than that can
      // only be an interrupted/stale lock and is safe to reclaim.
      if (Date.now() - lock.mtimeMs < 1_000) return false;
      await unlink(path);
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ENOENT";
    }
  }
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return false;
    await unlink(path).catch(unlinkError => {
      if (!(unlinkError instanceof Error && "code" in unlinkError && unlinkError.code === "ENOENT")) throw unlinkError;
    });
    return true;
  }
}

const mcodeRuntimeDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  remoteTuiProtocolVersion: z.literal(1),
  remoteTuiCapabilities: z.object({
    chat: z.boolean(),
    threads: z.boolean(),
    modes: z.boolean(),
    models: z.boolean(),
    goals: z.boolean(),
    permissions: z.boolean(),
    approvals: z.boolean(),
    skills: z.boolean(),
  }),
  remoteTuiSubagents: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  runtimeId: z.string().min(1),
  projectRoot: z.string().min(1),
  controllerId: z.string().min(1),
  resourceId: z.string().min(1),
  contractDigest: z.string().regex(/^sha256:.+/).transform(value => value as `sha256:${string}`),
  mounting: z.object({ ready: z.boolean(), generation: z.number().int().nonnegative() }),
  observability: z.object({
    enabled: z.boolean(),
    export: z.enum(["local-only", "disabled"]),
  }),
});

export function mzProjectId(projectRoot: string): string {
  return createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16);
}

export function mzBindingPath(registryDirectory: string, projectRoot: string): string {
  return join(registryDirectory, "runtimes", `${mzProjectId(projectRoot)}.json`);
}

export async function findAvailableLoopbackPort(start: number): Promise<number> {
  for (let port = start; port <= 65_535; port++) {
    const available = await new Promise<boolean>(resolveAvailability => {
      const server = createServer();
      server.once("error", () => resolveAvailability(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailability(true)));
    });
    if (available) return port;
  }
  throw new Error(`No loopback port is available at or above ${start}`);
}

export async function writeMzBinding(path: string, binding: MzRuntimeBinding): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(binding, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
