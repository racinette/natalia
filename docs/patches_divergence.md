# Patches — divergence (docs/ ↔ REFACTOR.MD ↔ src/types)

> Parked working note. Goal: decide the canonical API for patches, then reconcile all three sources. No source is authoritative yet.

## Three-source status
- **docs/patches.md**: `patches: { name: boolean }` slot on `defineWorkflow`; read in body via `await ctx.patches.<name>` → `boolean`; read-only (no setter); awaitable read (flush then resolve), usable inside `ctx.scope`. Explicitly distinguishes the `ctx.patches` versioning primitive from "patch + replay" (the operator halt-resolution op). Matches code.
- **REFACTOR.MD (no dedicated Part)**: Specifies patches in two scattered, distinct senses — (a) the `patch` / `patch_check` **awaitable read** in the execution model (Part 1 operation table line 108; Part 8 step catalog `patch_check`, line 1621; "receiveNowait and patch trigger buffer flushes", lines 127/3286), and (b) **"patch + replay"** as a halt-resolution operator action (Part 3 lines 25/485/574, Part 1 line 25). Uses the word *patch* for both without flagging the overload.
- **src/types (impl)**: Implemented. `PatchDefinitions = Record<string, boolean>` (primitives.ts:54); `PatchAccessor = AtomicResult<boolean>` (primitives.ts:70); `patches` slot on `WorkflowDefinition` (workflow-definition.ts:122) and `ctx.patches` on `BaseContext` (context-interfaces.ts:88); exercised in regression test 13 (`await ctx.patches.patchAlpha`, including inside a scope). Matches docs.

## Divergences
| # | Topic | docs/ says | REFACTOR.MD says | src/types has | Direction |
|---|-------|-----------|------------------|---------------|-----------|
| 1 | Terminology overload | Explicitly separates the `ctx.patches` primitive (a versioning gate) from "patch + replay" (redeploy-and-resume halt resolution); says "Keep them distinct" | Uses *patch* for BOTH meanings — the `patch_check` awaitable read AND the "patch + replay" halt-resolution action — without disambiguating | Code has no naming collision: the primitive is `PatchDefinitions`/`PatchAccessor`/`patch_check`; halt-resolution is described in `engine.ts` `HaltsNamespaceExternal` comments as "patch + replay" only | docs ahead (only docs disambiguates) |
| 2 | Replay flip semantics | Defers the precise `true→false` flip rule for a not-yet-reached patch check to "the execution model" (a parked note, not the primitive surface) | Part 1/8 give the `patch_check` mechanics (awaitable read, flush-before-read, recorded decision) but do not pin the flip-while-replaying rule either | Type surface only (`AtomicResult<boolean>`); no runtime flip-rule encoded in types | aligned-but-unspecified (all three defer) |

API/signature surface (`Record<string, boolean>` definition, `await ctx.patches.<name>` → `boolean`, read-only, awaitable-read flush semantics, scope availability) is otherwise consistent across all three sources.

## Open API decisions (for later)
- [ ] Rename one of the two "patch" meanings to kill the overload REFACTOR carries (e.g. keep `patches`/`patch_check` for the versioning primitive; rename operator "patch + replay" to "redeploy + replay" or similar) — docs already pushes for this.
- [ ] Pin the canonical `true→false` flip rule for a replaying instance that has not yet reached the patch check, and decide whether it belongs in the patches doc or the execution-model doc.
