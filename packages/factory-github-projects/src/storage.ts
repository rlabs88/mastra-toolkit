import { FactoryStorageDomain, UniqueViolationError, type CollectionSchema } from "@mastra/core/storage";
import type { GithubProjectBindingConfig } from "./types.js";

const BINDINGS = "github_project_bindings";
const RECONCILES = "github_project_reconciles";
const EXECUTION_LEASES = "github_project_execution_leases";
const EXECUTIONS = "github_project_executions";
const SCHEDULER_LEASES = "github_project_scheduler_leases";
const DIAGNOSTICS = "github_project_diagnostics";

const SCHEMAS: CollectionSchema[] = [
  {
    name: BINDINGS,
    columns: {
      id: { type: "text", primaryKey: true }, org_id: { type: "text" }, factory_project_id: { type: "text" },
      github_project_node_id: { type: "text" }, config: { type: "json" }, enabled: { type: "boolean" },
      created_at: { type: "timestamp" }, updated_at: { type: "timestamp" },
    },
    uniqueIndexes: [
      { name: "github_project_bindings_factory_unique", columns: ["org_id", "factory_project_id"] },
      { name: "github_project_bindings_project_unique", columns: ["github_project_node_id"] },
    ],
  },
  {
    name: RECONCILES,
    columns: {
      id: { type: "uuid-pk" }, delivery_id: { type: "text" }, event: { type: "text" },
      project_item_node_id: { type: "text", nullable: true }, status: { type: "text" }, attempts: { type: "integer" },
      last_error: { type: "text", nullable: true }, created_at: { type: "timestamp" }, updated_at: { type: "timestamp" },
    },
    uniqueIndexes: [{ name: "github_project_reconciles_delivery_unique", columns: ["delivery_id"] }],
    indexes: [{ name: "github_project_reconciles_status_idx", columns: ["status"] }],
  },
  {
    name: EXECUTION_LEASES,
    columns: {
      id: { type: "uuid-pk" }, content_node_id: { type: "text" }, binding_id: { type: "text" },
      owner_id: { type: "text" }, expires_at: { type: "timestamp" }, created_at: { type: "timestamp" },
      updated_at: { type: "timestamp" },
    },
    uniqueIndexes: [{ name: "github_project_execution_content_unique", columns: ["content_node_id"] }],
  },
  {
    name: EXECUTIONS,
    columns: {
      id: { type: "uuid-pk" }, content_node_id: { type: "text" }, binding_id: { type: "text" },
      project_item_node_id: { type: "text" }, work_item_id: { type: "text" }, status: { type: "text" },
      created_at: { type: "timestamp" }, updated_at: { type: "timestamp" },
    },
    uniqueIndexes: [{ name: "github_project_executions_content_unique", columns: ["content_node_id"] }],
  },
  {
    name: SCHEDULER_LEASES,
    columns: {
      id: { type: "uuid-pk" }, scope: { type: "text" }, owner_id: { type: "text" },
      expires_at: { type: "timestamp" }, created_at: { type: "timestamp" }, updated_at: { type: "timestamp" },
    },
    uniqueIndexes: [{ name: "github_project_scheduler_scope_unique", columns: ["scope"] }],
  },
  {
    name: DIAGNOSTICS,
    columns: {
      id: { type: "text", primaryKey: true }, binding_id: { type: "text" }, content_node_id: { type: "text" },
      reason: { type: "text" }, created_at: { type: "timestamp" }, updated_at: { type: "timestamp" },
    },
    indexes: [{ name: "github_project_diagnostics_binding_idx", columns: ["binding_id"] }],
  },
];

interface BindingRow extends Record<string, unknown> {
  id: string; org_id: string; factory_project_id: string; github_project_node_id: string;
  config: GithubProjectBindingConfig; enabled: boolean; created_at: Date; updated_at: Date;
}
interface ReconcileRow extends Record<string, unknown> {
  id: string; delivery_id: string; event: string; project_item_node_id: string | null; status: string;
  attempts: number; last_error: string | null; created_at: Date; updated_at: Date;
}
interface LeaseRow extends Record<string, unknown> {
  id: string; content_node_id: string; binding_id: string; owner_id: string; expires_at: Date;
  created_at: Date; updated_at: Date;
}
interface ExecutionRow extends Record<string, unknown> {
  id: string; content_node_id: string; binding_id: string; project_item_node_id: string;
  work_item_id: string; status: string; created_at: Date; updated_at: Date;
}
interface SchedulerLeaseRow extends Record<string, unknown> {
  id: string; scope: string; owner_id: string; expires_at: Date; created_at: Date; updated_at: Date;
}
interface DiagnosticRow extends Record<string, unknown> {
  id: string; binding_id: string; content_node_id: string; reason: string; created_at: Date; updated_at: Date;
}

export class GithubProjectsStorage extends FactoryStorageDomain {
  constructor() { super("github-projects-v2"); }
  async init(): Promise<void> { await this.ensureCollections(SCHEMAS); }
  async dangerouslyClearAll(): Promise<void> {
    for (const collection of [EXECUTIONS, EXECUTION_LEASES, RECONCILES, BINDINGS, SCHEDULER_LEASES, DIAGNOSTICS]) {
      await this.ops.deleteMany(collection, {});
    }
  }

  async upsertBinding(config: GithubProjectBindingConfig): Promise<GithubProjectBindingConfig> {
    const now = new Date();
    const row = await this.ops.upsertOne<BindingRow>(BINDINGS, ["id"], {
      id: config.id, org_id: config.orgId, factory_project_id: config.factoryProjectId,
      github_project_node_id: config.githubProjectNodeId, config, enabled: config.enabled,
      created_at: now, updated_at: now,
    });
    return row.config;
  }
  async listBindings(): Promise<GithubProjectBindingConfig[]> {
    return (await this.ops.findMany<BindingRow>(BINDINGS, {}, { orderBy: [["id", "asc"]] })).map(row => row.config);
  }
  async deleteBinding(id: string): Promise<boolean> { return (await this.ops.deleteMany(BINDINGS, { id })) > 0; }

  async enqueueReconcile(input: { deliveryId: string; event: string; projectItemNodeId?: string }): Promise<{
    created: boolean; id: string;
  }> {
    const existing = await this.ops.findOne<ReconcileRow>(RECONCILES, { delivery_id: input.deliveryId });
    if (existing) return { created: false, id: existing.id };
    const now = new Date();
    try {
      const row = await this.ops.insertOne<ReconcileRow>(RECONCILES, {
        delivery_id: input.deliveryId, event: input.event,
        project_item_node_id: input.projectItemNodeId ?? null, status: "pending", attempts: 0,
        last_error: null, created_at: now, updated_at: now,
      });
      return { created: true, id: row.id };
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      const raced = await this.ops.findOne<ReconcileRow>(RECONCILES, { delivery_id: input.deliveryId });
      if (!raced) throw error;
      return { created: false, id: raced.id };
    }
  }
  async listPendingReconciles(): Promise<Array<{ id: string; deliveryId: string; event: string; projectItemNodeId: string | null }>> {
    return (await this.ops.findMany<ReconcileRow>(RECONCILES, { status: "pending" }, { orderBy: [["created_at", "asc"]] }))
      .map(row => ({ id: row.id, deliveryId: row.delivery_id, event: row.event, projectItemNodeId: row.project_item_node_id }));
  }
  async completeReconcile(id: string): Promise<void> {
    await this.ops.updateMany(RECONCILES, { id }, { status: "completed", updated_at: new Date() });
  }
  async failReconcile(id: string, error: unknown): Promise<void> {
    await this.ops.updateAtomic<ReconcileRow>(RECONCILES, { id }, row => ({
      status: "pending", attempts: row.attempts + 1,
      last_error: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
      updated_at: new Date(),
    }));
  }

  async acquireExecutionLease(input: {
    contentNodeId: string; bindingId: string; ownerId: string; ttlMs: number;
  }): Promise<boolean> {
    const now = new Date();
    const expires = new Date(now.getTime() + input.ttlMs);
    try {
      await this.ops.insertOne<LeaseRow>(EXECUTION_LEASES, {
        content_node_id: input.contentNodeId, binding_id: input.bindingId, owner_id: input.ownerId,
        expires_at: expires, created_at: now, updated_at: now,
      });
      return true;
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
    let acquired = false;
    await this.ops.updateAtomic<LeaseRow>(EXECUTION_LEASES, { content_node_id: input.contentNodeId }, row => {
      if (row.owner_id !== input.ownerId && row.expires_at.getTime() > now.getTime()) return null;
      acquired = true;
      return { binding_id: input.bindingId, owner_id: input.ownerId, expires_at: expires, updated_at: now };
    });
    return acquired;
  }
  async releaseExecutionLease(contentNodeId: string, bindingId: string): Promise<void> {
    await this.ops.deleteMany(EXECUTION_LEASES, { content_node_id: contentNodeId, binding_id: bindingId });
  }
  async acquireSchedulerLease(input: { scope: string; ownerId: string; ttlMs: number }): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    try {
      await this.ops.insertOne<SchedulerLeaseRow>(SCHEDULER_LEASES, {
        scope: input.scope, owner_id: input.ownerId, expires_at: expiresAt,
        created_at: now, updated_at: now,
      });
      return true;
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
    let acquired = false;
    await this.ops.updateAtomic<SchedulerLeaseRow>(SCHEDULER_LEASES, { scope: input.scope }, row => {
      if (row.owner_id !== input.ownerId && row.expires_at.getTime() > now.getTime()) return null;
      acquired = true;
      return { owner_id: input.ownerId, expires_at: expiresAt, updated_at: now };
    });
    return acquired;
  }
  async recordExecution(input: {
    contentNodeId: string; bindingId: string; projectItemNodeId: string; workItemId: string; status: string;
  }): Promise<void> {
    const now = new Date();
    await this.ops.upsertOne<ExecutionRow>(EXECUTIONS, ["content_node_id"], {
      content_node_id: input.contentNodeId, binding_id: input.bindingId,
      project_item_node_id: input.projectItemNodeId, work_item_id: input.workItemId,
      status: input.status, created_at: now, updated_at: now,
    });
  }
  async getExecution(contentNodeId: string): Promise<{
    contentNodeId: string; bindingId: string; projectItemNodeId: string; workItemId: string; status: string;
  } | null> {
    const row = await this.ops.findOne<ExecutionRow>(EXECUTIONS, { content_node_id: contentNodeId });
    return row ? {
      contentNodeId: row.content_node_id, bindingId: row.binding_id, projectItemNodeId: row.project_item_node_id,
      workItemId: row.work_item_id, status: row.status,
    } : null;
  }
  async listExecutions(): Promise<Array<{
    contentNodeId: string; bindingId: string; projectItemNodeId: string; workItemId: string; status: string;
  }>> {
    return (await this.ops.findMany<ExecutionRow>(EXECUTIONS, {}, { orderBy: [["created_at", "asc"]] })).map(row => ({
      contentNodeId: row.content_node_id,
      bindingId: row.binding_id,
      projectItemNodeId: row.project_item_node_id,
      workItemId: row.work_item_id,
      status: row.status,
    }));
  }
  async recordDiagnostic(input: { bindingId: string; contentNodeId: string; reason: string }): Promise<void> {
    const now = new Date();
    await this.ops.upsertOne<DiagnosticRow>(DIAGNOSTICS, ["id"], {
      id: `${input.bindingId}:${input.contentNodeId}:${input.reason}`,
      binding_id: input.bindingId,
      content_node_id: input.contentNodeId,
      reason: input.reason,
      created_at: now,
      updated_at: now,
    });
  }
  async listDiagnostics(bindingId?: string): Promise<Array<{
    bindingId: string; contentNodeId: string; reason: string; updatedAt: Date;
  }>> {
    const filter = bindingId ? { binding_id: bindingId } : {};
    return (await this.ops.findMany<DiagnosticRow>(DIAGNOSTICS, filter, { orderBy: [["updated_at", "desc"]] }))
      .map(row => ({
        bindingId: row.binding_id,
        contentNodeId: row.content_node_id,
        reason: row.reason,
        updatedAt: row.updated_at,
      }));
  }
}
