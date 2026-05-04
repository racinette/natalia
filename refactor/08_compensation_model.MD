# 08 Compensation Model

## Goal

Move compensation from call-site builder chains to operation
definitions and make compensation invocations observable, typed, and
replayable as compensation block instances.

A compensable step's compensation declaration carries:

- **per-instance primitives** (channels, streams, events, attributes
  — each block instance gets its own private set);
- **declared dependencies** (non-compensable steps and requests, plus
  queues, topics, and child workflows; child workflows are exempt
  from the non-compensable filter because each child owns its own
  compensation lifecycle);
- an optional **`result`** outcome schema;
- the **`undo`** body, which receives the original step args (decoded)
  and the forward operation's outcome `info`.

A compensable request declaration carries `compensation: true` or
`compensation: { result }` only — the actual handler is registered
**separately** via `registerRequestCompensationHandler`. There is no
inline `undo` on `defineRequest`.

A compensation block instance is a child workflow of the execution
workflow's sibling base compensation workflow (`REFACTOR.MD` Part 1.6
and Part 8). Each invocation gets its own externally addressable id
(`CompensationId<TStep>`).

## Source Coverage

- `REFACTOR.MD` Part 2: Compensation Model Redesign.
- `REFACTOR.MD` Part 1.6: compensation as a sibling workflow.
- `REFACTOR.MD` Part 4: compensation `undo` has no `ctx.errors`;
  outcomes via the optional `result` schema.
- `REFACTOR.MD` Part 11: request compensation registration.
- `REFACTOR.MD` Part 15: `CompensationInfo.attempts` /
  `RequestCompensationInfo.attempts`.

## Public API Target

### `defineStep.compensation`

```typescript
interface StepCompensationDefinition<...> {
  // Per-instance primitives.
  channels?:       { [name: string]: JsonSchemaConstraint };
  streams?:        { [name: string]: JsonSchemaConstraint };
  events?:         { [name: string]: true };
  attributes?:     { [name: string]: JsonSchemaConstraint };

  // Declared dependencies.
  steps?:          { [name: string]: NonCompensableStepDefinition };
  requests?:       { [name: string]: NonCompensableRequestDefinition };
  queues?:         { [name: string]: QueueDefinition };
  topics?:         { [name: string]: TopicDefinition };
  childWorkflows?: { [name: string]: WorkflowDefinition };

  // Optional outcome schema.
  result?: TResultSchema;

  // Compensation body.
  undo: (
    ctx: CompensationContext<...>,
    args: InferOutput<TArgsSchema>,
    info: CompensationInfo<InferOutput<TForwardResultSchema>>,
  ) => Promise<TResultSchema extends ... ? InferInput<TResultSchema> : void>;
}
```

The accessor surface for `channels`, `streams`, `events`,
`attributes`, `queues`, `topics` lands incrementally with their own
steps (13 / 15 / 16). Step 08 establishes the **declaration slots**
on `StepCompensationDefinition` and wires `channels` / `streams` /
`events` / `steps` / `requests` / `childWorkflows` through the
existing `CompensationContext` shape.

### `defineRequest.compensation`

```typescript
type RequestCompensationDefinition<TResultSchema> =
  | true
  | { result?: TResultSchema };
```

Inline `undo` is rejected. Handlers register separately:

```typescript
registerRequestCompensationHandler(
  definition,
  async (ctx, payload, info) => { ... return MANUAL; },
  { retryPolicy: { ... }, onExhausted?: { callback, retryPolicy } },
);
```

The handler signature receives `(ctx, payload, info)` where `info` is
`RequestCompensationInfo<TResponse>`.

### `CompensationInfo<TResult>`

```typescript
type CompensationInfo<TResult> =
  | { status: "completed"; result: TResult; attempts: AttemptAccessor }
  | { status: "timed_out"; reason: "attempts_exhausted" | "deadline"; attempts: AttemptAccessor }
  | { status: "terminated"; attempts: AttemptAccessor };
```

`timed_out` and `terminated` do not mean "no work was done" — only
that the engine never observed completion. Compensation must inspect
attempts when needed.

### `CompensationId<TStep>`

```typescript
type CompensationId<TStep> = string & {
  readonly __brand: "CompensationId";
  readonly __step: TStep;
};
```

Branded so ids from different compensable steps are not
interchangeable at the type level. The full query handle / row /
namespace shape is step 12's surface.

### Removed surfaces

- `.compensate(cb)` on call builders (also removed by step 01).
- `ctx.addCompensation(cb)` general LIFO cleanup registration.
- `beforeCompensate` / `afterCompensate` workflow-level hooks.

### Dependency filtering

- `compensation.steps` rejects compensable step definitions.
- `compensation.requests` rejects compensable request definitions.
- `compensation.childWorkflows` is exempt — each child workflow owns
  its own internal compensation lifecycle.

## Affected Areas

- `src/types/definitions/steps.ts` — `StepCompensationDefinition`
  expanded to 12 generic parameters: args / forward-result /
  channels / streams / events / attributes / steps / requests /
  queues / topics / childWorkflows / result.
- `src/types/definitions/primitives.ts` — `AttributeDefinitions`
  added.
- `src/types/results.ts` — `CompensationId<TStep>` brand exported.
- `src/types/definitions/requests.ts` —
  `RequestCompensationDefinition`, `RequestCompensationConfig`
  (already aligned).
- `src/workflow.ts` — `defineStep` overload extended to forward the
  new generic parameters; runtime validation for `compensation`
  unchanged at this step (declaration-only fields don't require new
  validation paths).

## Acceptance Contract

The paired file `src/types-regression-tests/08_compensation_model.ts`
verifies:

1. `defineStep.compensation` accepts per-instance primitives
   (channels / streams / events / attributes), dependencies (steps /
   requests / queues / topics / childWorkflows), and an optional
   `result` schema.
2. The `undo` callback receives `(ctx, args, info)` with `args` typed
   as the step's `InferOutput<TArgsSchema>` and `info` typed as
   `CompensationInfo<InferOutput<TForwardResultSchema>>`.
3. `info.status === "completed"` exposes `result`; `"timed_out"` and
   `"terminated"` do not — `info.result` access on those branches is
   rejected.
4. `info.attempts` is available on every variant.
5. `ctx.errors` is absent in `undo`.
6. Compensation's `ctx` cannot see workflow-only steps / requests
   (covered by step 06; reasserted here).
7. Compensable steps and compensable requests are rejected as
   `compensation.steps` / `compensation.requests` dependencies.
8. `defineRequest.compensation` accepts `true` or `{ result }` only;
   inline `undo` is rejected.
9. `registerRequestCompensationHandler(definition, handler, options)`
   accepts a compensable request and a typed handler.
10. The handler may return `MANUAL` directly or via `onExhausted`.
11. `registerRequestCompensationHandler` rejects non-compensable
    requests at compile time.
12. `CompensationId<TStep>` is a branded string type and ids from
    different compensable steps are not interchangeable.
13. Removed call-site / workflow-level compensation surfaces stay
    rejected (`.compensate(...)`, `ctx.addCompensation`,
    `beforeCompensate`).

## Out of Scope (Deferred)

- Full accessor surfaces for the new compensation primitives:
  - per-instance attributes accessors — step 16.
  - per-instance queue / topic enqueue / publish accessors —
    steps 13 / 15.
  - external introspection of compensation block instances — step
    12 (where `CompensationId` becomes the addressing key).
- Compensation block scheduling lifecycle (eager FIFO at settle
  decisions, LIFO unwind on workflow failure) — runtime; step 10
  carries the persistence shape (`register_compensation_instance`,
  `promote_compensation_instance` step types).
- Halt resolution on compensation block instances (`skip(result)`
  with the per-block semantics) — step 09.
