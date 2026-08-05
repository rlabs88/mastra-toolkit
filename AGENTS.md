---
kind: agent-instructions
version: 1
scope: "**"
status: active
inherits: null
applies_to: ["**/*"]
---

# Mastra Toolkit Repository Policy

## Read first

- Read [CONTEXT.md](CONTEXT.md) for the repository's past, present, and intended direction.
- Read [docs/workspace-architecture.md](docs/workspace-architecture.md) before moving code, adding a workspace package, or introducing an upstream fork.
- Discover any deeper `AGENTS.md` and `CONTEXT.md` pair before changing a nested ownership boundary.

## Canonical runtime

- Keep one canonical definition of each agent ID, prompt, skill source, tool contract, model role, and runtime default. Studio, Factory, and Mastra Code adapters must consume those definitions rather than copy them.
- Preserve the public agent IDs `cortex`, `flux`, and `zen` and the six-section prompt order.
- Until the package migration described in the architecture document lands, treat `src/agents`, `src/tools`, and `src/runtime` as the canonical implementation. Move ownership to `packages/agent-runtime` only in a coherent migration that switches every host and its contract tests together.
- Let every Cortex, Flux, and Zen top-level mode invoke the native AgentController `subagent` tool with Cortex, Flux, or Zen as the selected leaf role. Delegated runs must not receive the `subagent` tool, so recursion remains bounded. Keep Factory worker delegation as a separate runtime concern.
- Prefer supported Mastra agents, tools, workspaces, browser, background-task, approval, AgentController mount, and `MastraTUI` extension APIs before adding toolkit-owned infrastructure or patching upstream source. Treat `createMastraCode` as a compatibility alias, not a new composition boundary.

## Configuration and secrets

- Keep checked-in model configuration declarative and secret-free. Store environment-variable names such as `CLI_PROXY_API_KEY`, never resolved credential values.
- Resolve a model profile once at process startup, validate it, and project that same resolved profile into the Studio gateway, Factory Code SDK provider, and Mastra Code adapter.
- Preserve explicit user model selections when the host supports them; profile defaults must not silently overwrite a deliberate per-session selection.
- Use Infisical project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`, environment `dev`, path `/mastra-toolkit`. Never commit or log secret values.
- Fail closed when a selected provider requires a missing key. Do not silently switch providers, endpoints, models, or sandbox classes.

## Sandbox boundary

- Keep sandbox image inputs, package-layer recipes, and environment profiles under the top-level `sandbox/` boundary when that migration is implemented. Do not mix sandbox build dependencies with root application dependencies.
- Make ephemeral and persistent environments select explicit package layers from the same sandbox contract. Ephemeral environments must not receive deployment credentials. Persistent operations environments must receive privileged credentials only at runtime from the approved secret provider.
- Local, Docker, and Platform providers must satisfy the same cloneable sandbox-machine contract and must not silently fall back.
- Never bake secrets, user state, host credentials, or Docker socket access into a sandbox image.

## Upstream forks

- Keep upstream source checkouts outside root application workspaces. Pin each checkout by git commit and record an RLabs `origin` plus the authoritative upstream remote.
- Use the Mastra monorepo fork for Mastra framework and Mastra Code TUI changes because both sources live in `mastra-ai/mastra`. Do not create a second copy of `mastracode/`.
- Treat a Mastra Code wrapper as an application adapter, not as an upstream fork. Keep it thin and import canonical toolkit packages.
- Add a separate `mastra-code-ui` fork only when desktop UI work actually requires it.
- Keep fork deltas limited to unavailable public extension points. Validate a fork change against both its upstream package tests and the toolkit integration contract.

## Change boundaries

- Add or update a failing contract test before changing production behavior.
- Change prompt text, prompt composition, and prompt snapshot tests together.
- Change the Command Run parser, scheduling, containment, timeout, cancellation, output, attachment, approval, and SSRF contracts together with their tests.
- Change model-profile schema, environment resolution, gateway registration, Mastra Code defaults, examples, and configuration tests together.
- Change a sandbox provider, image package layer, or environment profile together with the shared sandbox-machine contract tests.
- Create a nested `AGENTS.md` and `CONTEXT.md` together only when a real ownership boundary exists and entrants must recalibrate there. Do not create speculative checkpoints.

## Validation

- For current root changes, run `npm run typecheck`, `npm test`, and `npm run build`; use `npm run check` when all three are appropriate.
- For configuration changes, also run `npm run secrets:check` when Infisical access is available; report an unavailable external credential gate rather than weakening it.
- For fork changes, run the fork's nearest documented checks plus the toolkit consumer contract that exercises the changed surface.
- Confirm `git diff --check` and inspect the final diff for credentials, generated state, copied prompts, and unrelated edits.

## Handoff

- State which canonical boundary changed, which hosts consume it, and which checks ran.
- Distinguish current behavior from target architecture and call out any migration step that remains incomplete.
- Report skipped or externally blocked validation explicitly.
