# 08 Compensation Model

## Goal

Move compensation from call-site builder chains to operation definitions and make compensation invocations observable, typed, and replayable as compensation block instances.

## Source Coverage

- `REFACTOR.MD` Part 2: Compensation Model Redesign.
- `REFACTOR.MD` Part 18: serializable step args.
- `REFACTOR.MD` Part 15: compensation attempt access.
- Summary compensation breaking changes.

## Public API Target

- Step definitions can declare `compensation` blocks with isolated dependencies.
- Step compensation `undo(ctx, args, info)` receives decoded original args and typed forward outcome information.
- Request definitions can declare compensation with `compensation: true` or `compensation: { result }`.
- Request compensation handlers are registered separately with `registerRequestCompensationHandler(definition, handler, options)`.
- Request compensation handlers receive `(ctx, payload, info)`, may return a typed result, and may return `MANUAL`.
- Compensation reports expected outcomes by returning discriminated values, not by throwing declared compensation errors.
- Compensation dependencies reject compensable steps and compensable requests to avoid recursive compensation chains.
- `ctx.addCompensation`, workflow-level `beforeCompensate` / `afterCompensate`, and `.compensate(...)` call builders are removed.
- Compensation block instances are queryable through grounded handles, not through stale in-memory closures. The handle/query surface itself is specified in `12_introspection`.

## Runtime Target

- A compensable forward operation creates or promotes a compensation block instance when an attempt may have produced side effects.
- Compensation has its own VEL root.
- Compensation block lifecycle is durable and externally inspectable.
- Compensation block halts can be skipped independently by operators.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/workflow.ts`
- `src/index.ts`
- `src/types/results.ts`
- Step/request runtime execution.
- Compensation persistence and external query APIs.

## Acceptance Contract

The paired file `refactor/08_compensation_model.ts` verifies definition-bound step compensation, request compensation declaration plus separate handler registration, typed step `undo` args/info, typed request compensation payload/info, outcome narrowing, `MANUAL` and `onExhausted.callback`, dependency isolation, rejection of compensable compensation dependencies, and removed ad hoc/workflow/call-site compensation APIs. The grounded compensation block handle and its result/skip query surface are verified in `refactor/12_introspection.ts`.
