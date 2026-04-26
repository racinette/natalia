# 08 Compensation Model

## Goal

Move compensation from call-site builder chains to operation definitions and make compensation invocations observable, typed, and replayable as compensation block instances.

## Source Coverage

- `REFACTOR.MD` Part 2: Compensation Model Redesign.
- `REFACTOR.MD` Part 18: serializable step args.
- `REFACTOR.MD` Part 15: compensation attempt access.
- Summary compensation breaking changes.

## Public API Target

- Step definitions can declare `compensation`.
- Request definitions can declare `compensation`.
- Compensation blocks declare their own context dependencies.
- `undo(ctx, args, info)` receives decoded original args and typed forward outcome information.
- Compensation reports outcomes by returning discriminated values, not by throwing declared compensation errors.
- `ctx.addCompensation` is removed.
- `.compensate(...)` call builders are removed.
- Compensation block instances are queryable through grounded handles, not through stale in-memory closures.

## Runtime Target

- A compensable forward operation creates or promotes a compensation block instance when an attempt may have produced side effects.
- Compensation has its own VEL root.
- Compensation block lifecycle is durable and externally inspectable.
- Compensation block halts can be skipped independently by operators.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/results.ts`
- Step/request runtime execution.
- Compensation persistence and external query APIs.

## Acceptance Contract

The paired file `refactor/08_compensation_model.ts` verifies definition-bound compensation, typed `undo` args/info, result unions, context isolation inside compensation, removed call-site compensation, and queryable compensation handle types.
