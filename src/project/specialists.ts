import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { resolveAliasModelId, type ModelProfile } from "../models/profile.js";

const frontmatterSchema = z.object({
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
  readonly modelId: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly mcpServers: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly source: string;
}

const roots = [".github/agents", ".mastracode/agents"] as const;

export async function loadProjectSpecialists(
  projectRoot: string,
  profile: ModelProfile,
): Promise<ReadonlyMap<string, ProjectSpecialist>> {
  const specialists = new Map<string, ProjectSpecialist>();
  for (const root of roots) {
    const loaded = await loadSpecialistRoot(projectRoot, root, profile);
    for (const [id, specialist] of loaded) specialists.set(id, specialist);
  }
  return specialists;
}

async function loadSpecialistRoot(
  projectRoot: string,
  rootName: string,
  profile: ModelProfile,
): Promise<Map<string, ProjectSpecialist>> {
  const directory = resolve(projectRoot, rootName);
  const entries = await readDirectory(directory);
  const specialists = new Map<string, ProjectSpecialist>();
  for (const entry of entries) {
    if (!isSpecialistFilename(entry.name)) continue;
    const sourcePath = resolve(directory, entry.name);
    if (entry.isSymbolicLink() || (await lstat(sourcePath)).isSymbolicLink()) {
      throw new Error(`Project specialist cannot be a symbolic link: ${sourcePath}`);
    }
    await assertContained(projectRoot, sourcePath);
    const specialist = parseSpecialist(projectRoot, sourcePath, await readFile(sourcePath, "utf8"), profile);
    if (specialists.has(specialist.id)) throw new Error(`Duplicate project specialist ID: ${specialist.id}`);
    specialists.set(specialist.id, specialist);
  }
  return specialists;
}

function parseSpecialist(
  projectRoot: string,
  sourcePath: string,
  markdown: string,
  profile: ModelProfile,
): ProjectSpecialist {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`Project specialist requires YAML frontmatter: ${sourcePath}`);
  const frontmatter = frontmatterSchema.parse(parse(match[1] ?? ""));
  const id = specialistId(sourcePath);
  const alias = frontmatter.model ?? profile.roles.specialist;
  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description,
    instructions: (match[2] ?? "").trim(),
    ...(frontmatter.tools ? { tools: frontmatter.tools } : {}),
    modelId: resolveAliasModelId(profile, alias),
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
  return filename.endsWith(".md") || filename.endsWith(".agent.md");
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function assertContained(projectRoot: string, sourcePath: string): Promise<void> {
  const root = await realpath(projectRoot);
  const source = await realpath(sourcePath);
  if (source === root || source.startsWith(`${root}${sep}`)) return;
  throw new Error(`Project specialist escapes the project root: ${sourcePath}`);
}
