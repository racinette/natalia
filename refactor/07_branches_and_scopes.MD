# 07 Branches And Scopes

## Goal

Move structured concurrency to predefined, isolated branch definitions and generalized entry consumption.

## Source Coverage

- `REFACTOR.MD` Part 7: Branches, Scopes, and Structured-Concurrency Consumption.
- `REFACTOR.MD` Part 1: nested scopes and branch interleaving.
- `REFACTOR.MD` Part 4: branch-local errors.

## Public API Target

- `defineWorkflow({ branches })` declares reusable branch definitions.
- `ctx.branches.X(args, opts?)` creates an unstarted branch entry; `{ timeout }` adds a workflow-facing `{ ok: false, status: "timeout" }` variant for that branch invocation.
- `ctx.scope(name, entries, body)` is directly awaitable.
- Scope input is always a top-level object whose properties can be single entries, tuples/arrays of entries, or maps of entries.
- Step entries, request entries, attached child workflow entries, and branch entries are valid scope entries; detached child workflow starts are buffered operations and are not scope entries.
- `ctx.join(handle, opts?)` observes one handle and can time out without cancelling the underlying work; observation timeouts use the separate `join_timeout` status.
- Externally skipped branch instances are observed by workflow code as successful results; `skipped` is an external query status, not a workflow-facing join outcome.
- `ctx.match(handles)` is an async iterable keyed by top-level object properties; tuple/array properties add `index`, and map properties add `mapKey`.
- Handler forms on `ctx.match` are removed; failure recovery happens in normal code.
- Convenience APIs exist for `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, and `ctx.some`; each takes an explicit scope name as its first argument.
- Convenience APIs are success-oriented. `ctx.all` returns `{ ok: true, result }` preserving the input object shape, or `{ ok: false, error }` with `code: "SomeBranchesFailed"`. `ctx.first` and `ctx.atLeast` return flat keyed success arrays/results, or helper-level `code` failures (`"NoBranchCompleted"` / `"QuorumNotMet"`). `ctx.atMost` and `ctx.some` return flat keyed success arrays and have no failure cases.
- Branch instances are externally queryable and can report `complete`, `failed`, `running`, `halted`, or `skipped` as appropriate.

## Affected Areas

- `src/types/context.ts`
- `src/types/definitions.ts`
- `src/types/results.ts`
- Runtime branch/scope scheduling and persistence.
- Existing concurrency examples and regression tests.

## Acceptance Contract

The paired file `src/types-regression-tests/branches_and_scopes.ts` verifies branch definition inference, top-level object scope input, tuple/map property entries, named convenience scopes, flat convenience helper result/error shapes, call-time timeout result shapes for steps, requests, child workflows, and branches, detached child workflow exclusion, `join` and `match` result shapes, removed inline branch closures, and failure/status unions.
