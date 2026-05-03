# 02 Serializable Step Args

## Goal

Make step invocations schema-backed and observable. Steps accept one
serializable argument object, persist that object with the step record, and
expose a decoded argument object to `execute` and to compensation callbacks.

## Source Coverage

- `REFACTOR.MD` Part 18: Serializable Step Arguments.
- `REFACTOR.MD` Part 2: step compensation receives the original typed args
  alongside the observed forward outcome (`info`).
- `REFACTOR.MD` Summary of Public API Changes — "Attempts and serializable
  args" subsection.

## Public API Target

- `defineStep` requires both `args` and `result` schemas.
- `defineStep` no longer accepts `schema` (renamed to `result`).
- `execute({ signal }, args)` receives `StandardSchemaV1.InferOutput<TArgs>`
  — the *decoded* args.
- Step call sites accept `StandardSchemaV1.InferInput<TArgs>` — the *encoded*
  args. For schemas without a transform, input and output are identical.
- Step results are typed as `StandardSchemaV1.InferOutput<TResult>` for
  callers and `StandardSchemaV1.InferInput<TResult>` for the implementer's
  return type.
- Every step invocation is object-shaped:
  `ctx.steps.bookFlight({ destination, passengerId })`.
- Positional step calls are rejected at compile time.

## Persistence Target (runtime; out of scope for the type-level test)

- Step records persist serialized args in JSONB on the step row.
- Failed-attempt records and compensation `info` can expose the original
  typed step args.
- The engine keeps the encode-on-write / decode-on-read discipline already
  used by workflows, channels, streams, requests, queues, and topics.

The runtime persistence is verified by integration tests, not by this
step's type-level acceptance contract.

## Affected Areas

- `src/workflow.ts` — `defineStep` signature requires `args` and `result`.
- `src/types/definitions/steps.ts` — `StepDefinition<TArgs, TResult, TComp>`.
- `src/types/context/entries.ts` — `StepAccessor` accepts `SchemaInvocationInput<TArgs>`.

## Acceptance Contract

The paired file `src/types-regression-tests/02_serializable_step_args.ts`
verifies:

1. `defineStep` accepts an `args` schema and a `result` schema.
2. `execute({ signal }, args)` receives `InferOutput<TArgs>`.
3. The legacy `schema:` field is rejected at compile time.
4. The `args` field is required at compile time.
5. Call sites accept `InferInput<TArgs>` and reject positional args.
6. Missing required props are rejected.
7. `await ctx.steps.X(args)` resolves to `InferOutput<TResult>`.
8. The definition retains its `args` and `result` schemas for introspection.

## Out of Scope (Deferred)

- Compensation `undo(ctx, args, info)` receiving typed args is fully
  exercised by step 08's compensation acceptance test
  (`src/types-regression-tests/compensation_model.ts`).
- Per-attempt failure records exposing the original args belong to step 05
  (AttemptAccessor) and step 12 (introspection) — they cannot be type-tested
  in isolation without those steps' surfaces.
