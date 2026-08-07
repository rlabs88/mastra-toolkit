---
kind: agent-instructions
version: 1
scope: "packages/mcode/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# MCode Package Policy

## Read first

- Read the root `AGENTS.md` and this package's `CONTEXT.md`.
- Read the checkpoints for `mastra-primitives-export`, `sandbox`, and `project-mounting-manager` before changing their projections.

## Operating rules

- Own the MCode and Studio controller projections plus all Mastra Code SDK configuration, project detection, modes, native subagents, controller mounting, session wiring, Code-specific MCP adaptation, and reusable TUI construction here. Keep recipe names only as deprecated compatibility aliases.
- Consume canonical roles, tools, model profiles, sandbox behavior, and project extensions only through package public exports.
- Use published Mastra Code extension and mount APIs. Do not patch, copy, or fork upstream implementation source.
- Keep CLI argument parsing, process lifecycle, and user-facing exit behavior in `apps/mcode`.

## Structure and extension

```text
src/
├── recipe.ts  # controller projections and deprecated recipe compatibility
├── project.ts # workspace, MCP lifecycle, and project host adapters
├── runtime.ts # configuration, settings, mount lifecycle, session, and TUI
└── index.ts   # package facade
```

- Treat configuration, projection, project adaptation, runtime, and TUI as responsibility labels, not mandatory directories. Preserve the flat layout while each module remains cohesive.
- Extract a submodule only when a concern has multiple cohesive implementations behind a narrow facade or needs an independently evolving test seam.
- Import published Mastra APIs and package-root RLabs contracts. Publish TypeScript only through the package-root export.

## Change boundaries

- Do not import `@mastra/factory` or define canonical prompts and tools here.
- Change persisted settings, provider IDs, mode/subagent projections, and their compatibility tests together.
- Preserve explicit user settings and never persist proxy credentials or raw upstream model IDs.

## Validation

- Run this package's typecheck and tests plus the local MCode runtime and TUI smoke contracts.
- Pin version-sensitive Code SDK seams with integration tests before upgrading dependencies.

## Handoff

- State which Code SDK surface changed and which canonical package contract it projects.
- Report CLI/TUI, settings, session, and project-mount evidence separately.
