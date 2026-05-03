# 06 Context Isolation

## Goal

Make every workflow body and compensation `undo` callback see only the
dependencies and primitives it has explicitly declared. Definition-time
filtering removes whole categories of cross-context coupling at compile
time.

## Source Coverage

- `REFACTOR.MD` Part 6: Context Isolation.
- `REFACTOR.MD` Part 2: per-step compensation primitive isolation; no
  shared compensation namespace; definition-time filtering against
  compensable dependencies.
- `REFACTOR.MD` Part 4: workflow `ctx.errors` versus compensation
  `undo` (no `ctx.errors`; outcomes via the optional `result` schema).

## Public API Target

### Two definition contexts

| Primitive / dependency | Workflow body                    | Step compensation `undo`                                |
| ---------------------- | -------------------------------- | ------------------------------------------------------- |
| `ctx.steps`            | workflow's declared steps         | only `compensation.steps` (non-compensable)             |
| `ctx.requests`         | workflow's declared requests      | only `compensation.requests` (non-compensable)          |
| `ctx.childWorkflows`   | workflow's declared childWorkflows| only `compensation.childWorkflows`                      |
| `ctx.queues`           | workflow's declared queues        | only `compensation.queues` (step 13)                    |
| `ctx.topics`           | workflow's declared topics        | only `compensation.topics` (step 15)                    |
| `ctx.channels`         | workflow instance channels        | per-instance compensation block channels (step 08)      |
| `ctx.streams`          | workflow instance streams         | per-instance compensation block streams (step 08)       |
| `ctx.events`           | workflow instance events          | per-instance compensation block events (step 08)        |
| `ctx.attributes`       | workflow instance attributes      | per-instance compensation block attributes (step 08)    |
| `ctx.errors`           | workflow's declared errors        | **absent** — use the optional `result` schema instead   |

The workflow body cannot read or write compensation block primitives, and
a compensation block cannot read or write workflow body primitives.
Coordination across the boundary, when needed, must use a global
primitive (queue, topic, request, child workflow).

### Definition-time dependency filtering

Compensation block dependencies must not themselves be compensable.

- `compensation.steps` rejects steps with `compensation:` set.
- `compensation.requests` rejects requests with `compensation: true | { ... }`.
- `compensation.childWorkflows` is exempt — each child workflow owns
  its own internal compensation lifecycle.
- `compensation.queues` and `compensation.topics` (step 13 / 15) have
  no compensable variant to filter against.

This prevents recursive compensation chains: a compensation block
cannot spawn more compensation blocks via its declared step or request
dependencies.

## Affected Areas

- `src/types/definitions/steps.ts` — `StepCompensationDefinition`'s
  `steps` and `requests` are typed as `NonCompensableStepDefinitions` /
  `NonCompensableRequestDefinitions`.
- `src/types/context/context-interfaces.ts` — `WorkflowContext` and
  `CompensationContext` carry the per-context dependency surfaces.
  `CompensationContext` has no `errors` field.

## Acceptance Contract

The paired file `src/types-regression-tests/06_context_isolation.ts`
verifies:

1. A compensation `undo` sees the steps and requests declared under
   its compensation block — and only those.
2. A compensation `undo` does not see the workflow body's steps,
   requests, or other primitives.
3. A compensation `undo` has no `ctx.errors`.
4. A compensable step is rejected as a `compensation.steps`
   dependency.
5. A compensable request is rejected as a `compensation.requests`
   dependency.
6. A workflow body sees its declared steps, requests, and `errors`.
7. A workflow body cannot reference an undeclared error code on
   `ctx.errors`.
8. Removed surfaces (`ctx.state`, `ctx.addCompensation`) stay
   removed.

## Out of Scope (Deferred)

- Per-instance compensation primitives
  (channels/streams/events/attributes declared on `compensation`)
  — step 08.
- The full primitive-table verification across both contexts —
  step 08 wires up per-instance primitives; this step only verifies
  the workflow-vs-compensation boundary as it stands today.
- Compensation block instance external query handles — step 12.
