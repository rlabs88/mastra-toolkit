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
