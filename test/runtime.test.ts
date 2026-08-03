import { describe, expect, test } from "vitest";
import { createStandaloneRuntime } from "../src/runtime/standalone.js";
import { loadToolkitConfig } from "../src/config.js";

describe("standalone runtime", () => {
  test("exposes the three toolkit agents and proxy gateway", () => {
    const runtime = createStandaloneRuntime(loadToolkitConfig({ WORKSPACE_ROOT: process.cwd() }), { browser: false });

    expect(runtime.getAgent("cortex").id).toBe("cortex");
    expect(runtime.getAgent("flux").id).toBe("flux");
    expect(runtime.getAgent("zen").id).toBe("zen");
    expect(runtime.getGateway("proxy").id).toBe("proxy");
  });
});
