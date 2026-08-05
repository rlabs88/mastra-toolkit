import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createTool } from "@mastra/core/tools";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { build, type Plugin } from "esbuild";
import { z } from "zod";

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
    await assertContained(projectRoot, sourcePath);
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
          await validateStandardSchema(schemas.outputSchema, result.result, `${workflow.id} output`);
          return { runId: run.runId, status: result.status, output: result.result };
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

async function validateStandardSchema(schema: object, value: unknown, label: string): Promise<void> {
  const standard = (schema as { "~standard"?: { validate(input: unknown): unknown } })["~standard"];
  if (!standard) throw new Error(`${label} does not implement Standard Schema`);
  const result = await standard.validate(value) as { issues?: readonly unknown[] };
  if (result.issues?.length) throw new Error(`${label} failed schema validation`);
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

async function assertContained(projectRoot: string, sourcePath: string): Promise<void> {
  const root = await realpath(projectRoot);
  const source = await realpath(sourcePath);
  if (source.startsWith(`${root}${sep}`)) return;
  throw new Error(`Project workflow escapes the project root: ${sourcePath}`);
}
