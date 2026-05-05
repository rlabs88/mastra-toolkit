import os from "node:os";
import path from "node:path";

function expandTilde(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export function resolveConfiguredPath(inputPath: string, baseDir = process.cwd()): string {
  const expandedPath = expandTilde(inputPath.trim());
  return path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(baseDir, expandedPath);
}

export const workspaceRoot = resolveConfiguredPath(
  process.env.MASTRA_WORKSPACE_ROOT ?? path.resolve(process.cwd(), "../.."),
);

export const workspaceCommandCwd = resolveConfiguredPath(
  process.env.MASTRA_WORKSPACE_COMMAND_CWD ?? process.cwd(),
);

function splitPathList(value: string | undefined): string[] {
  if (value === undefined || value === "") {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function compactAccessRoots(roots: string[]): string[] {
  const dedupedRoots: string[] = [];

  for (const root of roots.map((entry) => resolveConfiguredPath(entry))) {
    if (!dedupedRoots.includes(root)) {
      dedupedRoots.push(root);
    }
  }

  const sortedRoots = [...dedupedRoots].sort((left, right) => left.length - right.length);
  const compactRoots: string[] = [];

  for (const root of sortedRoots) {
    if (!compactRoots.some((parentRoot) => isPathInsideRoot(root, parentRoot))) {
      compactRoots.push(root);
    }
  }

  return compactRoots;
}

function resolveWorkspaceAccessRootInputs(): string[] {
  const explicitAccessRoots = splitPathList(process.env.MASTRA_WORKSPACE_ACCESS_ROOTS);

  if (explicitAccessRoots.length > 0) {
    return [workspaceRoot, ...explicitAccessRoots];
  }

  return [workspaceRoot, os.homedir(), "/container", "/shared"];
}

export const workspaceAccessRoots = compactAccessRoots(resolveWorkspaceAccessRootInputs());

export function isWorkspaceRootExposed(): boolean {
  return workspaceAccessRoots.length === 1 && workspaceAccessRoots[0] === path.parse(workspaceAccessRoots[0]).root;
}

export function allowedWorkspaceRootsDescription(): string {
  return workspaceAccessRoots.join(", ");
}

export function resolveWorkspaceInputPath(inputPath: string): string {
  if (inputPath.trim() === "") {
    throw new Error("Path must not be empty.");
  }

  if (path.isAbsolute(inputPath)) {
    const resolvedPath = resolveConfiguredPath(inputPath);
    if (!workspaceAccessRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
      throw new Error(`Absolute path is outside the configured workspace access roots: ${allowedWorkspaceRootsDescription()}`);
    }

    return resolvedPath;
  }

  const resolvedPath = path.resolve(workspaceRoot, inputPath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Relative path escapes the configured workspace root.");
  }

  return resolvedPath;
}

export function toWorkspacePath(absolutePath: string): string {
  const resolvedPath = path.resolve(absolutePath);

  if (isPathInsideRoot(resolvedPath, workspaceRoot)) {
    return path.relative(workspaceRoot, resolvedPath) || ".";
  }

  return resolvedPath;
}
