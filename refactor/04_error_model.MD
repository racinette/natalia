# 04 Error Model

## Goal

Introduce a typed local error model for workflows and branches. Business failures should be declared on the definition that can throw them, created through `ctx.errors`, and surfaced as serializable error values.

## Source Coverage

- `REFACTOR.MD` Part 4: Error Model.
- `REFACTOR.MD` Part 6: context isolation.
- `REFACTOR.MD` Part 7: branch definitions and branch-local errors.
- `REFACTOR.MD` summary: new `errors`, `ExplicitError`, `ErrorValue`, and `FailureInfo` exports.

## Public API Target

- `defineWorkflow({ errors })` declares workflow-local errors.
- Branch definitions can declare their own local `errors`.
- `ctx.errors.X(message, details?)` creates throwable `ExplicitError` values for errors visible in the current context.
- Workflow code cannot throw branch-only errors.
- Branch code cannot throw workflow-only errors unless that error is explicitly declared in the branch dependency surface.
- `ErrorValue<TErrorDefinitions>` is the serializable external representation.
- `Failure` is the base captured-throw record used where an arbitrary branch or handler throw is observed.

## Runtime Target

- Throwing an `ExplicitError` terminates the current workflow or branch with a typed business failure.
- External callers receive decoded error details, not raw JavaScript errors.
- Non-explicit thrown values are captured as `Failure` records according to the shared extraction rules.
- Compensation code reports typed outcomes by return value rather than by throwing declared compensation errors.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/results.ts`
- `src/types/engine.ts`
- `src/workflow.ts`
- Runtime error serialization and external result mapping.

## Acceptance Contract

The paired file `refactor/04_error_model.ts` verifies `ctx.errors` inference, local error isolation, `ExplicitError` / `ErrorValue` shapes, decoded details, and external result error unions.
