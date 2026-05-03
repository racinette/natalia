# 07 Scopes

## Goal

Establish structured concurrency over the new entry family. A scope
dispatches a top-level object of typed unstarted entries, hands the body
a typed mirror of that object where each entry has been replaced with a
joinable handle, and lets the body await selectively via `ctx.join`,
`ctx.match`, or the convenience helpers (`ctx.all`, `ctx.first`,
`ctx.atLeast`, `ctx.atMost`, `ctx.some`).

The workflow body is a single sequential program (step 01). Concurrency
exists only between dispatched entries — there is no second sequential
thread inside the body to interleave. Without branches, scopes are
purely a structured-ownership boundary plus a typed handle bag.

## Source Coverage

- `REFACTOR.MD` Part 7: Scopes and Structured-Concurrency Consumption.
- `REFACTOR.MD` Part 1.1, 1.7: workflow body sequencing; nested scopes.
- `REFACTOR.MD` Part 1.5: deterministic promise sequencing for `match`
  / `join`.
- `REFACTOR.MD` Summary of Public API Changes — "Structured
  concurrency" subsection.

## Public API Target

### Entry family

A scope entry is one of:

- `StepEntry<T>` — produced by `ctx.steps.X(args, opts?)`.
- `RequestEntry<T>` — produced by `ctx.requests.X(payload, opts?)`.
- `AttachedChildWorkflowEntry<W, T>` — produced by
  `ctx.childWorkflows.X(startOpts, opts?)`.

All three are awaitable brands over `T` (`AwaitableEntry<T>` from step 01).

`startDetached(opts)` is a buffered op that returns a
`ForeignWorkflowHandle<W>` synchronously. **It is not a scope entry**;
attempting to pass it to `ctx.scope` / `ctx.all` / etc. is rejected at
compile time.

Inline async closures are **not** scope entries either — scopes consume
typed unstarted entries, not arbitrary async functions.

### Scope input shape

Scope input is always a top-level object. Each top-level property may be:

- a single entry,
- an array / tuple of entries, or
- a `ReadonlyMap<K, entry>` of entries.

The body callback receives a typed mirror of that object where each
entry has been replaced with its corresponding handle:

- `Entry → Handle (AwaitableEntry<T>)`
- `Entry[]` → `Handle[]`
- `ReadonlyMap<K, Entry>` → `ReadonlyMap<K, Handle>`

### `ctx.scope(name, entries, body)`

- Named (the first arg is the scope name).
- Top-level object input, top-level handle bag in the body.
- Body returns `R`; the scope itself returns `AwaitableEntry<R>`.

### `ctx.join(handle)` and `ctx.join(handle, { timeout })`

- `ctx.join(handle)` observes one leaf handle and returns its full
  flattened outcome. Plain step / request entries return their success
  type directly. Attached child workflows return the success-or-failure
  union (and timeout variant when an entry-level timeout is set).
- `ctx.join(handle, { timeout })` is an **observation timeout** — it
  races this wait only. It does not cancel, terminate, fail, or
  compensate the underlying work. The same handle can be joined again
  later. Observation timeouts add a separate `{ ok: false; status:
  "join_timeout" }` variant, distinct from any operation-level timeout.

Workflow code never observes `"halted"` or `"skipped"` as a join
outcome. A halted entry pauses workflow code; a skipped entry is
observed as a normal successful result on replay.

### `ctx.match(handles)`

- Async iterable yielding events keyed by top-level object property.
- For array / tuple properties, the event also carries `index`.
- For map properties, the event also carries `mapKey`.
- **No handler form.** Failure recovery happens in ordinary code by
  inspecting the awaited entry's union (per Part 4).

### Convenience helpers

| Helper                                | Strategy                                                                  | Success                                                          | Failure (when structurally possible)                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.all(name, entries)`              | wait for every entry to succeed                                           | `{ ok: true; result: ScopeSuccessResults<E> }` (input shape)     | `{ ok: false; error: { code: "SomeEntriesFailed"; ... } }`                                                                                    |
| `ctx.first(name, entries)`            | return the first successful entry; compensate the unconsumed              | `{ ok: true; result: KeyedSuccess<E> }`                           | `{ ok: false; error: { code: "NoEntryCompleted"; ... } }`                                                                                     |
| `ctx.atLeast(name, n, entries)`       | wait until at least `n` entries succeed                                   | `{ ok: true; result: KeyedSuccess<E>[] }` (≥ n)                   | `{ ok: false; error: { code: "QuorumNotMet"; ... } }`                                                                                         |
| `ctx.atMost(name, n, entries)`        | return up to `n` successful entries; compensate the unconsumed            | `KeyedSuccess<E>[]` (≤ n)                                         | none                                                                                                                                          |
| `ctx.some(name, entries)`             | return as many successful entries as possible                             | `KeyedSuccess<E>[]` (possibly empty)                              | none                                                                                                                                          |

The error `code` strings (`SomeEntriesFailed`, `NoEntryCompleted`,
`QuorumNotMet`) reflect the entry-based vocabulary. The legacy names
(`SomeBranchesFailed`, `NoBranchCompleted`) are removed from the public
surface.

## Affected Areas

- `src/types/context/scope-results.ts` — entry / handle / keyed-result
  shapes; `SomeEntriesFailed`, `NoEntryCompleted`, `QuorumNotMet`,
  `MatchEvent`, `MatchEvents`.
- `src/types/context/context-interfaces.ts` —
  `WorkflowContext.scope/all/first/atLeast/atMost/some/join/match`
  signatures, mirrored on `WorkflowConcurrencyContext`,
  `CompensationContext`, `CompensationConcurrencyContext`.
- `src/types/context/entries.ts` — `AwaitableEntry`,
  `JoinTimeoutResult`, `JoinOptions`.

## Acceptance Contract

The paired file `src/types-regression-tests/07_scopes.ts` verifies:

1. `ctx.scope(name, entries, body)` accepts a top-level object whose
   properties are entries, arrays of entries, or maps of entries.
2. The scope body callback receives a typed mirror handle bag.
3. `ctx.join(handle)` returns the success type for plain step / request
   entries, and the success-or-failure union for child workflow entries.
4. `ctx.join(handle, { timeout })` adds the `join_timeout` variant
   without removing the underlying success/failure shape.
5. Workflow code never observes `halted` or `skipped` as a join outcome.
6. Inline async closures are rejected as scope entries.
7. Detached child workflow handles (`startDetached` returns) are
   rejected as scope entries.
8. Tuple properties produce match events with `index`; map properties
   produce match events with `mapKey`.
9. `ctx.match` has no handler-form overload.
10. `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, `ctx.some`
    accept an explicit scope name and the same top-level-object input
    structure; their failure-side types use the new error codes
    (`SomeEntriesFailed`, `NoEntryCompleted`, `QuorumNotMet`).
11. Removed public names (`BranchEntry`, `BranchHandle`,
    `BranchAccessor`, `MAIN_BRANCH`, `SomeBranchesFailed`,
    `NoBranchCompleted`) are not exported.

## Out of Scope (Deferred)

- Compensation block instances and their own scope-orchestration body
  — step 08.
- Operator-action verbs (`sigkill`, `sigterm`, `skip`) and halt
  resolution — step 09.
- The persistence layout for `execute_scope` step rows and
  `step.parent_step_id` self-references — step 10.
- External introspection of scope entries (`workflowInstance.compensations.<step>.findUnique`,
  `workflowInstance.attachedChildWorkflows.<name>.findUnique`) — step 12.
