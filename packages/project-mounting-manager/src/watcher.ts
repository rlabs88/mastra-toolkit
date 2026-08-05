import { watch, type FSWatcher } from "node:fs";
import { relative, resolve, sep } from "node:path";

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
