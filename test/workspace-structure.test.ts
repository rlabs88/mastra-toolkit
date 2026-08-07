import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  "mastra-primitives-export",
  "mcode",
  "factory-integration",
] as const;

describe("workspace ownership", () => {
  test("pins one coherent stable Mastra release set across every runtime manifest", async () => {
    const expected = {
      "@mastra/factory": "0.5.0",
      "@mastra/code-sdk": "1.1.3",
      "mastracode": "0.32.6",
      "@mastra/core": "1.57.0",
      "mastra": "1.23.0",
      "@mastra/libsql": "1.19.0",
      "@mastra/pg": "1.19.0",
      "@mastra/memory": "1.26.0",
    } as const;
    const manifestPaths = [
      "package.json",
      ...packageNames.map(name => `packages/${name}/package.json`),
      "apps/factory/package.json",
      "apps/mcode/package.json",
      "apps/studio/package.json",
      "deployment/mcode-sandbox/runtime/package.json",
    ];
    const requiredByManifest: Record<string, readonly (keyof typeof expected)[]> = {
      "package.json": Object.keys(expected) as (keyof typeof expected)[],
      "packages/agent-tools/package.json": ["@mastra/core"],
      "packages/agents-roles/package.json": ["@mastra/core"],
      "packages/factory-integration/package.json": [
        "@mastra/factory",
        "@mastra/code-sdk",
        "@mastra/core",
        "@mastra/libsql",
        "@mastra/pg",
      ],
      "packages/mcode/package.json": ["@mastra/code-sdk", "@mastra/core", "mastracode"],
      "packages/project-mounting-manager/package.json": ["@mastra/core"],
      "packages/runtime-config/package.json": ["@mastra/core"],
      "packages/sandbox/package.json": ["@mastra/core"],
      "apps/studio/package.json": ["@mastra/core"],
      "deployment/mcode-sandbox/runtime/package.json": ["@mastra/core"],
    };

    for (const manifestPath of manifestPaths) {
      const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const name of requiredByManifest[manifestPath] ?? []) {
        expect(dependencies[name], `${manifestPath}: ${name}`).toBe(expected[name]);
      }
    }
  });

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

  test("uses the approved deep-module source layout", async () => {
    const expectedSources: Record<(typeof packageNames)[number], readonly string[]> = {
      "runtime-config": ["environment.ts", "gateway.ts", "index.ts", "profile.ts"],
      "agent-tools": ["capabilities.ts", "command-run-contract.ts", "command-run.ts", "index.ts"],
      "agents-roles": ["agents.ts", "index.ts", "prompts.ts", "roles.ts"],
      "sandbox": ["command-run.ts", "contract.ts", "index.ts", "machine.ts", "providers.ts"],
      "project-mounting-manager": ["contract.ts", "discovery.ts", "index.ts", "manager.ts"],
      "mastra-primitives-export": ["index.ts", "primitives.ts"],
      "mcode": ["index.ts", "project.ts", "recipe.ts", "runtime.ts"],
      "factory-integration": ["config.ts", "index.ts", "integration.ts", "runtime.ts"],
    };

    for (const packageName of packageNames) {
      expect(await relativeTypeScriptFiles(join(root, "packages", packageName, "src")), packageName)
        .toEqual(expectedSources[packageName]);
    }
  });

  test("exports TypeScript only through package roots", async () => {
    for (const packageName of packageNames) {
      const manifest = JSON.parse(
        await readFile(join(root, "packages", packageName, "package.json"), "utf8"),
      ) as { exports?: Record<string, string> };
      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        if (target.endsWith(".ts")) expect(subpath, packageName).toBe(".");
      }
    }
  });

  test("keeps applications behind one RLabs host facade", async () => {
    const expected = {
      factory: "@rlabs/factory-integration",
      mcode: "@rlabs/mcode",
      studio: "@rlabs/mcode",
    } as const;
    for (const [app, facade] of Object.entries(expected)) {
      const manifest = JSON.parse(await readFile(join(root, "apps", app, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const rlabsDependencies = Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith("@rlabs/"));
      expect(rlabsDependencies, app).toEqual([facade]);
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
    await expectSourceToExclude("packages/mastra-primitives-export/src", [
      "@mastra/code-sdk",
      "@mastra/factory",
      "@rlabs/mcode",
      "@rlabs/factory-integration",
    ]);
    await expectSourceToExclude("packages/mcode/src", ["createToolkitAgents"]);
    await expectSourceToExclude("packages/factory-integration/src", ["createToolkitAgents"]);
  });

  test("keeps Factory lifecycle behind its host facade", async () => {
    const source = await readFile(join(root, "apps/factory/src/index.ts"), "utf8");

    expect(source).toContain("createFactoryRuntime");
    expect(source).toContain("contract, projection, factory, mastra");
    expect(source).toContain('process.once("SIGINT"');
    expect(source).toContain('process.once("SIGTERM"');
    expect(source).toContain("runtime.close()");
  });

  test("keeps Studio policy behind MCode while preserving the deployer-required constructor seam", async () => {
    const manifest = JSON.parse(await readFile(join(root, "apps/studio/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const source = await readFile(join(root, "apps/studio/src/index.ts"), "utf8");

    expect(manifest.dependencies).toEqual({ "@mastra/core": "1.57.0", "@rlabs/mcode": "*" });
    expect(source).toContain("prepareMcodeRuntime");
    expect(source).toContain("localProject.contract");
    expect(source).toContain("localProject.projection");
    expect(source).toContain("export const mastra = new Mastra(localProject.mastraArgs)");
  });

  test("keeps inactive deployment targets documentation-only", async () => {
    const entries = await readdir(join(root, "deployment", "studio-server"));
    expect(entries.sort()).toEqual(["AGENTS.md", "CONTEXT.md"]);
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

    const dataDirectory = await mkdtemp(join(tmpdir(), "mcode-shim-test-"));
    try {
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
              disableMcp: true,
              environment: { ...process.env, CLI_PROXY_API_KEY: "test-only-key" },
            });
            await runtime.close();
            console.log("mcode-load-ok");
          `,
        ],
        {
          cwd: root,
          env: { ...process.env, MASTRA_APP_DATA_DIR: dataDirectory },
          timeout: 60_000,
        },
      );
      expect(stdout).toContain("mcode-load-ok");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  test("keeps Factory on bundle-safe root workspace package boundaries", async () => {
    const factorySources = [
      await readTypeScriptTree(join(root, "apps/factory/src")),
      await readTypeScriptTree(join(root, "packages/factory-integration/src")),
      await readTypeScriptTree(join(root, "packages/sandbox/src")),
    ].join("\n");

    expect(factorySources).not.toContain('from "@rlabs/mcode"');
    expect(factorySources).not.toMatch(/from "@rlabs\/[^"/]+\//);
  });

  test("packs every canonical MCode recipe source", async () => {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--workspace", "@rlabs/mcode", "--dry-run", "--json"],
      { cwd: root, env: process.env, timeout: 60_000 },
    );
    const artifacts = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = artifacts[0]?.files.map(file => file.path) ?? [];

    expect(paths.filter(path => path.startsWith("src/") && path.endsWith(".ts")).sort()).toEqual([
      "src/index.ts",
      "src/project.ts",
      "src/recipe.ts",
      "src/runtime.ts",
    ]);
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

async function relativeTypeScriptFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await relativeTypeScriptFiles(join(directory, entry.name), relative));
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative);
  }
  return files.sort();
}
