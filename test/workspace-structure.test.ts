import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const root = process.cwd();
const packageNames = [
  "runtime-config",
  "agent-tools",
  "agents-roles",
  "sandbox",
  "project-mounting-manager",
  "mcode",
  "factory-integration",
] as const;

describe("workspace ownership", () => {
  test("declares the approved applications and packages", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      workspaces?: string[];
    };

    expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
    await expectPackageNames("packages", packageNames.map(name => `@rlabs/${name}`));
    await expectPackageNames("apps", ["@rlabs/mcode-app", "@rlabs/studio-app", "@rlabs/factory-app"]);
  });

  test("keeps each approved ownership boundary discoverable", async () => {
    const checkpointRoots = [
      "apps",
      ...packageNames.map(name => `packages/${name}`),
      "deployment/mcode-sandbox",
      "deployment/studio-server",
    ];

    for (const checkpointRoot of checkpointRoots) {
      await expect(readFile(join(root, checkpointRoot, "AGENTS.md"), "utf8")).resolves.toContain("kind: agent-instructions");
      await expect(readFile(join(root, checkpointRoot, "CONTEXT.md"), "utf8")).resolves.toContain("kind: checkpoint-context");
    }
  });

  test("stores each canonical role in its own TypeScript module", async () => {
    for (const role of ["cortex", "flux", "zen"] as const) {
      await expect(readFile(join(root, "packages/agents-roles/src", role, "prompt.ts"), "utf8")).resolves.toBeTruthy();
      await expect(readFile(join(root, "packages/agents-roles/src", role, "role.ts"), "utf8")).resolves.toBeTruthy();
    }
  });

  test("keeps host-specific dependencies out of host-neutral packages", async () => {
    await expectSourceToExclude("packages/project-mounting-manager/src", [
      "@mastra/code-sdk",
      "@mastra/factory",
      "mastracode/tui",
    ]);
    await expectSourceToExclude("packages/agent-tools/src", [
      "@mastra/code-sdk",
      "@mastra/factory",
      "@rlabs/agents-roles",
    ]);
    await expectSourceToExclude("packages/runtime-config/src", [
      "@mastra/code-sdk",
      "@mastra/factory",
      "@rlabs/sandbox",
    ]);
  });

  test("keeps canonical Factory agents behind the sandbox-bound integration", async () => {
    const source = await readFile(join(root, "apps/factory/src/index.ts"), "utf8");

    expect(source).toContain("createToolkitFactory(config, agents)");
    expect(source).not.toContain("...agents");
  });

  test("keeps deployment targets documentation-only", async () => {
    for (const target of ["mcode-sandbox", "studio-server"]) {
      const entries = await readdir(join(root, "deployment", target));
      expect(entries.sort()).toEqual(["AGENTS.md", "CONTEXT.md"]);
    }
  });

  test("does not retain legacy root boundaries", async () => {
    for (const staleEntry of ["src", "config", "docker", ".pi", ".dockerignore", "compose.yml"]) {
      await expect(access(join(root, staleEntry))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const tsconfig = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8")) as {
      include?: string[];
    };
    expect(tsconfig.include).not.toContain("src/**/*.ts");
  });

  test("mcode bin is a tsx-backed shim that can load @rlabs/mcode", async () => {
    const manifest = JSON.parse(await readFile(join(root, "apps/mcode/package.json"), "utf8")) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.bin).toEqual({ mcode: "./bin/mcode.mjs" });
    expect(manifest.dependencies?.tsx).toBe("4.20.6");

    const shim = await readFile(join(root, "apps/mcode/bin/mcode.mjs"), "utf8");
    expect(shim).toContain("tsx/esm/api");
    expect(shim).toContain("../src/cli.ts");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { register } from "tsx/esm/api";
          register();
          const { createLocalMcodeRuntime } = await import("@rlabs/mcode");
          const runtime = await createLocalMcodeRuntime({
            browser: false,
            watch: false,
            environment: { ...process.env, CLI_PROXY_API_KEY: "test-only-key" },
          });
          await runtime.close();
          console.log("mcode-load-ok");
        `,
      ],
      { cwd: root, env: process.env, timeout: 60_000 },
    );
    expect(stdout).toContain("mcode-load-ok");
  }, 60_000);
});

async function expectPackageNames(folder: string, expected: readonly string[]): Promise<void> {
  const names: string[] = [];
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(await readFile(join(root, folder, entry.name, "package.json"), "utf8")) as { name: string };
    names.push(manifest.name);
  }
  expect(names.sort()).toEqual([...expected].sort());
}

async function expectSourceToExclude(directory: string, forbidden: readonly string[]): Promise<void> {
  const contents = await readTypeScriptTree(join(root, directory));
  for (const dependency of forbidden) expect(contents).not.toContain(dependency);
}

async function readTypeScriptTree(directory: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await readTypeScriptTree(path));
    if (entry.isFile() && entry.name.endsWith(".ts")) chunks.push(await readFile(path, "utf8"));
  }
  return chunks.join("\n");
}
