# 07 Branches And Scopes

## Goal

Move structured concurrency to predefined, isolated branch definitions and generalized entry consumption.

## Source Coverage

- `REFACTOR.MD` Part 7: Branches, Scopes, and Structured-Concurrency Consumption.
- `REFACTOR.MD` Part 1: nested scopes and branch interleaving.
- `REFACTOR.MD` Part 4: branch-local errors.

## Public API Target

- `defineWorkflow({ branches })` declares reusable branch definitions.
- `ctx.branches.X(args)` creates an unstarted branch entry.
- `ctx.scope(name, entries, body)` is directly awaitable.
- Scope input is always a top-level object whose properties can be single entries, tuples/arrays of entries, or maps of entries.
- `ctx.join(handle, opts?)` observes one branch and can time out without cancelling the branch.
- Externally skipped branch instances are observed by workflow code as successful results; `skipped` is an external query status, not a workflow-facing join outcome.
- `ctx.match(handles)` is an async iterable keyed by top-level object properties; tuple/array properties add `index`, and map properties add `mapKey`.
- Handler forms on `ctx.match` are removed; failure recovery happens in normal code.
- Convenience APIs exist for `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, and `ctx.best`.
- Branch instances are externally queryable and can report `complete`, `failed`, `running`, `halted`, or `skipped` as appropriate.

## Affected Areas

- `src/types/context.ts`
- `src/types/definitions.ts`
- `src/types/results.ts`
- Runtime branch/scope scheduling and persistence.
- Existing concurrency examples and regression tests.

## Acceptance Contract

The paired file `refactor/07_branches_and_scopes.ts` verifies branch definition inference, top-level object scope input, tuple/map property entries, `join` and `match` result shapes, removed inline branch closures, and failure/status unions.
