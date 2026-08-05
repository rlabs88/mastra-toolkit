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

This checkpoint reserves the delivery boundary for a Factory-consumed MCode sandbox. No image, manifest, or pipeline is implemented here yet.

## Future

A dedicated issue will define the immutable image, package layers, entrypoint ABI, ephemeral and persistent credential profiles, publication pipeline, and Factory rollout contract.
