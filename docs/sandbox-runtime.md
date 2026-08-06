# Declarative sandbox runtime

Mastra Toolkit consumes a checked-in `cortex.provisioning/v1` runtime specification from [`../packages/sandbox/config/sandbox.config.json`](../packages/sandbox/config/sandbox.config.json). The document is configuration, not authority: it contains no credentials, host paths, repository tokens, mutable image tags, container IDs, or runtime leases.

At startup, `loadToolkitConfig` validates the document and freezes its provider policy for the process. `SANDBOX_PROVIDER` may select a declared Local, Docker, or Platform policy. `WORKSPACE_ROOT` remains host configuration, and Platform credentials remain in Infisical. A malformed document, a mutable Docker image, or incomplete Platform identity fails closed.

The Docker policy consumes the canonical AES baseline directly at an immutable multi-architecture index digest. The profile currently admits only `linux/arm64` and the stable `sandbox-entrypoint/v1` ABI. `DockerSandbox` supplies `serve` as the image command, applies toolkit runtime labels and hardening, and uses `probe` as the compatibility check. This repository does not own a wrapper image or duplicate the centrally published baseline.

Local execution uses Mastra's detected native isolation backend and explicitly permits network access so Factory can materialize GitHub repositories. Docker retains a read-only root filesystem, dropped capabilities, `no-new-privileges`, PID and memory bounds, and bounded tmpfs mounts. Platform uses private network isolation and a two-hour idle lease. These provider policies share the same cloneable sandbox-machine contract.

This runtime profile is separate from a model-facing Preset Card. A Preset Card selects stable repository IDs and an entrypoint profile; it must not expose image references, Docker configuration, host paths, raw commands, or credentials. A future gateway-owned preset layer can therefore point to `aes-sandbox-arm64-v1` without expanding model authority.

## Linear provenance

- [Agent sandbox specification](https://linear.app/rt88/document/agent-sandbox-specification-c5a7554c9cb3) and [AES-21](https://linear.app/rt88/issue/AES-21/publish-the-canonical-aes-sandbox-from-agent-toolkit-to-ghcr) define the centrally owned Fedora/ARM64 baseline and publication gates.
- [Preset-driven Cortex Cloud session spawning](https://linear.app/rt88/document/preset-driven-cortex-cloud-session-spawning-seed-specification-0d5488c1a7f5), [AES-61](https://linear.app/rt88/issue/AES-61/finalize-preset-card-publication-and-activation-contract), [AES-64](https://linear.app/rt88/issue/AES-64/finalize-repository-declarations-overlays-and-branch-discipline), and [AES-66](https://linear.app/rt88/issue/AES-66/finalize-entrypoint-profiles-and-the-frozen-spawn-envelope) define the separation between safe presets, repository declarations, entrypoint profiles, and frozen spawn envelopes.
- [AES-67](https://linear.app/rt88/issue/AES-67/implement-the-preset-driven-local-vertical-slice) is the completed local Docker proof for digest pinning, private repository provisioning, entrypoint health, durable leases, and cleanup.
- [RT-81](https://linear.app/rt88/issue/RT-81/formulate-docker-sandbox-execution-environment-in-mastra-system) keeps Compose-owned services outside Mastra while Mastra owns sandbox command execution.

The current slice intentionally stops at declarative runtime/profile consumption. Gateway publication, repository allowlists, frozen exact-SHA envelopes, idempotent operation identities, resumable stop, and destructive purge remain separate control-plane work rather than hidden inside the sandbox adapter.

## Factory project runtime profiles

Factory selects one project-runtime composition at process startup through `FACTORY_PROJECT_RUNTIME_PROFILE`:

- `ephemeral-development` is the default. It selects the `mcode-runtime` and `project-development` package layers and admits task-scoped credentials only.
- `persistent-operations` adds the `operations` package layer and requires the Platform sandbox provider, Postgres-backed `DATABASE_URL`, Redis-backed `REDIS_URL`, and WorkOS deployment authentication. Its credential contract references the approved Infisical project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`, environment `dev`, path `/mastra-toolkit`; resolved values are not stored in the profile.

Selecting a hardened profile with a weaker provider or in-process state fails at startup. The profile contract is the first single-project Factory slice: it freezes environment, durability, and credential policy before a project sandbox is provisioned. Issue #119 still needs to verify that the Factory-hosted controller resolves one project's checkout, filesystem, commands, setup, git operations, and project-local tools through the same persisted sandbox/session binding. Moving the complete Factory or AgentController process into that sandbox is not required unless the vertical slice exposes a concrete execution gap.
