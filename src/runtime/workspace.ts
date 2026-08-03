import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import type { ToolkitConfig } from "../config.js";
import { createSandboxMachine } from "../sandbox/index.js";

export function createToolkitWorkspace(config: ToolkitConfig): Workspace {
  const sandbox = createSandboxMachine({
    provider: config.sandbox.provider,
    workspaceRoot: config.sandbox.workspaceRoot,
    platform: config.platform,
    specification: config.sandbox.specification,
  });
  return new Workspace({
    id: "mastra-toolkit-workspace",
    name: "Mastra Toolkit Workspace",
    filesystem: new LocalFilesystem({
      basePath: config.sandbox.workspaceRoot,
      contained: true,
      allowedPaths: ["~/.agents/skills"],
    }),
    sandbox,
    tools: {
      mastra_workspace_execute_command: { requireApproval: true },
      mastra_workspace_write_file: { requireApproval: true },
      mastra_workspace_edit_file: { requireApproval: true },
      mastra_workspace_delete: { requireApproval: true },
    },
  });
}
