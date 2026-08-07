import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import type { ApiRoute } from "@mastra/core/server";
import { createWorkspaceTools, LocalSandbox } from "@mastra/core/workspace";
import { createWorkspaceFactory, checkpointNameForSession } from "@mastra/factory/workspace";
import type { GithubIntegration } from "@mastra/factory/integrations/github/integration";
import { buildGithubRoutes } from "@mastra/factory/integrations/github/routes";
import { SandboxFleet, type MaterializationSandbox, type SandboxCreateOptions } from "@mastra/factory/sandbox/fleet";
import { createStateSigner } from "@mastra/factory/state-signing";
import {
  SourceControlStorage,
  type SourceControlSession,
  type SourceControlStorageHandle,
} from "@mastra/factory/storage/domains/source-control/base";
import { FactoryProjectsStorage } from "@mastra/factory/storage/domains/projects/base";
import { LibSQLFactoryStorage } from "@mastra/libsql";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";

let runtimeRoot: string | undefined;

afterEach(async () => {
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = undefined;
});

describe("durable Factory project sessions", () => {
  test("persists one sandbox binding, reattaches it after restart, and clears it on teardown", async () => {
    runtimeRoot = await mkdtemp(join(tmpdir(), "rlabs-factory-session-"));
    const databaseUrl = `file:${join(runtimeRoot, "factory.db")}`;
    const firstStore = await openSourceControl(databaseUrl);
    const project = await firstStore.projects.create({
      orgId: "org-1",
      userId: "user-1",
      input: { name: "Mastra Toolkit" },
    });
    const session = await seedSession(firstStore.sourceControl, project.id);
    const firstFleet = createFleet(runtimeRoot);
    const firstBuilds: SandboxCreateOptions[] = [];
    const firstSandboxes: RecordingSandbox[] = [];
    firstFleet.setFactory(options => {
      firstBuilds.push(options);
      const sandbox = new RecordingSandbox("provider-session-1", false);
      firstSandboxes.push(sandbox);
      return sandbox;
    });
    const firstState: Record<string, unknown> = {};
    const firstWorkspaceFactory = createWorkspaceFactory({
      sandbox: { machine: localTemplate(runtimeRoot), workdir: runtimeRoot },
      github: githubBoundary(firstStore.sourceControl),
      fleet: firstFleet,
    });

    const firstWorkspace = await firstWorkspaceFactory(workspaceContext(session.sessionId, firstState));
    const nativeRequestContext = new RequestContext();
    const firstFilesystem = await firstWorkspace.resolveFilesystem({ requestContext: nativeRequestContext });
    const persisted = await firstStore.sourceControl.sessions.getBySessionId(session.sessionId);

    expect(firstFilesystem?.provider).toBe("sandbox");
    expect(firstFilesystem?.basePath).toBe(firstFleet.computeLocalSessionWorkdir("rlabs88/mastra-toolkit", session.id));
    expect(firstState).toEqual({
      projectPath: firstFilesystem?.basePath,
      projectName: "rlabs88/mastra-toolkit",
    });
    expect(persisted?.sandboxId).toBe("provider-session-1");
    expect(persisted?.sandboxWorkdir).toBe(firstFilesystem?.basePath);
    expect(persisted?.materializedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(persisted)).not.toContain("task-scoped-token");
    expect(firstBuilds).toEqual([expect.objectContaining({
      checkpointName: checkpointNameForSession(session.id),
      env: { GH_TOKEN: "task-scoped-token" },
      workingDirectory: firstFilesystem?.basePath,
    })]);
    expect(firstBuilds[0]?.providerSandboxId).toBeUndefined();
    expect(firstSandboxes[0]?.commands.some(command => command.script.includes("git clone"))).toBe(true);
    expect(firstSandboxes[0]?.commands.some(command => command.script.includes("npm run setup:fixture"))).toBe(true);
    expect(firstSandboxes[0]?.commands.at(-1)?.script).toContain("npm run setup:fixture");
    expect(process.env.GH_TOKEN).toBeUndefined();
    const nativeTools = await createWorkspaceTools(firstWorkspace, {
      requestContext: nativeRequestContext,
      workspace: firstWorkspace,
    });
    expect(Object.keys(nativeTools)).toEqual(expect.arrayContaining(["view", "find_files", "write_file", "execute_command"]));
    expect(Object.keys(nativeTools)).not.toEqual(expect.arrayContaining(["command_run", "adhd_run"]));
    await nativeTools.execute_command.execute(
      { command: "pwd" },
      { requestContext: nativeRequestContext, workspace: firstWorkspace },
    );
    expect(firstSandboxes[0]?.commands.at(-1)?.script).toContain("pwd");

    await firstStore.storage.close();

    const restartedStore = await openSourceControl(databaseUrl);
    const restartedFleet = createFleet(runtimeRoot);
    const restartedBuilds: SandboxCreateOptions[] = [];
    const restartedSandboxes: RecordingSandbox[] = [];
    restartedFleet.setFactory(options => {
      restartedBuilds.push(options);
      const sandbox = new RecordingSandbox(options.providerSandboxId ?? "unexpected-provider", true);
      restartedSandboxes.push(sandbox);
      return sandbox;
    });
    const restartedState: Record<string, unknown> = {};
    const restartedWorkspaceFactory = createWorkspaceFactory({
      sandbox: { machine: localTemplate(runtimeRoot), workdir: runtimeRoot },
      github: githubBoundary(restartedStore.sourceControl),
      fleet: restartedFleet,
    });

    const resumedWorkspace = await restartedWorkspaceFactory(workspaceContext(session.sessionId, restartedState));
    const resumedFilesystem = await resumedWorkspace.resolveFilesystem({ requestContext: new RequestContext() });
    const resumedSession = await restartedStore.sourceControl.sessions.getBySessionId(session.sessionId);

    expect(restartedBuilds).toEqual([expect.objectContaining({
      providerSandboxId: "provider-session-1",
      checkpointName: checkpointNameForSession(session.id),
      env: { GH_TOKEN: "task-scoped-token" },
      workingDirectory: persisted?.sandboxWorkdir,
    })]);
    expect(resumedFilesystem?.provider).toBe("sandbox");
    expect(resumedFilesystem?.basePath).toBe(persisted?.sandboxWorkdir);
    expect(restartedState).toEqual({
      projectPath: persisted?.sandboxWorkdir,
      projectName: "rlabs88/mastra-toolkit",
    });
    expect(restartedSandboxes[0]?.commands.some(command => command.script.includes("git clone"))).toBe(false);
    expect(restartedSandboxes[0]?.commands.some(command => command.script.includes("pull --ff-only"))).toBe(true);
    expect(restartedSandboxes[0]?.commands.some(command => command.script.includes("task-scoped-token"))).toBe(true);
    expect(restartedSandboxes[0]?.commands.some(command => command.script.includes("remote set-url origin 'https://github.com/rlabs88/mastra-toolkit.git'"))).toBe(true);

    if (!resumedSession?.sandboxId || !resumedSession.sandboxWorkdir) throw new Error("Expected a durable sandbox session binding");
    const teardownRoute = buildGithubRoutes({
      auth: {
        enabled: () => true,
        ensureUser: async () => ({ id: "user-1", organizationId: "org-1" }),
        tenant: () => ({ orgId: "org-1", userId: "user-1" }),
        isOrganizationAdmin: async () => true,
      },
      fleet: restartedFleet,
      storage: restartedStore.storage,
      github: githubBoundary(restartedStore.sourceControl),
      stateSigner: createStateSigner("test-stable-state-secret"),
    }).find((route): route is Extract<ApiRoute, { handler: unknown }> =>
      route.path === "/web/user-sessions/:sessionId" && route.method === "DELETE" && "handler" in route);
    if (!teardownRoute) throw new Error("Factory session teardown route was not registered");
    const app = new Hono();
    app.on("DELETE", teardownRoute.path, teardownRoute.handler);
    const teardownResponse = await app.request(`/web/user-sessions/${session.sessionId}`, { method: "DELETE" });

    expect(teardownResponse.status).toBe(200);
    await expect(teardownResponse.json()).resolves.toEqual({ removed: true });
    expect(restartedSandboxes.at(-1)?.stopped).toBe(true);
    await expect(restartedStore.sourceControl.sessions.getBySessionId(session.sessionId)).resolves.toBeNull();
    await restartedStore.storage.close();
  }, 30_000);

  test("replaces a stale provider binding without carrying session credentials into durable state", async () => {
    runtimeRoot = await mkdtemp(join(tmpdir(), "rlabs-factory-session-recovery-"));
    const databaseUrl = `file:${join(runtimeRoot, "factory.db")}`;
    const seededStore = await openSourceControl(databaseUrl);
    const project = await seededStore.projects.create({
      orgId: "org-1",
      userId: "user-1",
      input: { name: "Mastra Toolkit recovery" },
    });
    const session = await seedSession(seededStore.sourceControl, project.id);
    const expectedWorkdir = createFleet(runtimeRoot).computeLocalSessionWorkdir("rlabs88/mastra-toolkit", session.id);
    await seededStore.sourceControl.sessions.setSandbox({
      id: session.id,
      sandboxId: "stale-provider-session",
      sandboxWorkdir: expectedWorkdir,
    });
    await seededStore.sourceControl.sessions.markMaterialized({ id: session.id });
    await seededStore.storage.close();

    const recoveredStore = await openSourceControl(databaseUrl);
    const fleet = createFleet(runtimeRoot);
    const builds: SandboxCreateOptions[] = [];
    fleet.setFactory(options => {
      builds.push(options);
      return options.providerSandboxId
        ? new RecordingSandbox(options.providerSandboxId, true, true)
        : new RecordingSandbox("replacement-provider-session", false);
    });
    const workspaceFactory = createWorkspaceFactory({
      sandbox: { machine: localTemplate(runtimeRoot), workdir: runtimeRoot },
      github: githubBoundary(recoveredStore.sourceControl),
      fleet,
    });

    const workspace = await workspaceFactory(workspaceContext(session.sessionId, {}));
    const filesystem = await workspace.resolveFilesystem({ requestContext: new RequestContext() });
    const recovered = await recoveredStore.sourceControl.sessions.getBySessionId(session.sessionId);

    expect(builds).toHaveLength(2);
    expect(builds[0]?.providerSandboxId).toBe("stale-provider-session");
    expect(builds[1]?.providerSandboxId).toBeUndefined();
    expect(filesystem?.provider).toBe("sandbox");
    expect(filesystem?.basePath).toBe(expectedWorkdir);
    expect(recovered?.sandboxId).toBe("replacement-provider-session");
    expect(recovered?.materializedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(recovered)).not.toContain("task-scoped-token");
    await recoveredStore.storage.close();
  }, 30_000);
});

async function openSourceControl(databaseUrl: string): Promise<{
  storage: LibSQLFactoryStorage;
  projects: FactoryProjectsStorage;
  sourceControl: SourceControlStorageHandle;
}> {
  const storage = new LibSQLFactoryStorage({ id: "factory-session-runtime-test", url: databaseUrl });
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const domain = storage.registerDomain(new SourceControlStorage());
  await storage.init();
  return { storage, projects, sourceControl: domain.forIntegration("github") };
}

async function seedSession(
  sourceControl: SourceControlStorageHandle,
  factoryProjectId: string,
): Promise<SourceControlSession> {
  const installation = await sourceControl.installations.upsert({
    orgId: "org-1",
    connectedByUserId: "user-1",
    externalId: "installation-1",
    accountName: "rlabs88",
  });
  const repository = await sourceControl.repositories.upsert({
    orgId: "org-1",
    input: {
      installationId: installation.id,
      externalId: "repository-1",
      slug: "rlabs88/mastra-toolkit",
      defaultBranch: "main",
    },
  });
  const connection = await sourceControl.connections.create({
    orgId: "org-1",
    factoryProjectId,
    installationId: installation.id,
    createdByUserId: "user-1",
  });
  const projectRepository = await sourceControl.projectRepositories.link({
    orgId: "org-1",
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: "user-1",
    sandboxProvider: "local",
    sandboxWorkdir: "/unused/session/path",
    setupCommand: "npm run setup:fixture",
  });
  return sourceControl.sessions.create({
    sessionId: "controller-session-1",
    projectRepositoryId: projectRepository.id,
    orgId: "org-1",
    userId: "user-1",
    branch: "codex/session-1",
    baseBranch: "main",
  });
}

function createFleet(root: string): SandboxFleet {
  return new SandboxFleet({ machine: localTemplate(root), workdirBase: root, maxSandboxes: 1 });
}

function localTemplate(root: string): LocalSandbox {
  return new LocalSandbox({ workingDirectory: root, isolation: "none", env: process.env });
}

function githubBoundary(sourceControlStorage: SourceControlStorageHandle): GithubIntegration {
  return {
    sourceControlStorage,
    integrationStorage: undefined,
    versionControl: {
      getRepositoryAccess: async () => ({
        cloneUrl: "https://github.com/rlabs88/mastra-toolkit.git",
        authorization: { scheme: "bearer", token: "task-scoped-token" },
      }),
    },
  } as unknown as GithubIntegration;
}

function workspaceContext(sessionId: string, state: Record<string, unknown>) {
  const requestContext = new RequestContext();
  requestContext.set("user", { id: "user-1", organizationId: "org-1" });
  requestContext.set("controller", {
    resourceId: sessionId,
    getState: () => state,
    setState: async (update: Record<string, unknown>) => { Object.assign(state, update); },
  });
  return {
    requestContext,
  };
}

class RecordingSandbox implements MaterializationSandbox {
  readonly commands: Array<{ command: string; script: string }> = [];
  stopped = false;

  constructor(
    readonly id: string,
    private readonly existingCheckout: boolean,
    private readonly failStart = false,
  ) {}

  async start(): Promise<void> {
    if (this.failStart) throw new Error("provider sandbox no longer exists");
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async getInfo(): Promise<{ metadata: Record<string, unknown> }> {
    return { metadata: { sandboxId: this.id } };
  }

  setEnvironmentVariable(): void {}

  async executeCommand(command: string, args: string[] = []): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    const script = command === "sh" && args[0] === "-c" ? args[1] ?? "" : [command, ...args].join(" ");
    this.commands.push({ command, script });
    if (script.includes("remote get-url origin")) {
      return this.existingCheckout
        ? { exitCode: 0, stdout: "https://github.com/rlabs88/mastra-toolkit.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "not materialized" };
    }
    if (script.includes("branch --show-current")) {
      return { exitCode: 0, stdout: "codex/session-1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}
