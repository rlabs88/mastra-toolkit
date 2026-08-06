import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadRuntimeConfig,
  prepareHostDataDirectory,
  resolveHostDataPaths,
} from "../src/index.js";

describe("loadRuntimeConfig", () => {
  test("uses standalone A1 proxy defaults without resolving a secret", () => {
    const config = loadRuntimeConfig({});

    expect(config).toEqual({
      mode: "standalone",
      proxy: {
        baseUrl: "https://aa.renaissancelab.org/v1",
        model: "code-frontier-high",
      },
    });
  });

  test("normalizes explicit host settings and prefers PROXY_API_KEY", () => {
    const config = loadRuntimeConfig({
      MASTRA_TOOLKIT_MODE: "factory",
      PROXY_BASE_URL: "https://proxy.example.test/v1///",
      PROXY_API_KEY: "host-key",
      CLI_PROXY_API_KEY: "profile-key",
      PROXY_MODEL: "code-workhorse-high",
    });

    expect(config).toEqual({
      mode: "factory",
      proxy: {
        baseUrl: "https://proxy.example.test/v1",
        apiKey: "host-key",
        model: "code-workhorse-high",
      },
    });
  });

  test("rejects a model outside the package catalog", () => {
    expect(() => loadRuntimeConfig({ PROXY_MODEL: "gpt-5.6-sol" })).toThrow(/unknown model alias/i);
  });
});

describe("host data", () => {
  test("isolates MCode, Studio, and Factory below one toolkit root", () => {
    const home = "/users/example";

    expect(resolveHostDataPaths("mcode", {}, home)).toMatchObject({
      directory: "/users/example/.mastra-toolkit/mcode",
      databasePath: "/users/example/.mastra-toolkit/mcode/mastra.db",
    });
    expect(resolveHostDataPaths("studio", {}, home)).toMatchObject({
      directory: "/users/example/.mastra-toolkit/studio",
      databasePath: "/users/example/.mastra-toolkit/studio/mastra.db",
    });
    expect(resolveHostDataPaths("factory", {}, home)).toMatchObject({
      directory: "/users/example/.mastra-toolkit/factory",
      databasePath: "/users/example/.mastra-toolkit/factory/factory.db",
    });
  });

  test("treats MASTRA_APP_DATA_DIR as an exact host directory override", () => {
    expect(resolveHostDataPaths("factory", { MASTRA_APP_DATA_DIR: "/runtime/factory" }, "/ignored"))
      .toMatchObject({ directory: "/runtime/factory", databasePath: "/runtime/factory/factory.db" });
  });

  test("moves a legacy database family once and rejects an ambiguous destination", async () => {
    const home = await mkdtemp(join(tmpdir(), "mastra-toolkit-data-"));
    const legacy = join(home, ".mastra-toolkit", "data");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "factory.db"), "database");
    await writeFile(join(legacy, "factory.db-wal"), "wal");

    const prepared = await prepareHostDataDirectory("factory", {}, home);
    await expect(readFile(prepared.databasePath, "utf8")).resolves.toBe("database");
    await expect(readFile(`${prepared.databasePath}-wal`, "utf8")).resolves.toBe("wal");

    await writeFile(join(legacy, "factory.db"), "conflict");
    await expect(prepareHostDataDirectory("factory", {}, home)).rejects.toThrow(/both contain local data/i);
  });
});
