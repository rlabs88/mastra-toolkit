import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { workspace } from "../workspace.js";

const workspaceSmokeStep = createStep({
  id: "workspace-smoke",
  inputSchema: z.object({}),
  outputSchema: z.object({
    status: z.enum(["ok", "error"]),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().optional(),
  }),
  execute: async () => {
    const smokeScript = [
      "set -euo pipefail",
      "pwd",
      "node --version",
      "for c in serena code-review-graph mastracode paseo gh jupyter jupyter-server jupyter-lab jupyter-console ipython mount-s3 start-jupyter-server start-paseo-daemon start-agent-services; do",
      "  path=$(command -v \"$c\")",
      "  printf '%s=%s\\n' \"$c\" \"$path\"",
      "done",
      "printf 'jupyter-server-version='",
      "jupyter-server --version",
      "printf 'sandbox-env-smoke=%s\\n' \"${SANDBOX_ENV_SMOKE:-unset}\"",
      "printf 'sandbox-secret-env='",
      "node -e \"console.log(Boolean(process.env.OPENAI_API_KEY), Boolean(process.env.ANTHROPIC_API_KEY), Boolean(process.env.GITHUB_TOKEN), Boolean(process.env.CLI_PROXY_API_KEY))\"",
    ].join("\n");
    const result = await workspace.sandbox.executeCommand?.("bash", [
      "-lc",
      smokeScript,
    ]);

    if (!result) {
      return {
        status: "error" as const,
        stdout: "",
        stderr: "Workspace sandbox does not expose executeCommand.",
      };
    }

    return {
      status: result.exitCode === 0 ? ("ok" as const) : ("error" as const),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode,
    };
  },
});

const workspaceSmokeWorkflow = createWorkflow({
  id: "workspace-smoke-workflow",
  description: "Run a smoke test against the workspace sandbox to verify tooling and environment.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    status: z.enum(["ok", "error"]),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().optional(),
  }),
})
  .then(workspaceSmokeStep)
  .commit();

export const workspaceWorkflows = {
  workspaceSmokeWorkflow,
};
