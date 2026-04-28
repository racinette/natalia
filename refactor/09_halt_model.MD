# 09 Halt Model

## Goal

Specify per-context throw rules and halt status unions. Halt observation/skip
APIs are deferred to the introspection refactor (`12_introspection`).

## Source Coverage

- `REFACTOR.MD` Part 3: Halt Model.
- `BUFFER.MD` §7: Halts in Compensation Are Skippable.
- `BUFFER.MD` §15: branch halt status.

## Public API Target

- `WorkflowHaltStatus = "pending" | "resolved"` — execution halts are not
  skippable.
- `CompensationBlockHaltStatus = "pending" | "resolved" | "skipped"` —
  compensation block halts are skippable per instance.
- `BranchHaltStatus = "pending" | "resolved" | "skipped"` — branch halts are
  skippable per instance.
- The per-context throw rules from `REFACTOR.MD` Part 3 are reflected in the
  shape of `ctx.errors` at each definition level:
  - workflow body → `ctx.errors` exposes the workflow's declared errors.
  - branch with `errors: "none"` (or omitted) → `ctx.errors` is empty.
  - branch with `errors: "any"` → `ctx.errors` is empty (any throw becomes a
    captured `Failure` at the parent consumption point).
  - branch with explicit `errors` map → `ctx.errors` exposes the branch's
    declared errors only; cross-level access is rejected.
  - compensation `undo` → there is no `ctx.errors` at all.
- Workflow-facing consumption surfaces (`ctx.join`, `ctx.match`, the convenience
  helpers) **never** observe `"halted"` or `"skipped"` as an outcome variant —
  workflow code is paused while a branch is halted, and a skipped branch is
  observed as a normal successful result on replay.

## Out Of Scope (Deferred To `12_introspection`)

- Halt record reads.
- `findUnique`/`findMany` over halted branches and compensation block
  instances.
- The operator `skip(...)` API on branch and compensation block instance
  handles.

## Affected Areas

- `src/types/results.ts` (halt status unions only).
- `src/types/context/context-interfaces.ts` (compensation undo has no
  `ctx.errors`; branch contexts respect the error mode).
- `src/types/definitions/errors.ts` (branch error mode → empty `ctx.errors`).

## Acceptance Contract

The paired file `refactor/09_halt_model.ts` verifies:

1. The three halt status unions match the schema constants exactly (no `open`,
   no `terminated`, no `skipped` on workflow execution halts).
2. Branch error modes `"none"` and `"any"` produce an empty `ctx.errors`, and
   any `ctx.errors.X(...)` call inside such branches is rejected at compile
   time.
3. Compensation `undo` callbacks do not expose `ctx.errors`; any
   `ctx.errors.X(...)` reference inside `undo` is rejected.
4. `BranchJoinResult<T>` does not include `"halted"` or `"skipped"` variants.
5. Convenience helper return shapes (`ctx.first` / `ctx.atLeast` /
   `ctx.atMost` / `ctx.some`) likewise do not surface `"halted"` or
   `"skipped"` per branch.
