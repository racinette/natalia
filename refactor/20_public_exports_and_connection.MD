# 20 Public Exports And Connection

## Goal

Finish the refactor by making the public barrel match the new API and exposing operator session types for client and engine operations.

## Source Coverage

- `REFACTOR.MD` summary: new exports and removed exports.
- `REFACTOR.MD` Part 19: operator session model.
- All earlier parts that introduce new public types.

## Public API Target

- Export new definition helpers: `defineQueue`, `defineRequest`, `defineTopic`, and branch helpers if they are public.
- Export shared query types: `SearchQueryNode`, `SearchQuery`, and aliases used by workflow, queue, topic, and request APIs.
- Export attempt and error types: `AttemptAccessor`, `Failure`, `Attempt`, `AttemptError`, `ExplicitError`, `ErrorValue`, `FailureInfo`.
- Export compensation and request compensation types and handles.
- Export `StepBoundary`, `MAIN_BRANCH`, branch path item types, `MANUAL`, `UnrecoverableError`, `Unsubscribe`, `TopicRecord`, `ScheduledDeliveryOptions`, `RetentionSetter`, `OperatorSession`, `SessionCapabilities`, `StorageDriver`, and `InferSessionRaw`.
- Do **not** export test-only mock driver helpers (`MockStorageDriver` lives under `src/types-regression-tests/`).
- Remove old public types and errors: `WorkflowError`, `StepTimeoutError`, `StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`, `DurableHandle`, `AtomicResult`, old timeout/failure callback info, and old compensation result closure-info types.
- `WorkflowClient<TWfs, TDriver>` is constructed with a **required** `StorageDriver`. Snapshot/command operator IO takes `session` as the first argument.

## Affected Areas

- `src/index.ts`
- `src/types.ts`
- `src/types/*`
- Client and engine public method signatures.
- Package documentation and examples.
- [`docs/operator-sessions.md`](../docs/operator-sessions.md)

## Acceptance Contract

The paired file `refactor/20_public_exports_and_connection.ts` verifies the final export set, absence of removed exports, and session-first operator IO on external APIs.
