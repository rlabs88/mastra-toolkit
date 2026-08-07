import { randomUUID } from "node:crypto";
import type { ApiRoute } from "@mastra/core/server";
import { MastraWorker } from "@mastra/core/worker";
import type { FactoryIntegration, IntegrationContext } from "@mastra/factory";
import type { GithubProjectsPort } from "./github-projects-client.js";
import {
  GithubProjectsReconciler,
  type FactoryAutomationCommandsPort,
  type LinkedRepositoryResolver,
} from "./reconciler.js";
import type { GithubProjectsStorage } from "./storage.js";
import type { GithubProjectsFactoryConfig } from "./types.js";

export interface VerifiedGithubWebhookEvent {
  readonly event: string;
  readonly deliveryId: string;
  readonly payload: Record<string, unknown>;
}

export interface GithubProjectsIntegrationOptions {
  readonly config: GithubProjectsFactoryConfig;
  readonly storage: GithubProjectsStorage;
  readonly github: GithubProjectsPort;
  readonly ownerId?: string;
}

export class GithubProjectsFactoryIntegration implements FactoryIntegration {
  readonly id = "github-projects-v2";
  readonly #ownerId: string;
  #commands?: FactoryAutomationCommandsPort;

  constructor(private readonly options: GithubProjectsIntegrationOptions) {
    this.#ownerId = options.ownerId ?? randomUUID();
  }

  initializeAutomation(args: { commands: FactoryAutomationCommandsPort }): void {
    this.#commands = args.commands;
  }

  routes(_context: IntegrationContext): ApiRoute[] { return []; }

  workers(context: IntegrationContext): MastraWorker[] {
    if (!this.#commands || !context.storage.sourceControlOwner) return [];
    const repositories = linkedRepositoryResolver(context.storage.sourceControlOwner);
    const reconciler = new GithubProjectsReconciler({
      config: this.options.config,
      storage: this.options.storage,
      github: this.options.github,
      commands: this.#commands,
      repositories,
      ownerId: this.#ownerId,
    });
    return [new GithubProjectsSchedulerWorker(reconciler, this.options.config.reconcileIntervalMs)];
  }

  async observeVerifiedWebhook(event: VerifiedGithubWebhookEvent): Promise<void> {
    if (event.event !== "projects_v2" && event.event !== "projects_v2_item") return;
    const projectNodeId = githubProjectNodeId(event.payload);
    const configuredProjectIds = new Set(this.options.config.bindings.map(binding => binding.githubProjectNodeId));
    if (!projectNodeId || !configuredProjectIds.has(projectNodeId)) return;
    if (event.event === "projects_v2_item") {
      const changedFieldId = githubChangedFieldId(event.payload);
      const binding = this.options.config.bindings.find(candidate => candidate.githubProjectNodeId === projectNodeId);
      const schedulingFieldIds = new Set([
        binding?.statusFieldId,
        binding?.executionFieldId,
        binding?.workTypeFieldId,
        binding?.workspaceFieldId,
        binding?.priorityFieldId,
      ].filter((value): value is string => Boolean(value)));
      if (changedFieldId && !schedulingFieldIds.has(changedFieldId)) return;
    }
    const projectItem = event.payload.projects_v2_item;
    const projectItemNodeId = projectItem && typeof projectItem === "object"
      && typeof (projectItem as Record<string, unknown>).node_id === "string"
      ? (projectItem as Record<string, unknown>).node_id as string
      : undefined;
    await this.options.storage.enqueueReconcile({
      deliveryId: event.deliveryId,
      event: event.event,
      ...(projectItemNodeId ? { projectItemNodeId } : {}),
    });
  }

  diagnostics(): Record<string, unknown> {
    return {
      configured: true,
      bindingCount: this.options.config.bindings.length,
      enabledBindingCount: this.options.config.bindings.filter(binding => binding.enabled).length,
      schedulingAuthority: "github-project-fields",
      identity: "github-content-node-id",
      automationCommandsBound: Boolean(this.#commands),
    };
  }
}

export function createGithubProjectsFactoryIntegration(
  options: GithubProjectsIntegrationOptions,
): GithubProjectsFactoryIntegration {
  return new GithubProjectsFactoryIntegration(options);
}

class GithubProjectsSchedulerWorker extends MastraWorker {
  readonly name = "github-projects-v2-scheduler";
  #running = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<void> | undefined;
  constructor(private readonly reconciler: GithubProjectsReconciler, private readonly intervalMs: number) { super(); }
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#tick();
    this.#timer = setInterval(() => { void this.#tick(); }, this.intervalMs);
    this.#timer.unref?.();
  }
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }
  get isRunning(): boolean { return this.#running; }
  async #tick(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.reconciler.runOnce()
      .then(() => undefined)
      .catch(error => { console.warn("[github-projects-v2] reconciliation failed", error); })
      .finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }
}

function githubProjectNodeId(payload: Record<string, unknown>): string | undefined {
  const project = payload.projects_v2;
  if (project && typeof project === "object" && typeof (project as Record<string, unknown>).node_id === "string") {
    return (project as Record<string, unknown>).node_id as string;
  }
  const item = payload.projects_v2_item;
  if (item && typeof item === "object" && typeof (item as Record<string, unknown>).project_node_id === "string") {
    return (item as Record<string, unknown>).project_node_id as string;
  }
  return undefined;
}

function githubChangedFieldId(payload: Record<string, unknown>): string | undefined {
  const changes = payload.changes;
  if (!changes || typeof changes !== "object") return undefined;
  const fieldValue = (changes as Record<string, unknown>).field_value;
  if (!fieldValue || typeof fieldValue !== "object") return undefined;
  const fieldNodeId = (fieldValue as Record<string, unknown>).field_node_id;
  return typeof fieldNodeId === "string" ? fieldNodeId : undefined;
}

function linkedRepositoryResolver(sourceControl: IntegrationContext["storage"]["sourceControlOwner"]): LinkedRepositoryResolver {
  if (!sourceControl) throw new Error("GitHub Projects requires the canonical source-control owner");
  return {
    async resolveLinkedRepository(input) {
      const repository = await sourceControl.repositories.findByExternalId({
        orgId: input.orgId,
        externalId: String(input.repositoryDatabaseId),
      });
      if (!repository || repository.slug.toLowerCase() !== input.repositoryNameWithOwner.toLowerCase()) return null;
      const connections = await sourceControl.connections.list({
        orgId: input.orgId,
        factoryProjectId: input.factoryProjectId,
      });
      for (const connection of connections) {
        const links = await sourceControl.projectRepositories.list({ orgId: input.orgId, connectionId: connection.id });
        const linked = links.find(link => link.repositoryId === repository.id);
        if (linked) return { projectRepositoryId: linked.id };
      }
      return null;
    },
  };
}
