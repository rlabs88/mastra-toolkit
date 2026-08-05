import type { Mastra } from "@mastra/core/mastra";
import type {
  CurrentToolSnapshotPort,
  HostGenerationRegistration,
  ModelAliasResolverPort,
  PreparedHostRegistration,
  StagedHostRegistrationPort,
} from "@rlabs/project-mounting-manager";
import {
  resolveAliasModelId,
  type ModelProfile,
} from "@rlabs/runtime-config";

export class ProfileModelAliasResolver implements ModelAliasResolverPort {
  readonly #profile: ModelProfile;

  constructor(profile: ModelProfile) {
    this.#profile = profile;
  }

  resolveSpecialistModel(alias: string | undefined): string {
    return `proxy/${resolveAliasModelId(this.#profile, alias ?? this.#profile.roles.specialist)}`;
  }
}

export class EmptyToolSnapshot implements CurrentToolSnapshotPort {
  snapshot(): Record<string, never> {
    return {};
  }
}

export class MastraProjectHostRegistry implements StagedHostRegistrationPort {
  readonly #mastra: Mastra;

  constructor(mastra: Mastra) {
    this.#mastra = mastra;
  }

  async prepare(registration: HostGenerationRegistration): Promise<PreparedHostRegistration> {
    const agentKeys = [...registration.generation.specialistAgents].map(([id]) =>
      `project-specialist-${id}@${registration.generation.id}`
    );
    let committed = false;
    return {
      commit: async () => {
        if (committed) return;
        for (const workflow of registration.generation.workflows.values()) {
          this.#mastra.addWorkflow(workflow.workflow, `${workflow.id}@${workflow.generation}`);
        }
        for (const [[, agent], key] of zip(
          registration.generation.specialistAgents,
          agentKeys,
        )) {
          this.#mastra.addAgent(agent, key);
        }
        committed = true;
      },
      rollback: async () => {
        if (!committed) return;
        for (const key of agentKeys) this.#mastra.removeAgent(key);
        committed = false;
      },
    };
  }
}

function zip<T, U>(left: Iterable<T>, right: Iterable<U>): Array<[T, U]> {
  const rightValues = [...right];
  return [...left].map((value, index) => [value, rightValues[index]!] as [T, U]);
}
