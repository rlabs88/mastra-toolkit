# Factory MCode sandbox images

This activated deployment target packages the runtime used by GitHub-backed Factory workspaces. Factory remains a sandbox-free control plane; its configured sandbox template creates or reattaches an isolated workspace for each project, user, and session binding.

## Profiles

- `ephemeral-development` extends the immutable AES image with the locked `mcode-runtime` and project-development layers. It admits only task-scoped repository credentials.
- `persistent-operations` extends the immutable OPS image with the same runtime plus operations tools. Approved deployment credentials may be delivered only at runtime after admission; they are never ambient in the image or Factory process.

Both targets are native `linux/arm64` images. The canonical names, package layers, lifecycle, and credential class come from `packages/sandbox/config/runtime-profiles.json`, which is copied into each image. `/etc/mastra-toolkit/runtime-profile` binds an image to exactly one profile, and `/usr/local/bin/mastra-toolkit-runtime-probe` verifies the installed profile, selected Docker image identity, tools, Mastra workflow imports, and absence of privileged ambient credentials. Factory invokes that probe before any remote execution-capable path is admitted.

## Build and verify

On a native ARM64 host with a native ARM64 Docker daemon, Buildx, Git, Python 3, `jq`, and `rg`:

```bash
./deployment/mcode-sandbox/build-validate.sh
```

The script refuses a dirty Git worktree, builds every canonical profile without publishing it, and labels the artifact with the exact full commit. `verify-image.sh` checks architecture, source and revision labels, the inherited `sandbox-entrypoint/v1` probe and normal `serve` startup, the profile runtime probe, a real Mastra workflow, image configuration, and build history. Containers created during verification are bounded and removed on completion or interruption.

Hosted CI is source-only for this target. OPS publishes validated images from an approved native builder, records their immutable digests, and configures the Factory runtime or Platform environment with the matching profile. Docker-backed Factory uses `SANDBOX_RUNTIME_IMAGE` and rejects mutable references.

## Health and rollback

Admission succeeds only when the requested profile matches the image marker, the requested immutable Docker identity matches the workspace environment, and the runtime probe exits successfully. A failed probe destroys the rejected workspace, falls back to stopping it when destruction fails, and reports cleanup failure without masking the admission error. Runtime health also requires the existing `sandbox-entrypoint/v1` probe inherited from the AES/OPS base.

Rollback selects the previous verified immutable image for the affected profile. Persistent bindings and state remain control-plane records: reattachment creates a replacement workspace when the provider lease is stale, while destructive teardown remains explicit. Never roll back by mutating a tag or injecting publisher, control-plane, WorkOS, database, Redis, or Infisical credentials into an image.
