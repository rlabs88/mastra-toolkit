---
kind: checkpoint-context
version: 1
scope: "deployment/mcode-sandbox/**"
status: active
---

# MCode Sandbox Deployment Context

## Past

The toolkit selected Local, Docker, or Platform sandbox providers but did not own a dedicated deployable environment containing the MCode application and its approved tools.

## Present

Issue #119 activated this boundary for Factory repository execution. One locked MCode runtime layer extends the immutable AES baseline for `ephemeral-development` and the immutable OPS overlay for `persistent-operations`. `packages/sandbox/config/runtime-profiles.json` remains the canonical profile and package-layer source. Each image records its installed profile and exposes the same runtime probe; Factory runs that probe when a remote workspace starts and rejects a mismatched profile, stale Docker image identity, incomplete tool layer, or ambiently privileged environment.

The repository owns the image source and native ARM64 build/verification path. OPS owns package publication and live runtime reconciliation. No publisher token, Platform credential, WorkOS secret, database URL, Redis URL, or Infisical workload credential belongs in either image. The persistent profile may receive approved scoped credentials only at runtime after admission.

## Future

Publish both validated targets under immutable identities, configure each deployment profile to use its matching image, and collect live Factory reattachment, health, secret-delivery, and rollback evidence. Those external gates complete the persistent profile; multi-project work remains dependent on the single-project acceptance criteria.
