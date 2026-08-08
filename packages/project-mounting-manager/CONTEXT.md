---
kind: checkpoint-context
version: 1
scope: "packages/project-mounting-manager/**"
status: active
---

# Project Mounting Manager Context

## Past

Project specialist, workflow, MCP, and watcher behavior first lived inside the root application's Mastra Code runtime. Direct Code SDK and host registration dependencies made the mounting behavior difficult to reuse safely from another host.

## Present

This package owns project specialist and workflow discovery, explicit workflow-tool publication, generation state, diagnostics, resource watching, and the transactional mounting facade. Its root Interface exposes deep contract, discovery, and manager Modules. Host-specific model lookup, MCP connections, current tool enumeration, and registry mutation enter through ports defined by the contract Module.

### Workflow layout

A dynamic workflow may span several TypeScript files. The sanctioned layout is a flat entrypoint plus a helper subdirectory:

```text
.mastracode/workflow/
├── flow.ts        # entrypoint: default-exports a committed Workflow, optionally exports agentTool
└── steps/         # helpers, bundled into the entrypoint
    ├── one.ts
    └── two.ts
```

Every file directly in `.mastracode/workflow` is an entrypoint and must default-export a committed Mastra Workflow; a flat helper beside the entrypoint fails that check and takes down the whole generation, including specialists and MCP, so the failure now names this layout. Subdirectories are never entrypoints. Relative imports are bundled into the entrypoint rather than externalized, so editing a helper changes the entrypoint's generation hash and the workflow reloads. Declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are skipped. This layout is a convention enforced by the loader, not a manifest; do not add a second project manifest to describe it.

Containment covers every bundled file, not only the entrypoint. Relative and absolute specifiers are checked against the project root before esbuild reads them, and every bundled input is realpath-checked after the build, so a helper that is a symlink out of the project is rejected too. Bare specifiers are externalized and resolved from the importing file's own directory first, then the entrypoint's, then this package's; TypeScript `paths` aliases are not resolved, because an alias like `@steps/foo` is indistinguishable from a package name at this layer.

### Reserved host tools

`publishedTools` is the single merge point that feeds both project specialists and the host bridge, and the two are siblings rather than parent and child: specialists are built from `publishedTools` directly, while `getTools()` returns `{ ...publishedTools, project_specialist }`. A host-side filter over the bridge therefore cannot restrict what specialists can call, and an unrestricted specialist — one whose frontmatter has no `tools:` key — receives every published tool.

A host tool ID that a project must not shadow *and* must not call is declared through `reservedToolIds`, not `currentTools`. Reserved IDs are claimed before any snapshot is merged, so a project workflow whose tool ID collides is still rejected, while the tool itself never becomes publishable. Everything passed through `currentTools` is published to unrestricted specialists; that port is for tools the project is genuinely allowed to use. A specialist that names a reserved ID fails the generation as reserved rather than as an unknown tool.

### Recorded asymmetries

Loading a project workflow executes the entrypoint's top-level module code in the MCode host process at discovery time, with no approval prompt and no sandbox. Only the subsequent *run* is gated by tool approval. Factory takes the opposite position: its sandbox runner requires approval before even listing workflows, precisely because listing loads project code. Multi-file authoring widens the amount of code an entrypoint can pull in without a reviewer seeing it in one file. Containment now bounds *where* that code may come from, but not *whether* it runs. Closing the asymmetry means either sandboxing host-side discovery or gating it behind approval, and remains open.

Compiled bundles are written to one unversioned shared temp directory (`<tmpdir>/rlabs-project-workflows`) under a name derived from the entrypoint basename and a content hash. Two projects with a same-named workflow of identical content therefore share one compiled file, and stale bundles are never cleaned up. Neither is exploited by current behavior, since the hash covers the bundle bytes, but both are unowned.

## Future

Studio, local Code, and Factory adapters can share this mounting contract while retaining their own lifecycle and policy. Cross-project scheduling and a new project manifest remain outside this boundary. Host-side discovery approval or sandboxing, and a per-project versioned compilation cache with eviction, are the two known open items above.
