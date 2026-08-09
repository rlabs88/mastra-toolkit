import { describe, expect, test, vi } from "vitest";
import { createMcodeRuntimeDescriptorRoute } from "@rlabs/mcode";

describe("mz runtime descriptor", () => {
  test("identifies the mounted project and reports readiness without exposing secrets", async () => {
    const route = createMcodeRuntimeDescriptorRoute({
      runtimeId: "runtime-one",
      projectRoot: "/repo/project",
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc",
      observabilityEnabled: true,
      subagents: [{ id: "cortex", name: "Cortex", description: "Implementation" }],
      generation: () => 3,
    });
    const json = vi.fn((value: unknown) => value);
    if (!("handler" in route)) throw new Error("Expected an inline runtime descriptor handler");

    const result = await route.handler({ json } as never);

    expect(route).toMatchObject({ method: "GET", path: "/mz/runtime", requiresAuth: false });
    expect(result).toEqual({
      schemaVersion: 1,
      remoteTuiProtocolVersion: 1,
      remoteTuiCapabilities: {
        chat: true,
        threads: true,
        modes: true,
        models: true,
        goals: true,
        permissions: true,
        approvals: true,
        skills: true,
      },
      remoteTuiSubagents: [{ id: "cortex", name: "Cortex", description: "Implementation" }],
      runtimeId: "runtime-one",
      projectRoot: "/repo/project",
      controllerId: "mastra-code",
      resourceId: "project-resource",
      contractDigest: "sha256:abc",
      mounting: { ready: true, generation: 3 },
      observability: { enabled: true, export: "local-only" },
    });
    expect(JSON.stringify(result)).not.toMatch(/key|token|secret/i);
  });
});
