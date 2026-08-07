import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibSQLFactoryStorage } from "@mastra/libsql";
import { afterEach, describe, expect, test } from "vitest";
import { GithubProjectsStorage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function open(url: string) {
  const storage = new LibSQLFactoryStorage({ id: `projects-${roots.length}`, url });
  const projects = storage.registerDomain(new GithubProjectsStorage());
  await storage.init();
  return { storage, projects };
}

describe("GithubProjectsStorage", () => {
  test("deduplicates webhook delivery and preserves requests across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "projects-v2-"));
    roots.push(root);
    const url = `file:${join(root, "factory.db")}`;
    const first = await open(url);
    await expect(first.projects.enqueueReconcile({
      deliveryId: "delivery-1", event: "projects_v2_item", projectItemNodeId: "PVTI_1",
    })).resolves.toMatchObject({ created: true });
    await expect(first.projects.enqueueReconcile({
      deliveryId: "delivery-1", event: "projects_v2_item", projectItemNodeId: "PVTI_1",
    })).resolves.toMatchObject({ created: false });
    await first.storage.close();

    const restarted = await open(url);
    await expect(restarted.projects.listPendingReconciles()).resolves.toHaveLength(1);
    await restarted.storage.close();
  });

  test("enforces one execution owner per global content node across Projects", async () => {
    const store = await open(":memory:");
    await expect(store.projects.acquireExecutionLease({
      contentNodeId: "I_same", bindingId: "binding-a", ownerId: "worker-a", ttlMs: 60_000,
    })).resolves.toBe(true);
    await expect(store.projects.acquireExecutionLease({
      contentNodeId: "I_same", bindingId: "binding-b", ownerId: "worker-b", ttlMs: 60_000,
    })).resolves.toBe(false);
    await expect(store.projects.acquireExecutionLease({
      contentNodeId: "I_same", bindingId: "binding-a", ownerId: "worker-b", ttlMs: 60_000,
    })).resolves.toBe(false);
    await expect(store.projects.acquireExecutionLease({
      contentNodeId: "I_same", bindingId: "binding-a", ownerId: "worker-a", ttlMs: 60_000,
    })).resolves.toBe(true);
    await store.storage.close();
  });

  test("elects one reconciliation scheduler across replicas and allows renewal by its owner", async () => {
    const store = await open(":memory:");

    await expect(store.projects.acquireSchedulerLease({
      scope: "reconcile", ownerId: "replica-a", ttlMs: 60_000,
    })).resolves.toBe(true);
    await expect(store.projects.acquireSchedulerLease({
      scope: "reconcile", ownerId: "replica-b", ttlMs: 60_000,
    })).resolves.toBe(false);
    await expect(store.projects.acquireSchedulerLease({
      scope: "reconcile", ownerId: "replica-a", ttlMs: 60_000,
    })).resolves.toBe(true);

    await store.storage.close();
  });

  test("preserves one execution owner across independent storage replicas and restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "projects-v2-replicas-"));
    roots.push(root);
    const url = `file:${join(root, "factory.db")}`;
    const first = await open(url);
    const second = await open(url);

    const acquisitions = await Promise.all([
      first.projects.acquireExecutionLease({
        contentNodeId: "I_shared", bindingId: "binding-a", ownerId: "replica-a", ttlMs: 60_000,
      }),
      second.projects.acquireExecutionLease({
        contentNodeId: "I_shared", bindingId: "binding-b", ownerId: "replica-b", ttlMs: 60_000,
      }),
    ]);
    expect(acquisitions.filter(Boolean)).toHaveLength(1);
    await first.storage.close();
    await second.storage.close();

    const restarted = await open(url);
    await expect(restarted.projects.acquireExecutionLease({
      contentNodeId: "I_shared", bindingId: "binding-c", ownerId: "replica-c", ttlMs: 60_000,
    })).resolves.toBe(false);
    await restarted.storage.close();
  });
});
