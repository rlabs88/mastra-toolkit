import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { createSandboxMachine, type SandboxConfig } from "@rlabs/sandbox";

export function createMcodeWorkspace(
  config: SandboxConfig,
  options: { readonly projectRoot?: string; readonly hotReloadSkills?: boolean } = {},
): Workspace {
  const workspaceRoot = resolve(options.projectRoot ?? config.workspaceRoot);
  const sandbox = createSandboxMachine({
    provider: config.provider,
    workspaceRoot,
    specification: config.specification,
    ...(config.platform ? { platform: config.platform } : {}),
  });
  return new Workspace({
    id: "mastra-toolkit-workspace",
    name: "Mastra Toolkit Workspace",
    filesystem: new LocalFilesystem({
      basePath: workspaceRoot,
      contained: true,
      allowedPaths: ["~/.agents/skills", "~/.mastracode/skills"],
    }),
    sandbox,
    skills: [
      join(workspaceRoot, ".agents", "skills"),
      join(workspaceRoot, ".claude", "skills"),
      join(workspaceRoot, ".mastracode", "skills"),
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".mastracode", "skills"),
    ],
    checkSkillFileMtime: options.hotReloadSkills ?? false,
    tools: {
      mastra_workspace_execute_command: { requireApproval: true },
      mastra_workspace_write_file: { requireApproval: true },
      mastra_workspace_edit_file: { requireApproval: true },
      mastra_workspace_delete: { requireApproval: true },
    },
  });
}
