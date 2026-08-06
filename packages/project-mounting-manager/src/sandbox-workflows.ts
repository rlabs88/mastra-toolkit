/**
 * Kept as a self-contained script so Factory never imports project workflow modules on its host.
 * The active sandbox supplies TypeScript resolution and executes this source from the bound checkout.
 */
export const SANDBOX_PROJECT_WORKFLOW_RUNNER = String.raw`
import { createHash } from "node:crypto";
import { access, mkdir, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_PREFIX = "__RLABS_PROJECT_WORKFLOW_RESULT__";
const STREAM_PREFIX = "__RLABS_PROJECT_WORKFLOW_STREAM__";

async function validate(schema, value, label) {
  const standard = assertStandardSchema(schema, label);
  const result = await standard.validate(value);
  if (result?.issues?.length) throw new Error(label + " failed schema validation");
  return result && "value" in result ? result.value : value;
}

function assertStandardSchema(schema, label) {
  const standard = schema?.["~standard"];
  if (!standard || typeof standard.validate !== "function") {
    throw new Error(label + " does not implement Standard Schema");
  }
  return standard;
}

function publishedAgentTool(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || typeof value.description !== "string" || !value.description) {
    throw new Error("Project workflow agentTool metadata is invalid");
  }
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))) {
    throw new Error("Project workflow agentTool metadata must be an object");
  }
  return {
    description: value.description,
    ...(value.metadata ? { metadata: value.metadata } : {}),
  };
}

function committedWorkflow(value, source) {
  if (!value || typeof value !== "object" || value.component !== "WORKFLOW" || value.committed !== true
    || typeof value.id !== "string" || typeof value.createRun !== "function") {
    throw new Error("Project workflow must default-export a committed Mastra Workflow: " + source);
  }
  return value;
}

function runtimePackageRequires() {
  const projectRequire = createRequire(resolve(process.cwd(), "package.json"));
  const runtimeRequires = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(path => basename(path) === ".bin" && basename(dirname(path)) === "node_modules")
    .map(path => createRequire(join(dirname(dirname(path)), "package.json")));
  return { projectRequire, runtimeRequires };
}

function resolvePackage(packageName, projectRequire, runtimeRequires) {
  for (const candidate of [projectRequire, ...runtimeRequires]) {
    try {
      return candidate.resolve(packageName);
    } catch {}
  }
  throw new Error("Project workflow dependency is unavailable in the project or mcode-runtime layer: " + packageName);
}

async function compileWorkflow(sourcePath) {
  const { projectRequire, runtimeRequires } = runtimePackageRequires();
  const esbuildPath = resolvePackage("esbuild", projectRequire, runtimeRequires);
  const { build } = await import(pathToFileURL(esbuildPath).href);
  const result = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    sourcemap: "inline",
    plugins: [{
      name: "factory-runtime-package-imports",
      setup(builder) {
        builder.onResolve({ filter: /^[^./]|^@/ }, args => {
          if (args.path.startsWith("node:")) return { path: args.path, external: true };
          const resolved = resolvePackage(args.path, projectRequire, runtimeRequires);
          return { path: pathToFileURL(resolved).href, external: true };
        });
      },
    }],
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("Project workflow compiler produced no output: " + sourcePath);
  const generation = createHash("sha256").update(output.contents).digest("hex").slice(0, 16);
  const outputDirectory = join(tmpdir(), "rlabs-factory-project-workflows");
  const outputPath = join(outputDirectory, basename(sourcePath, extname(sourcePath)) + "-" + generation + ".mjs");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, output.contents);
  return outputPath;
}

async function loadWorkflows() {
  const projectRoot = await realpath(process.cwd());
  const directory = resolve(projectRoot, ".mastracode", "workflow");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const workflows = [];
  const workflowIds = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error("Project workflow cannot be a symbolic link: " + entry.name);
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    const sourcePath = await realpath(resolve(directory, entry.name));
    if (!sourcePath.startsWith(projectRoot + sep)) throw new Error("Project workflow escapes the project root: " + entry.name);
    const compiledPath = await compileWorkflow(sourcePath);
    const loaded = await import(pathToFileURL(compiledPath).href + "?factory=" + Date.now());
    const workflow = committedWorkflow(loaded.default, entry.name);
    assertStandardSchema(workflow.inputSchema, workflow.id + " input");
    assertStandardSchema(workflow.outputSchema, workflow.id + " output");
    if (workflowIds.has(workflow.id)) throw new Error("Duplicate project workflow ID: " + workflow.id);
    workflowIds.add(workflow.id);
    workflows.push({ workflow, agentTool: publishedAgentTool(loaded.agentTool) });
  }
  return workflows;
}

function finish(value) {
  process.stdout.write("\n" + RESULT_PREFIX + JSON.stringify(value) + "\n");
}

async function main() {
  const [action, requestedId, encodedInput, cancellationPath] = process.argv.slice(1);
  const workflows = await loadWorkflows();
  if (action === "list") {
    finish({
      workflows: workflows.flatMap(({ workflow, agentTool }) => agentTool
        ? [{ id: workflow.id, description: agentTool.description, ...(agentTool.metadata ? { metadata: agentTool.metadata } : {}) }]
        : []),
    });
    return;
  }
  if (action !== "run" || !requestedId || !encodedInput) throw new Error("Invalid project workflow operation");
  const selected = workflows.find(({ workflow }) => workflow.id === requestedId);
  if (!selected) throw new Error("Project workflow was not found: " + requestedId);
  if (!selected.agentTool) throw new Error("Project workflow is not published to agents: " + requestedId);
  const input = await validate(
    selected.workflow.inputSchema,
    JSON.parse(Buffer.from(encodedInput, "base64url").toString("utf8")),
    selected.workflow.id + " input",
  );
  const run = await selected.workflow.createRun();
  let cancellationStarted = false;
  let cancellationError;
  const cancel = async () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    try {
      await run.cancel();
    } catch (error) {
      cancellationError = error;
    }
  };
  const cancellationFile = cancellationPath ? resolve(process.cwd(), cancellationPath) : undefined;
  const cancellationPoll = cancellationFile ? setInterval(() => {
    void access(cancellationFile).then(() => cancel(), () => undefined);
  }, 25) : undefined;
  try {
    // Factory request context can carry host auth and controller objects, so it is never serialized into project code.
    const result = await run.start({
      inputData: input,
      outputWriter: async chunk => {
        const encoded = Buffer.from(JSON.stringify(chunk)).toString("base64url");
        process.stdout.write("\n" + STREAM_PREFIX + encoded + "\n");
      },
    });
    if (cancellationError) throw cancellationError;
    if (result.status === "success") {
      const output = await validate(selected.workflow.outputSchema, result.result, selected.workflow.id + " output");
      finish({ runId: run.runId, status: result.status, output });
      return;
    }
    if (result.status === "failed") {
      finish({ runId: run.runId, status: result.status, error: result.error?.message ?? String(result.error) });
      return;
    }
    finish({ runId: run.runId, status: result.status });
  } finally {
    if (cancellationPoll) clearInterval(cancellationPoll);
    if (cancellationFile) await unlink(cancellationFile).catch(() => undefined);
  }
}

main().catch(error => {
  finish({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
`;

export const SANDBOX_PROJECT_WORKFLOW_RESULT_PREFIX = "__RLABS_PROJECT_WORKFLOW_RESULT__";
export const SANDBOX_PROJECT_WORKFLOW_STREAM_PREFIX = "__RLABS_PROJECT_WORKFLOW_STREAM__";
