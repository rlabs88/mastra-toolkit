import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { CODE_MODE_IDS } from "@rlabs/mcode";
import {
  createLocalMcodeRuntime,
  type LocalMcodeRuntime,
} from "@rlabs/mcode";

const execFileAsync = promisify(execFile);
const openRuntimes: LocalMcodeRuntime[] = [];

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map(runtime => runtime.close()));
});

describe("local Mastra Code runtime", () => {
  test("boots the canonical agents and modes at the containing Git checkout", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mastra-code-project-"));
    const nestedCwd = join(projectRoot, "packages", "app");
    const dataDirectory = await mkdtemp(join(tmpdir(), "mastra-code-data-"));
    await execFileAsync("git", ["init", "--quiet", projectRoot]);
    await mkdir(nestedCwd, { recursive: true });

    const runtime = await createLocalMcodeRuntime({
      cwd: nestedCwd,
      dataDirectory,
      browser: false,
      watch: false,
      environment: {
        ...process.env,
        CLI_PROXY_API_KEY: "test-only-key",
      },
    });
    openRuntimes.push(runtime);

    expect(runtime.project.rootPath).toBe(await realpath(projectRoot));
    expect(runtime.controller.getMastra()).toBe(runtime.mastra);
    expect(runtime.controller.listModes().map(mode => mode.id)).toEqual(CODE_MODE_IDS);
    expect(runtime.session.mode.get()).toBe("cortex/build");
    expect(runtime.session.state.get()).toMatchObject({
      observationThreshold: 60_000,
      reflectionThreshold: 60_000,
    });
    expect(runtime.mastra.getAgent("cortex").id).toBe(runtime.agents.cortex.id);
    expect(runtime.mastra.getAgent("flux").id).toBe(runtime.agents.flux.id);
    expect(runtime.mastra.getAgent("zen").id).toBe(runtime.agents.zen.id);
    expect(runtime.controller.getCurrentAgent(runtime.session)).toBe(runtime.agents.cortex);
    expect(runtime.resources.snapshot().id).toBe(1);
  });
});
