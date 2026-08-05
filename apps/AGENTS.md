---
kind: agent-instructions
version: 1
scope: "apps/**"
status: active
inherits: "../AGENTS.md"
applies_to: ["**/*"]
---

# Application Host Policy

## Read first

- Read the root `AGENTS.md` and this folder's `CONTEXT.md`.
- Read the checkpoint for every package consumed by the application before changing its composition.

## Operating rules

- Keep applications thin: argument parsing, process lifecycle, host construction, and user-facing error presentation belong here.
- Put reusable prompts, tools, configuration, mounting behavior, sandbox policy, and Factory integration in their owning packages.
- Compose packages only through their public exports; do not deep-import package internals.
- Keep the `mcode` executable an RLabs composition of published Mastra Code APIs. Do not patch or copy upstream Mastra Code source here.

## Structure and extension

```text
apps/
├── mcode/bin/mcode.mjs # workspace `mcode` executable (tsx shim)
├── mcode/src/cli.ts    # local CLI/TUI process lifecycle
├── studio/src/index.ts # Studio composition root
└── factory/src/index.ts # Factory composition root
```

- Keep one entrypoint per application while its lifecycle remains cohesive. Add a local module only for an independently testable lifecycle, transport, or presentation concern.
- Each application manifest must declare every package it imports directly or loads explicitly through host tooling.
- Add an application only for a materially distinct executable or server. A deployment profile, model selection, mode, or local-versus-remote setting is not a separate application.
- Keep delivery assets under `deployment/`. Continue sharing this checkpoint until an application's local policy genuinely diverges; do not add speculative nested checkpoints.

## Change boundaries

- Change an application's consumed package contract and its integration test together.
- Do not introduce a second canonical agent, prompt, model profile, project-resource loader, or sandbox implementation in an application.
- Preserve project-root and worktree isolation across MCode, Studio, and Factory hosts.

## Validation

- Run the application's smoke test plus the owning packages' contract tests.
- Run the root typecheck, test, build, and secrets checks before handoff.

## Handoff

- State which package APIs the application composes and which host lifecycle changed.
- Report any host-specific validation that could not run locally.
