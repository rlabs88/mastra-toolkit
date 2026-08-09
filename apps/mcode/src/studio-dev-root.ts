import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

type PackageManifest = {
  readonly type?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly overrides?: Record<string, unknown>;
  readonly resolutions?: Record<string, unknown>;
  readonly pnpm?: Record<string, unknown>;
};

/**
 * Give Mastra's isolated `--root` the same dependency contract as the toolkit.
 * The dev server rewrites this root on every hot rebuild, so relying on the
 * launch process cwd or a previously generated manifest is not sufficient.
 */
export async function prepareManagedStudioDevRoot(toolkitRoot: string, devRoot: string): Promise<void> {
  const source = JSON.parse(await readFile(join(toolkitRoot, "package.json"), "utf8")) as PackageManifest;
  const portableDependencies = absolutizeFileDependencies(source.dependencies ?? {}, toolkitRoot);
  const portableDevDependencies = absolutizeFileDependencies(source.devDependencies ?? {}, toolkitRoot);
  const manifest = {
    name: "@rlabs/mz-managed-studio",
    version: "0.0.0",
    private: true,
    type: source.type ?? "module",
    dependencies: portableDependencies,
    devDependencies: portableDevDependencies,
    ...(source.overrides ? { overrides: source.overrides } : {}),
    ...(source.resolutions ? { resolutions: source.resolutions } : {}),
    ...(source.pnpm ? { pnpm: source.pnpm } : {}),
  };
  await mkdir(devRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(devRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await ensureToolkitNodeModules(toolkitRoot, devRoot);
}

async function ensureToolkitNodeModules(toolkitRoot: string, devRoot: string): Promise<void> {
  const target = join(toolkitRoot, "node_modules");
  const link = join(devRoot, "node_modules");
  try {
    const existing = await lstat(link);
    if (!existing.isSymbolicLink()) {
      throw new Error(`Managed Studio dependency path is not a symlink: ${link}`);
    }
    if (await readlink(link) === target) return;
    await unlink(link);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

function absolutizeFileDependencies(dependencies: Record<string, string>, toolkitRoot: string): Record<string, string> {
  return Object.fromEntries(Object.entries(dependencies).map(([name, spec]) => {
    if (!spec.startsWith("file:")) return [name, spec];
    const path = spec.slice("file:".length);
    return [name, `file:${isAbsolute(path) ? path : resolve(toolkitRoot, path)}`];
  }));
}
