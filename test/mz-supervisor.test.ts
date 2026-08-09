import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { terminateChildProcessTree, waitForChildExit } from "../apps/mcode/src/process-supervision.js";
import { prepareManagedStudioDevRoot } from "../apps/mcode/src/studio-dev-root.js";

describe("mz Studio child supervision", () => {
  test("projects the toolkit dependency graph into the isolated hot-reload root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-dev-root-"));
    const toolkitRoot = join(root, "toolkit");
    const devRoot = join(root, "dev-root");
    await mkdir(join(toolkitRoot, "vendor"), { recursive: true });
    await mkdir(join(toolkitRoot, "node_modules"), { recursive: true });
    await writeFile(join(toolkitRoot, "vendor", "core.tgz"), "artifact", "utf8");
    await writeFile(join(toolkitRoot, "package.json"), JSON.stringify({
      name: "toolkit",
      type: "module",
      dependencies: { "@mastra/core": "file:vendor/core.tgz", zod: "4.4.3" },
      devDependencies: { mastra: "1.23.0" },
      overrides: { "@mastra/core": "$@mastra/core" },
    }), "utf8");

    await prepareManagedStudioDevRoot(toolkitRoot, devRoot);

    const manifest = JSON.parse(await readFile(join(devRoot, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      private: true,
      type: "module",
      dependencies: { zod: "4.4.3" },
      devDependencies: { mastra: "1.23.0" },
      overrides: { "@mastra/core": "$@mastra/core" },
    });
    expect(manifest.dependencies["@mastra/core"]).toBe(`file:${join(toolkitRoot, "vendor", "core.tgz")}`);
    expect((await lstat(join(devRoot, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(devRoot, "node_modules"))).toBe(join(toolkitRoot, "node_modules"));
  });

  test("escalates from TERM to KILL when the managed process group ignores TERM", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once("error", rejectReady);
      child.stdout!.once("data", () => resolveReady());
    });
    const exit = waitForChildExit(child);

    const outcome = await terminateChildProcessTree(child, exit, { termGraceMs: 25, killGraceMs: 1_000 });

    expect(outcome.signal).toBe("SIGKILL");
  });
});
