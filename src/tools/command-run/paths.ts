import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

export async function resolveWorkspacePath(root: string, requestedPath: string): Promise<string> {
  if (requestedPath.includes("\0")) throw new Error("paths cannot contain null bytes")
  const canonicalRoot = await realpath(root)
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(canonicalRoot, requestedPath)
  assertWithinRoot(canonicalRoot, candidate)

  const existingAncestor = await findExistingAncestor(candidate, canonicalRoot)
  const canonicalAncestor = await realpath(existingAncestor)
  assertWithinRoot(canonicalRoot, canonicalAncestor)
  return candidate
}

function assertWithinRoot(root: string, candidate: string): void {
  const child = relative(root, candidate)
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) return
  throw new Error(`path escapes workspace: ${candidate}`)
}

async function findExistingAncestor(candidate: string, root: string): Promise<string> {
  let current = candidate
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (current === root) return root
    const parent = dirname(current)
    if (parent === current) throw new Error(`cannot resolve path ancestor: ${candidate}`)
    current = parent
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
