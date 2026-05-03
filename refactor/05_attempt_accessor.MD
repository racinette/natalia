# 05 Attempt Accessor

## Goal

Unify attempt inspection across every retried-operation context:
steps, queue handlers, request handlers, topic consumers, and the
`attempts` field exposed on `CompensationInfo` /
`RequestCompensationInfo`.

The legacy step-specific `StepErrorAccessor` becomes a generic
`AttemptAccessor`. The captured-throw record is split into a base
`Failure` (no attempt number) and a retried-operation `Attempt extends
Failure` (with a 1-indexed `attempt` number).

`AttemptError` becomes the throwable class handler code uses to attach
structured, JSON-serializable details to a failure.

## Source Coverage

- `REFACTOR.MD` Part 15: AttemptAccessor Refactoring.
- `REFACTOR.MD` Part 2: compensation `info.attempts` exposes retry
  history when a forward operation timed out or was terminated.
- `REFACTOR.MD` Part 11: `RequestCompensationInfo.attempts` for
  request compensation.
- `REFACTOR.MD` Summary of Public API Changes — "Attempts and
  serializable args" subsection.

## Public API Target

### Names

- `StepErrorAccessor` → `AttemptAccessor`. The old name is removed
  from the public surface.

### Records

```typescript
interface Failure {
  readonly startedAt: Date;
  readonly failedAt: Date;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
}

interface Attempt extends Failure {
  readonly attempt: number; // 1-indexed
}
```

- `Failure` is the base shape; it has no `attempt` field.
- `Attempt` extends `Failure` with the 1-indexed attempt number.
- All error fields are nullable because JavaScript can throw any
  value, including throws that have no message, no type, and no
  details.

### Accessor

```typescript
interface AttemptAccessor {
  last(): Promise<Attempt>;
  all(): Promise<Attempt[]>;
  count(): Promise<number>;
  [Symbol.asyncIterator](): AsyncIterableIterator<Attempt>;
  reverse(): AsyncIterable<Attempt>;
}
```

- `count` is an async **method**, not a property — fully lazy
  interface.
- `[Symbol.asyncIterator]()` and `reverse()` are async-iterable for
  forward / reverse iteration.

### Throwable

```typescript
class AttemptError extends Error {
  readonly type: string | null;
  readonly details: JsonInput | undefined;

  constructor(options?: {
    type?: string | null;
    message?: string | null;
    details?: JsonInput;
  });
}
```

- `details` is typed as `JsonInput` at the throw site so non-JSON
  values (Set, Map, class instances) are rejected at compile time.
- Used by step `execute`, queue handlers, request handlers, topic
  consumers. The engine persists `type` / `message` / `details`
  directly when an `AttemptError` is caught; non-`AttemptError`
  throws fall back to the extraction rules in Part 15.

### Engine extraction rules (runtime; out of scope for the type test)

| Thrown value             | `type`                                       | `message`        | `details`           |
| ------------------------ | -------------------------------------------- | ---------------- | ------------------- |
| `AttemptError` instance  | `.type`                                      | `.message`       | `.details`          |
| `ExplicitError` instance | `"ExplicitError"` (or `null`)                | `.message`       | `{ code, details }` |
| `Error` instance         | `.constructor.name`                          | `.message`       | `null`              |
| `string`                 | `null`                                       | the string       | `null`              |
| anything else            | `null`                                       | `String(thrown)` | `null`              |

## Affected Areas

- `src/types/results.ts` — `Failure`, `Attempt`, `AttemptAccessor`,
  `AttemptError` already aligned.
- `src/workflow.ts` — `AttemptError` re-exported from
  `./types/results`.

## Acceptance Contract

The paired file `src/types-regression-tests/05_attempt_accessor.ts`
verifies:

1. `Failure` is constructible without an `attempt` field.
2. `Attempt extends Failure` and includes a 1-indexed
   `attempt: number`.
3. The `Attempt` record exposes the documented fields with the
   documented nullability.
4. `AttemptAccessor` exposes `last() / all() / count() / iteration /
   reverse()` with the documented signatures.
5. `count` is async-callable; using it as a numeric property is
   rejected.
6. `AttemptError` is constructible with optional
   `{ type, message, details }` and is structurally an `Error`
   subclass.
7. `AttemptError` rejects non-JSON `details` at compile time.
8. `AttemptError` is usable inside a step `execute`.
9. `StepErrorAccessor` is no longer part of the public type surface.

## Out of Scope (Deferred)

- Acquiring an `AttemptAccessor` instance from a real attempt log —
  step 12 (introspection) wires the operator handles that expose
  it.
- Compensation `info.attempts` typing on `CompensationInfo` and
  `RequestCompensationInfo` — already aligned in `src/types`, fully
  exercised by `compensation_model.ts` (step 08).
- Queue / request / topic handler registration shapes — steps 13,
  14, 15.
- `MANUAL` and `UnrecoverableError` for handler early termination —
  step 17.
