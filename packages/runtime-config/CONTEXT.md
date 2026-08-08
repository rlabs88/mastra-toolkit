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

`aliases` remains a flat `string[]` and is the catalog of resolvable model IDs. `modelCards` is a sibling map keyed by alias in which every field is optional, so a card is an override layer rather than a second catalog. An alias with no card falls back to the profile-level `memory` budget. This shape was chosen over replacing `aliases` with card objects because `RuntimeDefaultsV1` already exposes a `models` object holding `providerId`/`aliases`/`roles`; promoting cards to the top level would put two different `models` shapes in one contract and would change `ModelAlias` at every import site.

Cards make the context window and the observational-memory budgets per-model properties. The reflection threshold resolves from the **default agent's** card. The observation threshold is the lower of the default agent's cadence and the selected Observer's message budget, because Mastra sends the unobserved conversation to that model without truncating it. `RuntimeDefaultsV1` therefore needed no new key and no shape change.

Fresh or unset Observer and Reflector selections both resolve through `code-economic`. These memory roles run after tool-heavy turns and favor response latency and cost; changing them does not change the active agent model. The economic Observer caps the effective observation threshold at 90,000 tokens so its 128,000-token context retains room for the observation prompt and prior observations. Existing explicit or persisted model selections remain authoritative.

### Observational memory: what is wired and what is not

Upstream reads exactly one of the three settings issue #174 asked for. Verified against the installed packages:

| Target | Status | Upstream site |
| --- | --- | --- |
| `observation.messageTokens: 90_000` | **wired** | `@mastra/code-sdk/dist/agents/memory.js:93` reads `obsThreshold` (`memory.js:68`), fed by the `observationThreshold` setting (`@mastra/code-sdk/dist/schema.d.ts:51`); the 180,000-token active-agent cadence is capped by the economic Observer's card |
| `observation.bufferTokens: 30_000` | **upstream-blocked** | hardcoded literal `isResourceScope ? false : 1 / 5` at `@mastra/code-sdk/dist/agents/memory.js:90` |
| `observation.bufferActivation: 0.8` | **upstream-blocked** | hardcoded literal `isResourceScope ? void 0 : 2e3` at `@mastra/code-sdk/dist/agents/memory.js:91` |

Neither blocked key appears anywhere else in that package's `dist` — no schema entry, no settings field. Reaching them needs a pinned fork under the root policy on unavailable public extension points, which is out of scope here.

The blocked values are recorded on the cards as declared intent and named in `UPSTREAM_BLOCKED_OBSERVATION_SETTINGS`. They are deliberately not projected into any host contract, and a contract test asserts that no host projection serializes either key, so they cannot be mistaken for live configuration. Because this package is host-neutral, the constant's `evidence` paths are relative to the Mastra Code SDK package root; the fully-qualified references live here and in `config/models.yaml`.

`reflectionThreshold` is a distinct upstream setting (`reflection.observationTokens`, `memory.js:104`) and stays at 60_000. It is not the `bufferTokens` knob; collapsing the two would halve Reflector activation on both hosts.

## Future

Studio, Factory, and Code can migrate to this package without acquiring sandbox or application lifecycle dependencies. Additional named profiles may be introduced when a working host slice needs them; arbitrary shell expansion and persisted credentials remain non-goals.

Two follow-ups are open and are not owned here:

- **The retune does not reach an existing install.** Both hosts prefer a persisted value over the profile default: `packages/mcode/src/runtime.ts:132-133` resolves `existingModels.omObservationThreshold ?? defaults.observationThreshold`, and `packages/factory-integration/src/config.ts:426-431` patches only null fields. Any machine that already persisted another model or threshold keeps it. A migration must distinguish a deliberate user override from a stale persisted default — the repo rule preserving explicit user model selections covers the former, not the latter. Both files belong to other lanes.
- **`bufferTokens` and `bufferActivation`** stay declared-only until a pinned Mastra Code SDK fork exposes them, at which point the card values are already in place.
