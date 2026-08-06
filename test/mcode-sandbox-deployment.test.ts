import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveSandboxRuntimeProfile, type SandboxRuntimeProfileName } from "@rlabs/sandbox";

const deploymentRoot = resolve("deployment/mcode-sandbox");

describe("MCode sandbox deployment source", () => {
  test("builds both Factory runtime profiles from immutable ARM64 base images", async () => {
    const dockerfile = await readFile(resolve(deploymentRoot, "Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/ARG AES_IMAGE=ghcr\.io\/rlabs88\/toolkit\/aes-sandbox@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toMatch(/ARG OPS_IMAGE=ghcr\.io\/rlabs88\/toolkit\/ops-sandbox@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toContain("AS ephemeral-development");
    expect(dockerfile).toContain("AS persistent-operations");
    expect(dockerfile).toContain('TARGETARCH" = arm64');
  });

  test("installs the exact Mastra workflow runtime used by Factory", async () => {
    const [manifest, lock, rootManifest] = await Promise.all([
      readFile(resolve(deploymentRoot, "runtime/package.json"), "utf8").then(JSON.parse),
      readFile(resolve(deploymentRoot, "runtime/package-lock.json"), "utf8").then(JSON.parse),
      readFile(resolve("package.json"), "utf8").then(JSON.parse),
    ]) as [{
      dependencies: Record<string, string>;
    }, {
      packages: { "": { dependencies: Record<string, string> } };
    }, {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }];

    expect(manifest.dependencies).toEqual({
      "@mastra/core": rootManifest.dependencies["@mastra/core"],
      esbuild: rootManifest.dependencies.esbuild,
      tsx: rootManifest.devDependencies.tsx,
      zod: rootManifest.dependencies.zod,
    });
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
  });

  test("copies one locked MCode runtime layer and probe into both image targets", async () => {
    const dockerfile = await readFile(resolve(deploymentRoot, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund");
    expect(dockerfile).toContain("packages/sandbox/config/runtime-profiles.json");
    expect(dockerfile.match(/COPY --from=mcode-runtime-build \/opt\/mastra-toolkit\/mcode-runtime/g)).toHaveLength(2);
    expect(dockerfile.match(/COPY --from=mcode-runtime-build \/usr\/local\/bin\/mastra-toolkit-runtime-probe/g)).toHaveLength(2);
  });

  test("restores the pinned AES admission ABI over the persistent operations overlay", async () => {
    const dockerfile = await readFile(resolve(deploymentRoot, "Dockerfile"), "utf8");
    const persistentTarget = dockerfile.slice(dockerfile.indexOf("FROM ${OPS_IMAGE} AS persistent-operations"));

    expect(dockerfile).toContain("FROM ${AES_IMAGE} AS sandbox-admission-runtime");
    expect(persistentTarget).toContain(
      "COPY --from=sandbox-admission-runtime /usr/local/bin/sandbox-entrypoint /usr/local/bin/sandbox-entrypoint",
    );
    expect(persistentTarget).toContain(
      "COPY --from=sandbox-admission-runtime /opt/agent-sandbox/cortex/provisioning.ts /opt/agent-sandbox/cortex/provisioning.ts",
    );
  });

  test("binds each image target to the only runtime profile its probe may admit", async () => {
    const [dockerfile, probe, profiles] = await Promise.all([
      readFile(resolve(deploymentRoot, "Dockerfile"), "utf8"),
      readFile(resolve(deploymentRoot, "runtime-probe.sh"), "utf8"),
      readFile(resolve("packages/sandbox/config/runtime-profiles.json"), "utf8").then(JSON.parse),
    ]);

    expect(dockerfile).toContain("/etc/mastra-toolkit/runtime-profile");
    expect(profiles).toEqual(Object.fromEntries(
      (Object.keys(profiles) as SandboxRuntimeProfileName[])
        .map(profile => [profile, resolveSandboxRuntimeProfile(profile)]),
    ));
    expect(probe).toContain('installed_profile="$(cat "$probe_root/etc/mastra-toolkit/runtime-profile")"');
    expect(probe).toContain('[[ "$installed_profile" == "$profile" ]]');
    expect(probe).toContain("MASTRA_TOOLKIT_RUNTIME_IMAGE");
  });

  test("probes every canonical ephemeral development package layer", async () => {
    const probe = await readFile(resolve(deploymentRoot, "runtime-probe.sh"), "utf8");

    expect(probe).toContain("profile.packageLayers");
    expect(probe).toContain("command -v rg");
    expect(probe).toContain("globSync");
    expect(probe).toContain("@mastra/core/workflows");
  });

  test.each([
    "IMAGE_PUBLISHING_TOKEN",
    "GHCR_PACKAGE_TOKEN",
    "MASTRA_PLATFORM_SECRET_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_WEBHOOK_SECRET",
    "WORKOS_API_KEY",
    "WORKOS_CLIENT_ID",
    "WORKOS_COOKIE_PASSWORD",
    "DATABASE_URL",
    "REDIS_URL",
    "INFISICAL_TOKEN",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  ])("behaviorally rejects ambient control-plane credential %s through the runtime probe", async forbidden => {
    const probeRoot = await createProbeRoot();
    try {
      const result = spawnSync("bash", [
        resolve(deploymentRoot, "runtime-probe.sh"),
        "ephemeral-development",
        "",
        probeRoot,
      ], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, [forbidden]: "must-not-be-ambient" },
      });

      expect(result.status, result.stderr).toBe(77);
      expect(result.stderr).toContain(forbidden);
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  });

  test("behaviorally rejects a stale reattached image identity through the runtime probe", async () => {
    const probeRoot = await createProbeRoot();
    try {
      const result = spawnSync("bash", [
        resolve(deploymentRoot, "runtime-probe.sh"),
        "ephemeral-development",
        "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        probeRoot,
      ], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          MASTRA_TOOLKIT_RUNTIME_IMAGE: "ghcr.io/rlabs88/toolkit/mcode-sandbox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      });

      expect(result.status, result.stderr).toBe(67);
      expect(result.stderr).toMatch(/image identity mismatch/i);
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  });

  test("validates the exact ARM64 image with bounded cleanup and a real Mastra workflow", async () => {
    const verifier = await readFile(resolve(deploymentRoot, "verify-image.sh"), "utf8");

    expect(verifier).toContain("trap cleanup EXIT");
    expect(verifier).toContain("mastra-toolkit-runtime-probe");
    expect(verifier).toContain("createWorkflow");
    expect(verifier).toContain("void (async () =>");
    expect(verifier).toContain("linux/arm64");
    expect(verifier).toContain('"$image" probe');
    expect(verifier).toContain('"$image" serve');
    expect(verifier).toContain("org.opencontainers.image.revision");
  });

  test("provides a native ARM64 build-and-verify path without publishing", async () => {
    const build = await readFile(resolve(deploymentRoot, "build-validate.sh"), "utf8");

    expect(build).toContain("--platform linux/arm64");
    expect(build).toContain("docker info --format");
    expect(build).toContain("aarch64|arm64");
    expect(build).toContain('jq -r \'keys[]\' "$profile_manifest"');
    expect(build).toContain('--target "$profile"');
    expect(build).toContain('verify-image.sh" "$image" "$profile" "$source_revision"');
    expect(build).toContain("status --porcelain --untracked-files=all");
    expect(build).not.toContain("docker push");
  });

  test("keeps build context credentials out and records image provenance", async () => {
    const [dockerfile, dockerignore] = await Promise.all([
      readFile(resolve(deploymentRoot, "Dockerfile"), "utf8"),
      readFile(resolve(deploymentRoot, "Dockerfile.dockerignore"), "utf8"),
    ]);

    expect(dockerfile).toContain('org.opencontainers.image.source="https://github.com/rlabs88/mastra-toolkit"');
    expect(dockerfile).toContain("org.opencontainers.image.revision");
    expect(dockerfile).not.toContain("SOURCE_REVISION=unknown");
    expect(dockerfile).not.toMatch(/ARG .*?(TOKEN|KEY|SECRET|PASSWORD)/i);
    expect(dockerignore).toContain(".env");
    expect(dockerignore).toContain("*.pem");
  });
});

async function createProbeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcode-runtime-probe-"));
  const configDirectory = join(root, "etc/mastra-toolkit");
  const libraryDirectory = join(root, "usr/local/lib/mastra-toolkit");
  await Promise.all([
    mkdir(configDirectory, { recursive: true }),
    mkdir(libraryDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(configDirectory, "runtime-profile"), "ephemeral-development\n"),
    cp(resolve("packages/sandbox/config/runtime-profiles.json"), join(configDirectory, "runtime-profiles.json")),
    cp(resolve(deploymentRoot, "credential-guard.sh"), join(libraryDirectory, "credential-guard.sh")),
  ]);
  return root;
}
