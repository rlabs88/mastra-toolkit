---
kind: checkpoint-context
version: 1
scope: "packages/runtime-config/**"
status: active
---

# Runtime Config Context

## Past

Model profile loading, proxy gateway registration, and environment defaults originally lived inside the root application package. That made host adapters depend on a broad toolkit configuration object and kept the canonical YAML outside its owning code boundary.

## Present

This package owns the secret-free model profile, its typed loader and model ID projections, the A1 proxy gateway, and host-neutral runtime environment defaults. Its package-local YAML is the canonical default consumed by the loader.

## Future

Studio, Factory, and Code can migrate to this package without acquiring sandbox or application lifecycle dependencies. Additional named profiles may be introduced when a working host slice needs them; arbitrary shell expansion and persisted credentials remain non-goals.
