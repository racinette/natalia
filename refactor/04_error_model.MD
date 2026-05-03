# 04 Error Model

## Goal

Establish the typed business-error surface for workflows and the discipline
under which thrown errors are handled in different definition contexts.
Workflow code declares its business failures on `defineWorkflow.errors` and
throws them via `ctx.errors.X(message, details?)`. External callers receive
typed `ErrorValue<TErrors>` payloads.

Failures from dispatched entries (steps, requests, child workflows) are
**returned values, not thrown** — Part 4 keeps the workflow-author throw
site narrow on purpose.

## Source Coverage

- `REFACTOR.MD` Part 4: Error Model.
- `REFACTOR.MD` Part 6: Context Isolation (compensation `undo` has no
  `ctx.errors`).
- `REFACTOR.MD` Part 3: Per-context throw rules table (workflow body and
  scope body share `ctx.errors`; compensation `undo` has none).
- `REFACTOR.MD` Summary of Public API Changes — "Errors" subsection.

## Public API Target

### Definition

- `defineWorkflow({ errors })` declares workflow-local business errors as
  a map from code → `JsonSchemaConstraint | true`.
- `true` declares a code with no details payload.
- `JsonSchemaConstraint` declares a code whose details payload is
  validated and decoded by the schema.
- Workflow headers (`defineWorkflowHeader`) accept the same `errors`
  field for cross-package surfaces.

### Context

- The workflow body's `ctx.errors.X(...)` is a factory map that produces
  throwable `ExplicitError` instances typed for each declared code.
- The scope body's `ctx.errors` is **the same factory map as the
  parent workflow body** — there is no scope-local error namespace.
- Compensation `undo` has **no** `ctx.errors`. Compensation reports
  outcomes through its optional `result` schema.

### Throw rules (per Part 3 and Part 4)

| Context                 | Recognised failure throws                | Anything else            |
| ----------------------- | ---------------------------------------- | ------------------------ |
| Workflow `execute` body | `ctx.errors.X(...)` from workflow errors | execution halt           |
| Scope body              | parent body's `ctx.errors.X(...)`        | execution halt           |
| Compensation `undo`     | none; typed return values model outcomes | compensation block halt  |

### External shape

- `ExplicitError<TCode, TDetails>` is the throwable class produced by
  `ctx.errors.X(...)`. Users do not subclass or construct it.
- `ErrorValue<TErrors>` is the serializable external union, carrying the
  `type: "ExplicitError"` discriminator so external callers can tell
  declared business failures apart from arbitrary captured throws.
- `FailureInfo<TWorkflowErrors> = ErrorValue<TWorkflowErrors>` is the
  alias used in external workflow result unions.

### Failures from dispatched entries

- Step / request timeouts come back as `{ ok: false; status: "timeout" }`
  on the awaited entry (step 03).
- Child workflow failures come back as
  `{ ok: false; status: "failed"; error: ErrorValue<TChildErrors> }` on
  the awaited entry. The body decides whether to translate them into a
  workflow-level failure via `throw ctx.errors.X(...)`.

### `Failure` base record

`Failure` is the base record for a captured non-explicit throw on a
retried operation's attempt log. It is also the base shape that
`Attempt extends Failure` extends (step 05). It is not workflow-facing
as a throw type — there is no longer any "any-throw becomes Failure"
mode.

## Affected Areas

- `src/types/results.ts` — `ErrorValue` carries the `type:
  "ExplicitError"` discriminator. `ExplicitError`, `Failure`,
  `FailureInfo` already aligned.
- `src/types/definitions/errors.ts` — `ErrorDefinition`,
  `ErrorDefinitions`, `WorkflowErrorDefinitions` already aligned.
- `src/types/context/context-interfaces.ts` — `ErrorFactories<TErrors>`
  produces typed `ExplicitError` factories on `ctx.errors`.
- `src/workflow.ts` — `validateErrorDefinitions` runtime check.

## Acceptance Contract

The paired file `src/types-regression-tests/04_error_model.ts` verifies:

1. `defineWorkflow.errors` accepts schema-valued and `true`-valued codes.
2. `ctx.errors.X(message, details?)` produces a typed `ExplicitError`
   factory at the workflow body level.
3. Unknown error codes are rejected at compile time.
4. Details must match the declared schema input; `true`-valued errors
   reject any details argument.
5. The scope body's `ctx.errors` is the **same** factory map as the
   parent body — typing identity holds across the boundary.
6. Child workflow failures come back as a returned union with
   `error: ErrorValue<TChildErrors>` carrying the `type:
   "ExplicitError"` discriminator.
7. `ErrorValue<TErrors>` external shape carries the four expected
   fields: `type`, `code`, `message`, `details`.
8. `FailureInfo<TErrors>` equals `ErrorValue<TErrors>`.
9. `Failure` does not require an `attempt` field.
10. Compensation `undo` has no `ctx.errors`.

## Out of Scope (Deferred)

- Per-context halt resolution and operator-action verbs (`sigkill`,
  `sigterm`, `skip`) — step 09.
- The `Attempt` record and `AttemptError` throwable for handler-side
  retry diagnostics — step 05.
- Compensation-block per-instance `result` schema as the outcome
  reporting channel — step 08.
- Detailed compensation-context shape (no `ctx.errors`, dependency
  filtering) — step 06 and step 08.
