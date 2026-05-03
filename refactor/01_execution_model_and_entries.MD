# 01 Execution Model and Entries

## Goal

Establish the execution model framing from `REFACTOR.MD` Part 1 in the type
surface, and remove the legacy call-builder types so that workflow operations
are exposed as simple awaitable entries.

This step is the type-system foundation. It does **not** specify call-time
options (timeouts, retries, priorities — see step 03), structured-concurrency
shapes (see step 07), the database schema (see step 10), or compensation
mechanics (see step 08). It only establishes:

1. The entry-shape contract: `StepEntry<T>`, `RequestEntry<T>`,
   `WorkflowEntry<T>` are opaque awaitable brands over `T`.
2. The four operation categories — buffered, dispatched, awaitable wait,
   awaitable read — are named in the spec; their type-level signatures
   reflect the buffered-op vs entry-creating distinction (`void` synchronous
   vs `AwaitableEntry<T>`).
3. The legacy call-builder types are no longer part of the public surface.

## Source Coverage

- `REFACTOR.MD` Part 1: Execution Model (1.1 – 1.8).
- `REFACTOR.MD` Part 5: "What disappears" table for the removed call-builder
  / handle types.
- `REFACTOR.MD` Summary of Public API Changes: "Removed call types and
  methods" subsection.

## What survives from the old VEL framing

The previous "Virtual Event Loop" framing dissolves with branches. Without
multiple concurrent execution paths inside a single workflow body, there is
no scheduler to coordinate, no advisory lock to serialise, and no
"interleaving" to make deterministic. Five concrete properties of the
execution engine survive, independently:

1. **Single sequential body.** A workflow body is a single sequential
   `async` function. Concurrency comes from dispatched entries (steps,
   requests, attached child workflows) the body has dispatched but not yet
   awaited. The body never forks.
2. **Durable replay.** Every dispatched entry, awaitable wait, and buffered
   operation is recorded with an ordinal in the body's execution log
   (storage shape: step 10). On replay, the same code reaches the same
   recorded operations in the same order and observes their recorded
   results in the same order. The engine returns recorded results to each
   operation it sees on replay; only operations with no recorded result
   block.
3. **Batched commitment.** Between two suspension points, the body may
   invoke any number of buffered operations and dispatch zero or more
   entries. The engine accumulates them in memory and commits them in a
   single database transaction at the next suspension point. Atomicity:
   either the entire batch commits or none of it does. Replay safety: a
   re-execution that reaches the same suspension point sees the same
   committed batch and does not re-emit external work.
4. **Promise sequencing.** When several dispatched entries may complete
   simultaneously, the body must observe their completions in a
   deterministic order across replays. Each entry's promise records a
   `sequence_no` per workflow body on resolution, and `ctx.match` /
   `ctx.join` deliver completions in `sequence_no` order.
5. **Compensation as a sibling workflow.** Each execution workflow is paired
   at start time with a sibling base compensation workflow. Compensation
   block instances are child workflows of the base compensation workflow,
   not a parallel execution lane inside the workflow body. The execution
   model in this Part is identical for execution workflows, base
   compensation workflows, and compensation block instances — they are all
   sequential bodies with dispatched entries. Step 08 elaborates the
   compensation lifecycle.

Step 01 verifies (1) and the entry-shape consequence of (2) at the type
level. The other survivors are runtime guarantees verified at the
runtime-test layer (see "Runtime coverage" below).

## Operation categories

Operations a workflow body invokes fall into four categories. The type-level
distinction step 01 makes is between "buffered ops return `void`
synchronously" and "dispatched / awaitable-wait ops produce
`AwaitableEntry<T>`." Awaitable reads return a resolved value (or
`PromiseLike<T>` whose resolution does not depend on a dispatched entry).

| Category           | Examples (exact API surface lives in later steps)                                                                                           | Type-level shape                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Buffered           | `stream.write`, `event.set`, `attribute.set`, `queue.enqueue`, `topic.publish`, `channels.X.send`, `startDetached`                          | Synchronous, returns `void`                   |
| Dispatched         | `ctx.steps.X(...)`, `ctx.requests.X(...)`, `ctx.childWorkflows.X(...)`                                                                      | Returns `StepEntry<T>` / `RequestEntry<T>` / `WorkflowEntry<T>` |
| Awaitable wait     | `channel.receive`, `sleep`, `sleepUntil`                                                                                                    | Returns `BlockingResult<T>` (awaitable)       |
| Awaitable read     | `channel.receiveNowait`, `patch`                                                                                                            | Returns `AtomicResult<T>` (awaitable; resolves immediately after a buffer flush) |

`BlockingResult` and `AtomicResult` are existing internal awaitable shapes
that do not expose the deprecated `.resolve(ctx)` builder method.
`AwaitableEntry<T>` is the public-facing brand.

## Step type catalog (named, not specified)

REFACTOR.MD Part 8.7 enumerates the persisted `step.type` values:
`start_step`, `start_child_workflow`, `send_request`, `await_promise`,
`execute_scope`, `sleep`, `sleep_until`, `channel_receive`,
`channel_receive_nowait`, `patch_check`, `stream_write`, `event_set`,
`attribute_set`, `register_compensation_instance`,
`promote_compensation_instance`, `queue_enqueue`, `topic_publish`,
`channel_send`, `start_detached`. Step 10 (database schema) is the canonical
source for this catalog and its persistence shape. Step 01 only references
the catalog to motivate the operation-category split.

The legacy `start_branch` step type does not appear in this catalog.

## Public API target

- `StepEntry<T>`, `RequestEntry<T>`, `WorkflowEntry<T>` extend
  `AwaitableEntry<T>`, which extends `PromiseLike<T>`. They are opaque
  brands; user code should not construct them.
- Direct `await` on an entry suspends the body until the dispatched work
  completes; the awaited value is the entry's `T`.
- Buffered operations on the workflow context (`ctx.streams.X.write`,
  `ctx.events.X.set`, `ctx.queues.X.enqueue`, etc.) return `void`
  synchronously.
- The following types are removed from the public surface:
  - `DurableHandle` and `AtomicResult` as call-builder bases.
  - `StepCall<T, ...>` and the chained generic parameters
    (`Called`, `TFail`, `TTimeout`, `HasCompensation`, `Tctx`).
  - `WorkflowCall`, `WorkflowCallResult`.
  - `RequestCall`.
  - `ScopeCall`, `FirstCall`.
  - `CompensationStepCall`, `CompensationWorkflowCall`.
- The `.resolve(ctx)`, `.retry(...)`, `.timeout(...)`, `.failure(...)`,
  `.complete(...)`, `.compensate(...)`, `.priority(...)` builders are no
  longer present on operation accessors. Their semantic replacements live
  in steps 03 (call-time options), 07 (scope orchestration), and 08
  (compensation).

`AtomicResult` as a *non-public* internal awaitable shape for awaitable
reads (`receiveNowait`, `patch`) survives — it is not exported on
`src/types.ts`. The same applies to `BlockingResult` for awaitable waits.

## Out of scope (deferred)

| Topic                                                                                  | Step that owns it |
| -------------------------------------------------------------------------------------- | ----------------- |
| Call-time options (`{ retry, timeout, priority }`)                                     | 03                |
| Timeout return-union shape (`{ ok: true; result } \| { ok: false; status: "timeout" }`) | 03                |
| `StepBoundary` numeric/Date/object forms                                                | 03                |
| Scope orchestration (`ctx.scope`, `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, `ctx.some`) | 07            |
| `ctx.join`, `ctx.match` semantics                                                       | 07                |
| Attached child entry `channels.X.send` surface                                          | 03 (alongside child-call options) |
| `startDetached` returning `ForeignWorkflowHandle<W>`                                    | 03                |
| Compensation block instances and `register_compensation_instance` step type            | 08                |
| Database schema for steps and promises                                                  | 10                |

## Affected areas

- `src/types/context/call-builders.ts` — drop `StepCall`, `WorkflowCall`,
  `RequestCall`, `ScopeCall`, `FirstCall`, `CompensationStepCall`,
  `CompensationWorkflowCall`, `WorkflowCallResult`. Keep
  `ChildWorkflowAccessor`, `RequestAccessor`,
  `CompensationChildWorkflowAccessor`, `ForeignWorkflowAccessor`,
  `ForeignWorkflowHandle`, `ChildWorkflowStartOptions` and friends.
- `src/types/context/deterministic-handles.ts` — drop public `DurableHandle`
  and `AtomicResult` re-exports. The internal awaitable bases (`BlockingResult`)
  remain for awaitable waits inside the context interfaces.
- `src/types.ts` — drop the call-builder re-exports.
- `src/types/context/entries.ts` — already canonical for `AwaitableEntry`,
  `StepEntry`, `RequestEntry`, `WorkflowEntry`.

## Acceptance contract

The paired file `src/types-regression-tests/01_execution_model_and_entries.ts`
is the type-level acceptance test. It verifies:

1. `StepEntry<T>` / `RequestEntry<T>` / `WorkflowEntry<T>` are subtypes of
   `AwaitableEntry<T>`, which extends `PromiseLike<T>`.
2. `await ctx.steps.X(args)` resolves to the step's declared result type.
3. Buffered operations (`stream.write`, `event.set`, queue/topic publish,
   `channels.X.send`) return `void` synchronously and do not produce
   `AwaitableEntry`s.
4. The removed call-builder types are not exported from `../types`.
5. The removed entry methods (`.resolve`, `.retry`, `.complete`, `.failure`,
   `.compensate`) are not present on entries.

## Runtime coverage (out of scope for this step)

The following properties cannot be verified at the type level and must be
covered by runtime/integration tests:

- Durable replay: same code, same recorded results, same observed order.
- Batched commitment: atomicity + replay safety.
- Promise sequencing for deterministic `match` / `join` order.
- Awaitable reads flushing the buffer before observing committed state.
- Compensation block instance dispatch from the base compensation workflow
  (covered by step 08's runtime tests).
