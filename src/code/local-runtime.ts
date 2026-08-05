import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { wireSessionConcerns } from "@mastra/code-sdk";
import type { MastraCodeState } from "@mastra/code-sdk/schema";
import { releaseAllThreadLocks } from "@mastra/code-sdk/utils/thread-lock";
import type { Session } from "@mastra/core/agent-controller";
import { detectProject } from "@mastra/code-sdk/utils/project";
import { MastraTUI } from "mastracode/tui";
import { loadToolkitConfig } from "../config.js";
import {
  mountLocalProjectRuntime,
  type LocalProjectRuntimeOptions,
  type MountedLocalProjectRuntime,
} from "../runtime/project.js";

export interface LocalCodeRuntimeOptions extends LocalProjectRuntimeOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export interface LocalCodeRuntime extends MountedLocalProjectRuntime {
  readonly session: Session<MastraCodeState>;
  runTui(): Promise<void>;
}

export async function createLocalCodeRuntime(
  options: LocalCodeRuntimeOptions = {},
): Promise<LocalCodeRuntime> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const detectedProject = detectProject(cwd);
  const config = options.config ?? loadToolkitConfig({
    ...(options.environment ?? process.env),
    WORKSPACE_ROOT: detectedProject.rootPath,
  });
  const mounted = await mountLocalProjectRuntime({ ...options, cwd, config });
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
      tui ??= createTui(mounted, session);
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

function createTui(
  runtime: MountedLocalProjectRuntime,
  session: Session<MastraCodeState>,
): MastraTUI {
  return new MastraTUI({
    controller: runtime.controller,
    session,
    ...(runtime.code.hookManager ? { hookManager: runtime.code.hookManager } : {}),
    ...(runtime.code.authStorage ? { authStorage: runtime.code.authStorage } : {}),
    ...(runtime.code.mcpManager ? { mcpManager: runtime.code.mcpManager } : {}),
    ...(runtime.code.pluginManager ? { pluginManager: runtime.code.pluginManager } : {}),
    ...(runtime.code.storageMaintenance ? { storageMaintenance: runtime.code.storageMaintenance } : {}),
    ...(runtime.code.githubSignals ? { githubSignals: runtime.code.githubSignals } : {}),
    appName: "RLabs Mastra Code",
    inlineQuestions: true,
  });
}

function localSessionId(projectRoot: string): string {
  const rootHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return `mastra-toolkit-local-${rootHash}`;
}
