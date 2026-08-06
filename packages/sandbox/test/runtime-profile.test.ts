import { describe, expect, test } from "vitest";
import { resolveSandboxRuntimeProfile } from "../src/index.js";

describe("sandbox runtime profiles", () => {
  test("selects the shared development layers with task-scoped credentials", () => {
    expect(resolveSandboxRuntimeProfile("ephemeral-development")).toEqual({
      profile: "ephemeral-development",
      lifecycle: "ephemeral",
      packageLayers: ["mcode-runtime", "project-development"],
      credentials: "task-scoped",
    });
  });

  test("adds operations only through the approved persistent secret source", () => {
    expect(resolveSandboxRuntimeProfile("persistent-operations")).toEqual({
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
    });
  });
});
