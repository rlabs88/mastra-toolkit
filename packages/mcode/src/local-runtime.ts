import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { wireSessionConcerns } from "@mastra/code-sdk";
import type { MastraCodeState } from "@mastra/code-sdk/schema";
import { detectProject } from "@mastra/code-sdk/utils/project";
import { releaseAllThreadLocks } from "@mastra/code-sdk/utils/thread-lock";
import type { Session } from "@mastra/core/agent-controller";
import { MastraTUI } from "mastracode/tui";
import { loadMcodeConfig } from "./config.js";
import {
  mountMcodeRuntime,
  type McodeRuntimeOptions,
  type MountedMcodeRuntime,
} from "./mount.js";

export interface LocalMcodeRuntime extends MountedMcodeRuntime {
  readonly session: Session<MastraCodeState>;
  runTui(): Promise<void>;
}

export async function createLocalMcodeRuntime(
  options: McodeRuntimeOptions = {},
): Promise<LocalMcodeRuntime> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const project = detectProject(cwd);
  const config = options.config ?? loadMcodeConfig(
    { ...(options.environment ?? process.env), WORKSPACE_ROOT: project.rootPath },
    project.rootPath,
  );
  const mounted = await mountMcodeRuntime({ ...options, cwd, config });
  const session = await mounted.controller.createSession({
    id: localSessionId(mounted.project.rootPath),
    ownerId: mounted.code.ownerId,
    resourceId: mounted.project.resourceId,
    scope: mounted.project.rootPath,
    tags: { projectPath: mounted.project.rootPath },
  });
  await wireSessionConcerns(mounted.code, session);

  let tui: MastraTUI | undefined;
  let closed = false;
  return {
    ...mounted,
    session,
    async runTui(): Promise<void> {
      tui ??= new MastraTUI({
        controller: mounted.controller,
        session,
        ...(mounted.code.hookManager ? { hookManager: mounted.code.hookManager } : {}),
        ...(mounted.code.authStorage ? { authStorage: mounted.code.authStorage } : {}),
        ...(mounted.code.mcpManager ? { mcpManager: mounted.code.mcpManager } : {}),
        ...(mounted.code.pluginManager ? { pluginManager: mounted.code.pluginManager } : {}),
        ...(mounted.code.storageMaintenance ? { storageMaintenance: mounted.code.storageMaintenance } : {}),
        ...(mounted.code.githubSignals ? { githubSignals: mounted.code.githubSignals } : {}),
        appName: "RLabs MCode",
        inlineQuestions: true,
      });
      await tui.run();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      tui?.stop();
      releaseAllThreadLocks();
      await mounted.close();
    },
  };
}

function localSessionId(projectRoot: string): string {
  const rootHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return `mcode-local-${rootHash}`;
}
