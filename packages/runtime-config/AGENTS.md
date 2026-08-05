---
kind: agent-instructions
version: 1
scope: "packages/runtime-config/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Runtime Config Agent Policy

## Read first

- Read the repository [AGENTS.md](../../AGENTS.md) and this folder's [CONTEXT.md](CONTEXT.md).

## Operating rules

- Keep model aliases, role defaults, and provider metadata canonical in `config/models.yaml`.
- Keep checked-in configuration secret-free; resolve only the environment variable named by the profile.
- Expose host-neutral resolved configuration and keep Studio, Factory, and Code adaptation outside this package.

## Change boundaries

- Change the profile schema, package-local YAML, resolver tests, and public exports together.
- Preserve explicit model selections and reject unknown aliases instead of substituting a fallback.
- Do not import application config, sandbox policy, or host lifecycle modules.

## Validation

- Run `npm test --prefix packages/runtime-config` and `npm run typecheck --prefix packages/runtime-config`.
- Confirm `git diff --check` and inspect configuration changes for credential values.

## Handoff

- State which profile or environment contract changed and list the package-local checks that ran.
