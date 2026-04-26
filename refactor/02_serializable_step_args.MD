# 02 Serializable Step Args

## Goal

Make step invocations schema-backed and observable. Steps should accept one serializable argument object, persist that object with the step record, and expose a decoded argument object to `execute` and compensation callbacks.

## Source Coverage

- `REFACTOR.MD` Part 18: Serializable Step Arguments.
- `REFACTOR.MD` Part 2: step compensation receives original typed args and observed forward outcome.
- `REFACTOR.MD` summary: `defineStep.schema` is renamed to `result`, `args` is required, and positional step calls disappear.

## Public API Target

- `defineStep` requires `args` and `result` schemas.
- `defineStep` no longer accepts `schema`.
- `execute({ signal }, args)` receives `StandardSchemaV1.InferOutput<TArgs>`.
- Step call sites accept `StandardSchemaV1.InferInput<TArgs>`.
- Step results are typed as `StandardSchemaV1.InferOutput<TResult>`.
- Every step invocation is object-shaped: `ctx.steps.bookFlight({ destination, passengerId })`.
- Positional step calls are rejected.

## Persistence Target

- Step records persist serialized args in JSONB.
- Failed attempts and compensation info can expose the original typed step args.
- The engine keeps the encode-on-write / decode-on-read discipline used by workflows, channels, streams, requests, queues, and topics.

## Affected Areas

- `src/workflow.ts`
- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/helpers.ts`
- Step persistence and replay code.
- Existing examples under `src/examples`.
- Existing type regression tests under `src/types-regression-tests`.

## Acceptance Contract

The paired file `refactor/02_serializable_step_args.ts` verifies the new step definition shape, input/output inference, transform-friendly typing, and rejection of old `schema` and positional call sites.
