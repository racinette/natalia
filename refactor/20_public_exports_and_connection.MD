# 19 Public Exports And Connection

## Goal

Finish the refactor by making the public barrel match the new API and exposing opaque connection/transaction types for client and engine operations.

## Source Coverage

- `REFACTOR.MD` summary: new exports and removed exports.
- `REFACTOR.MD` final connection and transaction model.
- All earlier parts that introduce new public types.

## Public API Target

- Export new definition helpers: `defineQueue`, `defineRequest`, `defineTopic`, and branch helpers if they are public.
- Export shared query types: `SearchQueryNode`, `SearchQuery`, and aliases used by workflow, queue, topic, and request APIs.
- Export attempt and error types: `AttemptAccessor`, `Failure`, `Attempt`, `AttemptError`, `ExplicitError`, `ErrorValue`, `FailureInfo`.
- Export compensation and request compensation types and handles.
- Export `StepBoundary`, `MAIN_BRANCH`, branch path item types, `MANUAL`, `UnrecoverableError`, `Unsubscribe`, `TopicRecord`, `ScheduledDeliveryOptions`, `RetentionSetter`, `IWorkflowConnection`, and `IWorkflowTransaction`.
- Remove old public types and errors: `WorkflowError`, `StepTimeoutError`, `StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`, `DurableHandle`, `AtomicResult`, old timeout/failure callback info, and old compensation result closure-info types.
- Client and engine CRUD-style APIs accept optional `txOrConn?: IWorkflowTransaction | IWorkflowConnection`.

## Affected Areas

- `src/index.ts`
- `src/types.ts`
- `src/types/*`
- Client and engine public method signatures.
- Package documentation and examples.

## Acceptance Contract

The paired file `refactor/20_public_exports_and_connection.ts` verifies the final export set, absence of removed exports, and optional transaction/connection parameters on external APIs.
