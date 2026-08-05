export type ProjectMountingDiagnosticPhase =
  | "discover"
  | "mcp"
  | "prepare"
  | "commit"
  | "rollback"
  | "watch"
  | "close";

export interface ProjectMountingDiagnostic {
  readonly phase: ProjectMountingDiagnosticPhase;
  readonly message: string;
  readonly occurredAt: string;
}

export type ProjectMountingDiagnosticListener = (diagnostic: ProjectMountingDiagnostic) => void;

export class ProjectMountingDiagnostics {
  readonly #listener: ProjectMountingDiagnosticListener | undefined;
  readonly #records: ProjectMountingDiagnostic[] = [];

  constructor(listener?: ProjectMountingDiagnosticListener) {
    this.#listener = listener;
  }

  record(phase: ProjectMountingDiagnosticPhase, error: unknown): ProjectMountingDiagnostic {
    const diagnostic = Object.freeze({
      phase,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: new Date().toISOString(),
    });
    this.#records.push(diagnostic);
    this.#listener?.(diagnostic);
    return diagnostic;
  }

  snapshot(): readonly ProjectMountingDiagnostic[] {
    return [...this.#records];
  }
}
