import { StagehandBrowser } from "@mastra/stagehand";

export function createVisibleBrowser(options: { readonly executablePath?: string; readonly userDataDir?: string } = {}): StagehandBrowser {
  return new StagehandBrowser({
    env: "LOCAL",
    headless: false,
    scope: "thread",
    viewport: { width: 1440, height: 960 },
    timeout: 30_000,
    selfHeal: true,
    preserveUserDataDir: Boolean(options.userDataDir),
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.userDataDir ? { profile: options.userDataDir } : {}),
  });
}

export function browserActionRequiresApproval(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "stagehand_tabs") return args.action !== "list";
  return ["stagehand_act", "stagehand_navigate", "stagehand_close"].includes(toolName);
}
