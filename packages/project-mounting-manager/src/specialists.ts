import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ModelAliasResolverPort } from "./ports.js";

const specialistFrontmatterSchema = z.object({
  description: z.string().min(1),
  name: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  "user-invocable": z.boolean().optional(),
  "disable-model-invocation": z.boolean().optional(),
  "mcp-servers": z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export interface ProjectSpecialist {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools?: readonly string[];
  readonly model: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly mcpServers: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly source: string;
}

const specialistRoots = [".github/agents", ".mastracode/agents"] as const;

export async function discoverProjectSpecialists(
  projectRoot: string,
  modelAliases: ModelAliasResolverPort,
): Promise<ReadonlyMap<string, ProjectSpecialist>> {
  const specialists = new Map<string, ProjectSpecialist>();
  for (const root of specialistRoots) {
    const discovered = await discoverSpecialistRoot(projectRoot, root, modelAliases);
    for (const [id, specialist] of discovered) specialists.set(id, specialist);
  }
  return specialists;
}

export const loadProjectSpecialists = discoverProjectSpecialists;

async function discoverSpecialistRoot(
  projectRoot: string,
  rootName: string,
  modelAliases: ModelAliasResolverPort,
): Promise<ReadonlyMap<string, ProjectSpecialist>> {
  const directory = resolve(projectRoot, rootName);
  const entries = await readDirectory(directory);
  const specialists = new Map<string, ProjectSpecialist>();
  for (const entry of entries) {
    if (!isSpecialistFilename(entry.name)) continue;
    const sourcePath = resolve(directory, entry.name);
    if (entry.isSymbolicLink() || (await lstat(sourcePath)).isSymbolicLink()) {
      throw new Error(`Project specialist cannot be a symbolic link: ${sourcePath}`);
    }
    if (!entry.isFile()) continue;
    await assertContained(projectRoot, sourcePath, "specialist");
    const specialist = parseSpecialist(
      projectRoot,
      sourcePath,
      await readFile(sourcePath, "utf8"),
      modelAliases,
    );
    if (specialists.has(specialist.id)) {
      throw new Error(`Duplicate project specialist ID: ${specialist.id}`);
    }
    specialists.set(specialist.id, specialist);
  }
  return specialists;
}

function parseSpecialist(
  projectRoot: string,
  sourcePath: string,
  markdown: string,
  modelAliases: ModelAliasResolverPort,
): ProjectSpecialist {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`Project specialist requires YAML frontmatter: ${sourcePath}`);
  const frontmatter = specialistFrontmatterSchema.parse(parse(match[1] ?? ""));
  const id = specialistId(sourcePath);
  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description,
    instructions: (match[2] ?? "").trim(),
    ...(frontmatter.tools ? { tools: frontmatter.tools } : {}),
    model: modelAliases.resolveSpecialistModel(frontmatter.model),
    userInvocable: frontmatter["user-invocable"] ?? true,
    disableModelInvocation: frontmatter["disable-model-invocation"] ?? false,
    mcpServers: frontmatter["mcp-servers"] ?? [],
    metadata: frontmatter.metadata ?? {},
    source: relative(projectRoot, sourcePath).split(sep).join("/"),
  };
}

function specialistId(sourcePath: string): string {
  const filename = sourcePath.split(sep).at(-1) ?? "";
  return filename.replace(/\.agent\.md$/, "").replace(/\.md$/, "");
}

function isSpecialistFilename(filename: string): boolean {
  return filename.endsWith(".md");
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function assertContained(projectRoot: string, sourcePath: string, kind: string): Promise<void> {
  const root = await realpath(projectRoot);
  const source = await realpath(sourcePath);
  if (source.startsWith(`${root}${sep}`)) return;
  throw new Error(`Project ${kind} escapes the project root: ${sourcePath}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
