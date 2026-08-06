import type { ModelAliasResolverPort } from "./contract.js";
import { createTool } from "@mastra/core/tools";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

export async function validateProjectMcpConfiguration(
  projectRoot: string,
  userHome: string = homedir(),
): Promise<void> {
  const files = [
    join(projectRoot, ".claude", "settings.local.json"),
    join(userHome, ".mastracode", "mcp.json"),
    join(projectRoot, ".mcp.json"),
    join(projectRoot, ".mastracode", "mcp.json"),
  ];
  for (const file of files) await validateJsonFile(file);
}

export const validateMcpConfigFiles = validateProjectMcpConfiguration;

async function validateJsonFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP JSON: ${path}`, { cause: error });
  }
}

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

export interface ProjectResourceWatcherOptions {
  readonly projectRoot: string;
  readonly debounceMs?: number;
  readonly reload: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface ProjectResourceWatcher {
  close(): void;
}

const watchedPrefixes = [
  `.agents${sep}skills`,
  `.claude${sep}skills`,
  `.claude${sep}settings.local.json`,
  `.github${sep}agents`,
  ".mcp.json",
  `.mastracode${sep}agents`,
  `.mastracode${sep}mcp.json`,
  `.mastracode${sep}skills`,
  `.mastracode${sep}workflow`,
] as const;

export function isProjectResourcePath(projectRoot: string, changedPath: string): boolean {
  const path = relative(resolve(projectRoot), resolve(projectRoot, changedPath));
  if (!path || path === ".." || path.startsWith(`..${sep}`)) return false;
  return watchedPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}${sep}`));
}

export function watchProjectResources(options: ProjectResourceWatcherOptions): ProjectResourceWatcher {
  const debounceMs = options.debounceMs ?? 150;
  let timer: NodeJS.Timeout | undefined;
  let reloading = false;
  let queued = false;

  const runReload = async (): Promise<void> => {
    if (reloading) {
      queued = true;
      return;
    }
    reloading = true;
    do {
      queued = false;
      try {
        await options.reload();
      } catch (error) {
        options.onError?.(error);
      }
    } while (queued);
    reloading = false;
  };

  const schedule = (changedPath: string | null): void => {
    if (!changedPath || !isProjectResourcePath(options.projectRoot, changedPath)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void runReload(), debounceMs);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(options.projectRoot, { recursive: true }, (_event, filename) => {
      schedule(filename?.toString() ?? null);
    });
  } catch (error) {
    throw new Error(`Unable to watch project resources under ${options.projectRoot}`, { cause: error });
  }
  watcher.on("error", error => options.onError?.(error));

  return {
    close(): void {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

const agentToolSchema = z.object({
  description: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const workflowResultSchema = z.object({
  runId: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

const packageRequire = createRequire(import.meta.url);

export interface ProjectWorkflowAgentTool {
  readonly description: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProjectWorkflow {
  readonly id: string;
  readonly generation: string;
  readonly workflow: AnyWorkflow;
  readonly agentTool?: ProjectWorkflowAgentTool;
  readonly tool?: ReturnType<typeof createTool>;
  readonly source: string;
}

export async function discoverProjectWorkflows(
  projectRoot: string,
): Promise<ReadonlyMap<string, ProjectWorkflow>> {
  const directory = resolve(projectRoot, ".mastracode", "workflow");
  const entries = await readWorkflowDirectory(directory);
  const workflows = new Map<string, ProjectWorkflow>();
  for (const entry of entries) {
    const sourcePath = resolve(directory, entry.name);
    const source = relative(projectRoot, sourcePath).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`Project workflow cannot be a symbolic link: ${source}`);
    if (!entry.isFile() || !isWorkflowEntry(entry.name)) continue;
    await assertWorkflowContained(projectRoot, sourcePath);
    const compiled = await compileWorkflow(sourcePath);
    const loaded = await import(pathToFileURL(compiled.outputPath).href);
    if (!isCommittedWorkflow(loaded.default)) {
      throw new Error(`Project workflow must default-export a committed Mastra Workflow: ${source}`);
    }
    const workflow = loaded.default;
    const schemas = workflowSchemas(workflow);
    assertStandardSchema(schemas.inputSchema, `${workflow.id} input`);
    assertStandardSchema(schemas.outputSchema, `${workflow.id} output`);
    if (workflows.has(workflow.id)) throw new Error(`Duplicate project workflow ID: ${workflow.id}`);
    const parsedAgentTool = loaded.agentTool === undefined ? undefined : agentToolSchema.parse(loaded.agentTool);
    const agentTool: ProjectWorkflowAgentTool | undefined = parsedAgentTool
      ? {
          description: parsedAgentTool.description,
          ...(parsedAgentTool.metadata ? { metadata: parsedAgentTool.metadata } : {}),
        }
      : undefined;
    workflows.set(workflow.id, {
      id: workflow.id,
      generation: compiled.generation,
      workflow,
      ...(agentTool
        ? { agentTool, tool: createWorkflowTool(workflow, agentTool.description) }
        : {}),
      source,
    });
  }
  return workflows;
}

export const loadProjectWorkflows = discoverProjectWorkflows;

function createWorkflowTool(workflow: AnyWorkflow, description: string): ReturnType<typeof createTool> {
  const schemas = workflowSchemas(workflow);
  return createTool({
    id: `workflow_${sanitizeId(workflow.id)}`,
    description,
    inputSchema: schemas.inputSchema,
    outputSchema: workflowResultSchema,
    requireApproval: true,
    execute: async (input, context) => {
      const run = await workflow.createRun();
      const cancel = () => {
        void run.cancel();
      };
      context.abortSignal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await run.start({
          inputData: input,
          requestContext: context.requestContext,
          ...(context.writer ? { outputWriter: chunk => context.writer!.write(chunk) } : {}),
        });
        if (result.status === "success") {
          const output = await validateStandardSchema(schemas.outputSchema, result.result, `${workflow.id} output`);
          return { runId: run.runId, status: result.status, output };
        }
        if (result.status === "failed") {
          return { runId: run.runId, status: result.status, error: result.error.message };
        }
        return { runId: run.runId, status: result.status };
      } finally {
        context.abortSignal?.removeEventListener("abort", cancel);
      }
    },
  });
}

async function compileWorkflow(sourcePath: string): Promise<{ generation: string; outputPath: string }> {
  const result = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    sourcemap: "inline",
    plugins: [absolutePackageImports(sourcePath)],
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`Workflow compiler produced no output: ${sourcePath}`);
  const generation = createHash("sha256").update(output.contents).digest("hex").slice(0, 16);
  const outputDirectory = join(tmpdir(), "rlabs-project-workflows");
  const outputPath = join(outputDirectory, `${basename(sourcePath, extname(sourcePath))}-${generation}.mjs`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, output.contents);
  return { generation, outputPath };
}

function absolutePackageImports(sourcePath: string): Plugin {
  const projectRequire = createRequire(sourcePath);
  return {
    name: "absolute-package-imports",
    setup(builder) {
      builder.onResolve({ filter: /^[^./]|^@/ }, args => {
        if (args.path.startsWith("node:")) return { path: args.path, external: true };
        return { path: resolvePackage(args.path, projectRequire), external: true };
      });
    },
  };
}

function resolvePackage(packageName: string, projectRequire: NodeJS.Require): string {
  try {
    return pathToFileURL(projectRequire.resolve(packageName)).href;
  } catch {
    return pathToFileURL(packageRequire.resolve(packageName)).href;
  }
}

function workflowSchemas(workflow: AnyWorkflow): { inputSchema: object; outputSchema: object } {
  return workflow as unknown as { inputSchema: object; outputSchema: object };
}

async function validateStandardSchema(schema: object, value: unknown, label: string): Promise<unknown> {
  const standard = (schema as { "~standard"?: { validate(input: unknown): unknown } })["~standard"];
  if (!standard) throw new Error(`${label} does not implement Standard Schema`);
  const result = await standard.validate(value) as { issues?: readonly unknown[] };
  if (result.issues?.length) throw new Error(`${label} failed schema validation`);
  return "value" in result ? result.value : value;
}

function assertStandardSchema(schema: object, label: string): void {
  const standard = (schema as { "~standard"?: { validate?: unknown } })["~standard"];
  if (!standard || typeof standard.validate !== "function") {
    throw new Error(`${label} does not implement Standard Schema`);
  }
}

function isCommittedWorkflow(value: unknown): value is AnyWorkflow {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    component?: unknown;
    committed?: unknown;
    id?: unknown;
    createRun?: unknown;
  };
  return candidate.component === "WORKFLOW"
    && candidate.committed === true
    && typeof candidate.id === "string"
    && typeof candidate.createRun === "function";
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function isWorkflowEntry(filename: string): boolean {
  return /\.(?:[cm]?[jt]s)$/.test(filename) && !filename.endsWith(".d.ts");
}

async function readWorkflowDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function assertWorkflowContained(projectRoot: string, sourcePath: string): Promise<void> {
  const root = await realpath(projectRoot);
  const source = await realpath(sourcePath);
  if (source.startsWith(`${root}${sep}`)) return;
  throw new Error(`Project workflow escapes the project root: ${sourcePath}`);
}
