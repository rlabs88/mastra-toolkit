import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const secretNames = [
  "PROXY_API_KEY",
  "CLI_PROXY_API_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_WEBHOOK_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
  "MASTRA_ENVIRONMENT_ID",
  "MASTRA_PROJECT_ID",
  "MASTRA_PLATFORM_SECRET_KEY",
] as const;

describe("local startup contracts", () => {
  test("applies the canonical Factory model after Infisical injection", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts["dev:factory:infisical"]).toBe(
      "node scripts/with-infisical.mjs env MASTRA_TOOLKIT_MODE=factory PROXY_MODEL=code-frontier-high npm run dev:factory",
    );
  });

  test("admits ephemeral local Factory development without WorkOS", async () => {
    const { stdout } = await runSecretCheck({
      MASTRA_TOOLKIT_MODE: "factory",
      FACTORY_PROJECT_RUNTIME_PROFILE: "ephemeral-development",
      CLI_PROXY_API_KEY: "test-only-key",
    });

    expect(stdout).toContain("ephemeral-development");
  });

  test("keeps persistent Factory deployment secret validation fail-closed", async () => {
    const check = runSecretCheck({
      MASTRA_TOOLKIT_MODE: "factory",
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operations",
      CLI_PROXY_API_KEY: "test-only-key",
    });

    await expect(check).rejects.toMatchObject({
      stderr: expect.stringMatching(/WORKOS_API_KEY.*DATABASE_URL.*MASTRA_PLATFORM_SECRET_KEY/s),
    });
    await expect(check).rejects.not.toMatchObject({
      stderr: expect.stringMatching(/GITHUB_APP_/),
    });
  });

  test("rejects unknown Factory runtime profiles instead of treating them as local", async () => {
    await expect(runSecretCheck({
      MASTRA_TOOLKIT_MODE: "factory",
      FACTORY_PROJECT_RUNTIME_PROFILE: "persistent-operation",
      CLI_PROXY_API_KEY: "test-only-key",
    })).rejects.toMatchObject({
      stderr: expect.stringMatching(/FACTORY_PROJECT_RUNTIME_PROFILE|Invalid option/),
    });
  });
});

async function runSecretCheck(overrides: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const environment = { ...process.env };
  for (const name of secretNames) delete environment[name];
  return execFileAsync(process.execPath, ["scripts/check-env.mjs"], {
    cwd: root,
    env: { ...environment, ...overrides },
  });
}
