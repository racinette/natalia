# New Primitives — Implementation Plan

> **This document is authoritative.** It represents the finalized design of all new primitives and architectural changes to the durable workflow engine. It supersedes all prior design sketches, open questions from earlier iterations, and conversation artifacts. Every concept described here has been through iterative review and explicit confirmation. Implementation should follow this document as its source of truth.

## Overview

This document describes primitives, architectural changes, and corrections to the public API of the durable workflow engine. It is written as a task description for an implementing agent.

The changes are organized into two categories:

**New primitives** — additions to the engine's capability:

1. **Queues** — global competing-consumer work queues
2. **Requests** — global typed request-response with external handler resolution
3. **Topics** — global ordered per-topic append logs with named consumers
4. **Attributes** — workflow-instance-bound observable single current value
5. **Streams extension** — non-blocking read variant on the external handle
6. **Search query refactoring** — generalize `WorkflowSearchQueryBuilder` into `SearchQuery<TNamespaces>`
7. **Scheduled delivery** — `delay`/`scheduledAt` option on queue message enqueue and workflow starts

**Architectural changes** — corrections and redesigns to existing engine behavior:

8. **Virtual Event Loop (VEL)** — deterministic concurrent execution model
9. **Compensation model redesign** — parallel compensation VEL, eager/deferred separation, structured compensation lifecycle
10. **Halt model** — unified soft failure mechanism for unexpected exceptions
11. **Error model** — schema-only error definitions, `ctx.errors` factories, explicit vs accidental failure distinction
12. **Step timeout unification** — `maxAttempts` moves from retry policy to `.timeout()` builder
13. **AttemptAccessor refactoring** — rename `StepErrorAccessor` → `AttemptAccessor`, rename `StepExecutionError` → `Attempt`, introduce `AttemptError` throwable class, unify attempt record shape, make `count()` async
14. **Context splitting** — separate primitive instances for execution and compensation VELs
15. **Convenience scope methods** — `ctx.best()`, `ctx.atMost()`, `ctx.atLeast()`, `ctx.joinSafe()`
16. **Database schema** — unified tree model for execution and compensation
17. **`idempotencyKeyFactory`** — derive idempotency keys from workflow args, make `idempotencyKey` required
18. **Serializable step arguments** — `args` schema on `defineStep`, single object arg pattern, full observability

---

## Motivation

### The instance-bound limitation

Every existing primitive is scoped to a specific workflow instance. Channels receive messages sent to a known instance. Streams write output for a specific instance. Events are flags on a specific instance. This is appropriate for most workflow coordination, but it creates a hard boundary: workflows cannot participate in system-wide coordination without knowing each other's identities.

This boundary becomes a problem for two emerging classes of use cases.

**Agentic workloads.** An agent workflow may reach a point where it genuinely cannot proceed without external input — human intervention, a specialized service, or another agent. Today, the only way to model this is via channels (the caller must know the agent's instance ID and send a message directly) or via steps (the workflow owns the implementation). Neither fits. Channels require tight coupling between caller and agent. Steps require the workflow author to know and own the implementation, which defeats the purpose of delegation.

What is needed is a primitive where a workflow can post a typed request into a shared resolution space and block until whoever can fulfill it does so, without knowing or caring who that is.

**Cross-workflow event streaming.** Today, streams are per-instance output logs. There is no way for multiple workflows to publish to a shared ordered log, and no way for external consumers to subscribe to a filtered stream of events across all instances. This matters for audit trails, event sourcing, and triggering downstream systems without direct coupling.

### Why existing primitives do not cover these cases

| Need                             | Why existing primitives fall short                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global work queue                | Channels are instance-bound; you must know the target. No competing-consumer semantics exist.                                                                  |
| Delegated typed request-response | Steps require the workflow author to own the implementation. Foreign workflow channels require knowing the target instance and cannot return a typed response. |
| Global ordered event log         | Streams are per-instance. No multi-producer, multi-consumer, offset-tracked log exists.                                                                        |
| Observable current value         | Streams retain full history (expensive). Events are write-once flags with no value. Nothing models "current state" with change notification.                   |

### Why the compensation model needs a redesign

The current compensation model defers all callbacks to the LIFO unwind that happens during workflow failure or termination. A successfully completing workflow never triggers compensation.

This is incorrect for one important class of case: a step (or request) that was attempted but failed, where the failure was caught with `.timeout()`. Consider a POST endpoint that processes the request and records the side effect, but fails to send a response and returns 500. The step is marked failed from the workflow's perspective. The workflow catches the failure with `.timeout({ maxAttempts: 3 }, () => null)` and continues. The external system has the side effect. The workflow completes successfully. The compensation callback never runs.

This leaves ghost side effects that are never cleaned up in successful workflows. The fix requires a fundamental rethinking: compensation must be separated into **eager** (triggered at failure time, running in a parallel execution context) and **deferred** (LIFO unwind on workflow failure). This distinction, combined with a parallel compensation Virtual Event Loop, allows the main workflow to complete and return results while compensations run in the background.

### Why the execution model needs formalization

Concurrent execution within a workflow requires a deterministic scheduling model to guarantee replayability. The Virtual Event Loop (VEL) formalizes how branches are ordered, when context switches occur, and how promise resolution is sequenced. Without this formalization, concurrent compensation, scope exit behavior, and the interaction between execution and compensation phases cannot be specified precisely.

---

## Part 1: Virtual Event Loop (VEL)

The Virtual Event Loop is the core mechanism for deterministic, replayable concurrent execution within a workflow instance.

### Database representation

The execution tree is built from four primitives:

- **`branch`** — a sequential execution path. Root branches have no parent scope (`scope_id IS NULL`) and serve as VEL entry points.
- **`scope`** — a structured concurrency boundary. Created by an `execute_scope` step.
- **`step`** — an engine-level operation within a branch. The replayable durable execution action.
- **`promise`** — a resolution token for blocking steps. Until resolved (successfully or with failure), the step does not complete.

A scope has branches. A branch has sequential steps. A step may have a promise. Multiple branches may reference the same promise (via `await_promise` steps), enabling shared-result semantics where different branches block on the same underlying resolution.

### Execution algorithm

The VEL executes all branches within a scope until every branch is blocked, then **batches** all accumulated step records into a single transaction before dispatching any side-effecting work. The order in which concurrent branches are interleaved within a batch round is an implementation detail — workflow logic must never rely on it.

1. **Non-concurrent code** executes as-is. Sequential operations within a single branch need no scheduling.

2. **Entering a scope** transitions to structured concurrency. The scope body is treated as a branch with a synthetic key (`MAIN_BRANCH`). Concurrent branches are the named entries in the scope definition.

3. **Branch identity** is encoded as a `readonly BranchPathItem[]` key path representing the full nested scope lineage. Each item is `{ scope: string; branch: string | typeof MAIN_BRANCH }`, where `MAIN_BRANCH` is a module-level `unique symbol` export. For a scope `"A"` with branches `"foo"` and `"bar"`:

   ```typescript
   declare const MAIN_BRANCH: unique symbol;

   [{ scope: "A", branch: MAIN_BRANCH }]   // ← scope body
   [{ scope: "A", branch: "bar" }]
   [{ scope: "A", branch: "foo" }]
   ```

4. **Branch execution.** Each branch executes until it reaches a blocking point (Tier 1 start, Tier 1 await, or Tier 2 await). The order in which the engine interleaves concurrent branches is an **implementation detail** and must not be relied upon. The only guarantee is that the interleaving is deterministic across replays — the same code produces the same step ordinals within each branch.

5. **Buffered operations** are synchronous calls that do not trigger context switches. They buffer step records in memory without writing to the database. Stream writes, event sets, attribute sets, queue enqueues, topic publishes, foreign channel sends, compensation registrations, detached workflow starts — all execute inline within the current branch and do not yield.

6. **Tier 2 operations** (`channel.receive`, `sleep`) block on external resolution. The engine buffers a step and promise record, then context-switches to the next branch.

7. **Tier 1 operations** (steps, child workflows, requests) require two-phase execution:
   - **Start phase**: buffer a `start_step` / `start_child_workflow` / `send_request` step record and a promise. Context-switch. The actual work is NOT started yet.
   - **Await phase**: buffer an `await_promise` step referencing the created promise. Context-switch.

8. **Awaitable reads** (`channel.receiveNowait`, `patch`) require database state to make a decision. These trigger a **flush**: the accumulated buffer is committed in a batch transaction, then the read is executed against the committed state. The branch continues with the result.

9. **Batch commit.** When all branches are blocked, the engine commits the entire accumulated buffer of step records in a **single transaction**. Only after the commit does the engine start the actual side-effecting work: step coroutines, child workflow dispatches, request dispatches. This batching ensures atomicity (the batch fully commits or doesn't) and efficiency (fewer DB round-trips).

10. **Promise resolution fetch.** All branches are blocked and all work has been dispatched. Fetch resolved promises from the database. Each promise records a `sequence_no` on resolution, assigned from a Postgres sequence protected by a per-VEL advisory lock. This ensures deterministic ordering: no two promises from the same VEL can resolve with the same or out-of-order sequence numbers.

11. **Resume.** Take the first resolved promise by sequence number. Resume the branch that was blocked on it. Execute until the next blocking point. Continue with the next resolved promise if available.

12. **Continue.** If no more resolved promises are available, fetch again. The cycle continues until the scope body returns or all branches complete.

### Important: no reliance on branch execution order

**Workflow logic must never depend on the order in which concurrent branches execute within a scope.** Branches in a scope are logically concurrent — they share no mutable state, and the order in which they reach their blocking points does not affect the outcome. Any workflow that behaves differently depending on branch interleaving order is incorrectly designed. The engine guarantees deterministic replay, but the specific interleaving is an implementation detail subject to change.

### Buffered vs awaitable operations

| Category         | Operations                                                                                                                   | Behavior                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Buffered**     | `stream.write`, `event.set`, `attribute.set`, `queue.enqueue`, `topic.publish`, `channel.send` (foreign), `registerCompensation`, `compensateEagerly`, `startDetached` | Synchronous. Buffers step record in memory. No context switch.        |
| **Tier 2 await** | `channel.receive`, `sleep`, `sleepUntil`                                                                                     | Buffers step + promise. Context-switches. Blocks until resolution.    |
| **Tier 1 start** | `steps.X(...)`, `childWorkflows.X.start(...)`, `requests.X(...)`                                                             | Buffers step + promise. Context-switches. Work starts after batch commit. |
| **Tier 1 await** | `.resolve(ctx)` on a Tier 1 handle                                                                                           | Buffers `await_promise`. Context-switches. Blocks until resolution.   |
| **Awaitable read** | `channel.receiveNowait`, `patch`                                                                                           | Triggers buffer flush. Reads from committed state. No context switch. |

### Nested scopes

Nested scopes exist on the same VEL — they do not create separate VELs. When a nested scope is entered, its branches are added to the set of active branches. Each branch is identified by its full key path:

```typescript
await ctx
  .scope("A", { foo, bar }, async (ctx, { foo, bar }) => {
    await ctx
      .scope("B", { baz, fuz }, async (ctx, { baz, fuz }) => {
        // ...
      })
      .resolve(ctx);
  })
  .resolve(ctx);
```

When scope `"A"` is entered, three branches exist:

```typescript
[{ scope: "A", branch: MAIN_BRANCH }]
[{ scope: "A", branch: "bar" }]
[{ scope: "A", branch: "foo" }]
```

When scope `"A"`'s main branch enters scope `"B"`, the branch set expands:

```typescript
[{ scope: "A", branch: MAIN_BRANCH }]                                          // blocked (entered scope B)
[{ scope: "A", branch: MAIN_BRANCH }, { scope: "B", branch: MAIN_BRANCH }]
[{ scope: "A", branch: MAIN_BRANCH }, { scope: "B", branch: "baz" }]
[{ scope: "A", branch: MAIN_BRANCH }, { scope: "B", branch: "fuz" }]
[{ scope: "A", branch: "bar" }]
[{ scope: "A", branch: "foo" }]
```

All six branches are part of the same VEL. The engine executes them in an implementation-defined order until all are blocked, then commits the batch.

### Implementation note: possible interleaving strategies

The specific order in which the engine interleaves concurrent branches is an implementation detail. Some possible strategies:

- **Round-robin**: cycle through branches one blocking point at a time (`1→2→3→1→2→3`). Ensures uniform progress.
- **Depth-first**: run each branch to completion or blocking before moving to the next. Simpler to implement.
- **Main-branch-first**: always execute the scope body before concurrent branches. Allows the scope body to short-circuit early.

All strategies produce the same batch of step records (same ordinals within each branch, same set of promises). The choice affects debugging traces and performance characteristics, not correctness. Workflow logic must never rely on any specific strategy.

### Two VELs per workflow

Each workflow instance has exactly two independent VELs:

1. **Execution VEL** — runs the main workflow logic. Rooted at `workflow.execution_branch_id`.
2. **Compensation VEL** — runs all compensation work (eager and deferred). Rooted at `workflow.compensation_branch_id`.

Both VELs are created at workflow start time. The compensation VEL may remain empty if no compensations are registered. Each VEL has its own advisory lock namespace for promise resolution sequencing, ensuring complete independence.

### Step types

| Type                     | Category       | Creates promise | Has `promise_id` | Context switch |
| ------------------------ | -------------- | --------------- | ---------------- | -------------- |
| `start_step`             | Tier 1 (start) | yes             | no               | yes            |
| `start_child_workflow`   | Tier 1 (start) | yes             | no               | yes            |
| `send_request`           | Tier 1 (start) | yes             | no               | yes            |
| `await_promise`          | Tier 1 (await) | no              | **yes**          | yes            |
| `execute_scope`          | structural     | no              | no               | no             |
| `sleep`                  | Tier 2         | yes             | yes              | yes            |
| `sleep_until`            | Tier 2         | yes             | yes              | yes            |
| `channel_receive`        | Tier 2         | yes             | yes              | yes            |
| `channel_receive_nowait` | awaitable read | no              | no               | no (flush)     |
| `patch_check`            | awaitable read | no              | no               | no (flush)     |
| `stream_write`           | buffered       | no              | no               | no             |
| `event_set`              | buffered       | no              | no               | no             |
| `attribute_set`          | buffered       | no              | no               | no             |
| `register_compensation`  | buffered       | no              | no               | no             |
| `eager_compensation`     | buffered       | no              | no               | no             |
| `queue_enqueue`          | buffered       | no              | no               | no             |
| `topic_publish`          | buffered       | no              | no               | no             |
| `start_detached`         | buffered       | no              | no               | no             |

Every real await point produces a promise, and the `await_promise` step references it via `promise_id`. The promise already knows its origin (via `promise.step_id` → the `start_*` step). The await step just says "I'm parked here until this promise resolves." This correctly models multi-branch sharing: two branches awaiting the same step's result both record `await_promise` pointing to the same `promise_id`.

Buffered operations are synchronous calls in the public API — they do not return promises and are not `await`ed. They buffer step records in memory, which are committed in the next batch transaction. Awaitable reads (`receiveNowait`, `patch`) trigger a flush of the buffer before reading from committed state.

---

## Part 2: Compensation Model Redesign

### Problem

The current compensation model has three deficiencies:

1. **Ghost side effects** — compensations only run on workflow failure. Caught failures leave side effects uncompensated.
2. **Blocking the main workflow** — if compensations ran on the same VEL, the workflow cannot return until all compensations complete. This is unacceptable for user-facing latency.
3. **Non-deterministic shared resources** — if compensations share channels, state, streams, etc. with the main workflow, the interaction between two concurrent VELs becomes non-deterministic.

### Solution: parallel compensation VEL

Compensation runs on a separate, independent VEL. This allows:

- The main workflow to complete and return results to the caller while compensations run in the background.
- Deterministic compensation replay, independent of execution replay.
- Clean separation of shared resources between the two contexts.

### Two compensation paths

**Deferred compensation (LIFO stack):** registered via `.compensate()` on step/workflow calls, or standalone via `ctx.registerCompensation(name, cb)`. Pushed onto a LIFO stack. Executed in reverse order when the workflow fails (throws a declared error via `ctx.errors`). The LIFO order ensures that the most recently registered compensation runs first, preserving the natural "undo in reverse" semantics.

**Eager compensation (FIFO queue):** dispatched when a step times out and the timeout is caught, or when a scope exits with unconsumed branches, or standalone via `ctx.compensateEagerly(name, cb)`. Pushed to the compensation VEL's FIFO queue and executed immediately in the background while the main workflow continues.

### Registration as durable steps

Both standalone compensation methods are synchronous buffered operations that write a step record to the execution tree:

```typescript
ctx.registerCompensation("cancel-hotel", async (ctx) => {
  await ctx.steps.cancelHotel({ hotelId: hotel.id }).resolve(ctx);
});

ctx.compensateEagerly("refund-booking", async (ctx) => {
  await ctx.steps.refundBooking({ bookingId: booking.id }).resolve(ctx);
});
```

Step records in the execution tree:

```
ordinal 3: { type: "register_compensation", definition_name: "cancel-hotel" }
ordinal 7: { type: "eager_compensation",    definition_name: "refund-booking" }
```

**Named blocks are mandatory.** Every compensation block must have a name. This forces the developer to assign semantic identity to each block. The name is stored alongside the step type in `definition_name`, and on replay the engine verifies `(ordinal, type, definition_name)` matches. If a block is removed, reordered, or renamed between versions, the mismatch is caught immediately as a replay divergence → halt.

### `.compensate()` builder as sugar

The `.compensate()` builder on `StepCall` and `WorkflowCall` desugars to `ctx.registerCompensation` with an auto-generated name:

```typescript
await ctx.steps.bookFlight({ destination: dest })
  .compensate(async (ctx) => { ... })
  .resolve(ctx);

// Desugars to (conceptually):
const result = await ctx.steps.bookFlight({ destination: dest }).resolve(ctx);
ctx.registerCompensation("compensate:bookFlight", cb);
```

Step table records:

```
ordinal 1: { type: "start_step",              definition_name: "bookFlight" }
ordinal 2: { type: "register_compensation",   definition_name: "compensate:bookFlight" }
ordinal 3: { type: "await_promise",           promise_id: 42 }
```

The `.compensate()` builder also accepts an optional custom name for cases where the default is ambiguous (e.g., calling the same step twice):

```typescript
compensate(cb: CompensationCallback): StepCall<...>;
compensate(name: string, cb: CompensationCallback): StepCall<...>;
```

### Eager promotion on caught failure/timeout

When `.timeout(cb)` fires on a step, or `.failure(cb)` fires on a child workflow, the engine performs two actions in order:

1. Records an `eager_compensation` step, promoting the registered compensation from the LIFO stack to the FIFO queue in the compensation VEL.
2. Enters the failure/timeout handler callback.

```
ordinal 1: { type: "start_step",              definition_name: "bookFlight" }
ordinal 2: { type: "register_compensation",   definition_name: "compensate:bookFlight" }
ordinal 3: { type: "await_promise",           promise_id: 42 }
-- timeout fires --
ordinal 4: { type: "eager_compensation",      definition_name: "compensate:bookFlight" }
-- timeout handler runs, result = null --
```

By the time the handler executes, the compensation is already dispatched to the background VEL. The undo for the failed operation is in flight before the recovery logic runs.

On success (no timeout fires), the `eager_compensation` step is never recorded. The `register_compensation` stays on the LIFO stack.

### Scope exit and compensation

When a scope exits, the engine classifies each branch as **consumed** or **unconsumed**:

- **Consumed**: the scope body explicitly joined or matched this branch's result.
- **Unconsumed**: the scope body never read this branch's result (e.g., it lost a race in `ctx.first`).

For unconsumed branches that have registered compensations, the engine creates a **mirror scope** in the compensation VEL. This mirror scope has one branch per unconsumed branch, and each branch executes its compensation callbacks in LIFO order (reverse of registration). The mirror scope runs eagerly — the compensations begin immediately in the background.

For consumed branches, their compensations remain on the LIFO stack and execute only if the workflow ultimately fails.

### Compensation queue lifecycle

The compensation VEL processes work in this order:

1. **Eager FIFO entries** — dispatched by the execution VEL as they arise (caught failures, scope exits with unconsumed branches, explicit `ctx.compensateEagerly` calls). Processed in order of arrival. Sequential within a single compensation closure, but scoped compensations (from mirror scopes) can run branches concurrently.

2. **LIFO unwind** — triggered only when the main workflow fails. After all eager FIFO entries have been processed, the engine unwinds the LIFO stack in reverse order of registration. Each entry executes sequentially.

The client receives the workflow result eagerly. If the workflow succeeds, the result is returned immediately even if compensations are still running. If the workflow fails, the result is also returned immediately — the LIFO unwind runs in the background.

### Compensation halts

An unexpected exception inside a compensation block causes a **halt** — the compensation VEL pauses at that point. The engine cannot skip the failed block because subsequent blocks may depend on state modifications that the failed block was supposed to make.

The resolution path is the same as for execution halts: deploy a patch that fixes the issue, restart the worker, and the compensation VEL replays up to the failure point and proceeds through the patched code.

A scope-level halt (one branch of a mirror scope failing) blocks the entire scope. Even if 999 out of 1000 branches completed, the scope cannot advance past the one halted branch. This preserves the guarantee that compensation callbacks execute in a well-defined order.

### Hook integration

- `beforeSettle` runs before final workflow status is settled. It has no connection to compensation lifecycle.
- `beforeCompensate` runs before the LIFO unwind begins. It does NOT run before eager compensations.
- `afterCompensate` runs after the LIFO unwind completes. It does NOT run after individual eager compensations.

This cleanly separates eager compensation (operational, happens as side effects are detected) from LIFO unwind compensation (structural, happens when the workflow fails).

---

## Part 3: Halt Model

### Problem

Any unexpected exception (anything that is not a declared `ctx.errors` throw) in workflow or compensation code puts the engine in an undefined state. The code between the last durable step and the exception is non-deterministic on replay. Retrying the code block is not safe — it may have already modified in-memory state.

### Solution: unified halts

A **halt** is a soft failure that pauses execution at the point of the unexpected exception. The workflow transitions to `status = 'halted'`. Multiple pending halts can coexist — each represents a point where replay encountered an exception.

```sql
CREATE TABLE halt (
  id                BIGSERIAL PRIMARY KEY,
  after_step_id     BIGINT REFERENCES step(id),
  status            TEXT NOT NULL DEFAULT 'pending',
  error_type        TEXT,
  error_message     TEXT,
  error_stacktrace  TEXT,
  error_details     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_halt_status CHECK (status IN ('pending', 'resolved'))
);
```

**Resolution paths:**

1. **Patch + replay**: deploy a code change that fixes the issue. On worker restart, the engine replays the workflow. If the code now proceeds past `after_step_id` without throwing, all pending halts at or before that point are automatically marked `resolved`.
2. **SIGKILL**: abandon the workflow entirely. Immediate termination, no further processing.

There is no "skip" mechanism. Skipping a halted block would leave state inconsistent — subsequent code may depend on mutations the skipped block was supposed to perform. This applies equally to execution and compensation halts.

---

## Part 4: Error Model

### Problem

Currently, any thrown exception fails the entire workflow. There is no way to distinguish between an intentional business failure ("this order is invalid") and an accidental programming error ("cannot read property of undefined"). Additionally, external callers have no typed access to failure details — all errors are opaque.

### Solution: schema-only error definitions

Errors are defined as named entries at `defineWorkflow` level, following the same pattern as channels, streams, events, and other primitives. Each error has a name (the object key) and an optional standard-schema for its details. The value `true` means the error carries no details.

```typescript
defineWorkflow({
  errors: {
    OrderInvalid: z.object({ orderId: z.string() }),
    InsufficientFunds: z.object({ amount: z.number(), balance: z.number() }),
    Cancelled: true,
  },
  // ...
});
```

There are no `WorkflowError` subclasses. Error classes are not user-defined. Instead, the workflow context exposes factory functions keyed by error name:

```typescript
execute: async (ctx) => {
  if (!valid) {
    throw ctx.errors.OrderInvalid("Order is invalid", { orderId: "123" });
  }
  if (balance < amount) {
    throw ctx.errors.InsufficientFunds("Not enough balance", { amount, balance });
  }
  throw ctx.errors.Cancelled("User cancelled the order");
}
```

Each factory function returns a `WorkflowError` instance. The engine catches it, verifies that its `errorCode` matches one of the declared keys, and serializes to JSONB.

**For errors with details** (schema provided), the factory signature is `(message: string, details: InferInput<TSchema>) => WorkflowError`.

**For errors without details** (`true`), the factory signature is `(message: string) => WorkflowError`.

### `WorkflowError` base class

`WorkflowError` is the internal throwable. It is not subclassed by users. It carries an `errorCode` and optional `details`, both assigned by the `ctx.errors.X(...)` factory.

```typescript
class WorkflowError extends Error {
  readonly errorCode: string;
  readonly details: unknown;
}
```

Constructing `WorkflowError` directly is not supported — the `ctx.errors` factories are the only sanctioned way to create instances. If any `WorkflowError` is caught by the engine whose `errorCode` does not match a declared error name, the engine treats it as an unexpected exception and **halts** the workflow, not fails it. This enforces the contract: only explicitly declared errors can fail a workflow.

### The distinction

- **`throw ctx.errors.OrderInvalid("...")`** → the workflow **fails**. The `errorCode` matches a declared error. The LIFO compensation unwind is triggered. The workflow settles as `failed`.
- **`throw new Error("Cannot read property of undefined")`** → the workflow **halts**. This is an accidental exception. The engine records a halt and pauses execution.
- **`throw new WorkflowError(...)`** (constructed directly, not via `ctx.errors`) → the workflow **halts**. The `errorCode` does not match a declared error — treated as undeclared/accidental.

### External error types

At the external caller level, errors are plain JSON values — no class instances, no prototype chains, no `instanceof` checks. All error variants share a common `type` discriminant field and a `scopePath` field:

```typescript
type WorkflowFailureInfo<TErrors, TSteps, TRequests, TChildWorkflows> =
  | WorkflowErrorValue<TErrors>
  | StepTimeoutError<TSteps>
  | RequestTimeoutError<TRequests>
  | ChildWorkflowError<TChildWorkflows>
  | ChildWorkflowTimeoutError<TChildWorkflows>;
```

**`WorkflowErrorValue`** — the workflow's own declared errors. Fully typed, discriminated by `errorCode`:

```typescript
type WorkflowErrorValue<TErrors> = {
  [K in keyof TErrors]: {
    type: "WorkflowError";
    errorCode: K;
    message: string;
    details: TErrors[K] extends true ? never : StandardSchemaV1.InferOutput<TErrors[K]>;
    scopePath: string[];
  };
}[keyof TErrors];
```

**`StepTimeoutError`** — a step exhausted its `.timeout()` boundary without a handler. Fully typed per step — switch on `stepName` to get typed args:

```typescript
type StepTimeoutError<TSteps> = {
  [K in keyof TSteps & string]: {
    type: "StepTimeoutError";
    stepName: K;
    args: StandardSchemaV1.InferOutput<TSteps[K]["args"]>;
    reason: "attempts_exhausted" | "deadline";
    scopePath: string[];
  };
}[keyof TSteps & string];
```

**`RequestTimeoutError`** — a request exhausted its `.timeout()` boundary without a handler. Fully typed per request — switch on `requestName` to get typed args:

```typescript
type RequestTimeoutError<TRequests> = {
  [K in keyof TRequests & string]: {
    type: "RequestTimeoutError";
    requestName: K;
    args: StandardSchemaV1.InferOutput<TRequests[K]["request"]>;
    reason: "attempts_exhausted" | "deadline";
    scopePath: string[];
  };
}[keyof TRequests & string];
```

**`ChildWorkflowError`** — a child workflow failed (threw a declared error, step timed out, etc.) and the parent didn't handle it with `.failure()`. Typed per child workflow definition — switch on `childWorkflowName` to get typed args. The actual error from the child is packaged under the `error` field as a `LooseWorkflowError` (loosely typed, recursively nested):

```typescript
type ChildWorkflowError<TChildWorkflows> = {
  [K in keyof TChildWorkflows & string]: {
    type: "ChildWorkflowError";
    childWorkflowName: K;
    idempotencyKey: string;
    args: StandardSchemaV1.InferOutput<TChildWorkflows[K]["args"]>;
    scopePath: string[];
    error: LooseWorkflowError;
  };
}[keyof TChildWorkflows & string];
```

**`ChildWorkflowTimeoutError`** — the parent timed out waiting for the child (parent-side `.timeout()` on `WorkflowCall` without a handler). The child is terminated. Distinct from `ChildWorkflowError` — the child didn't fail on its own, the parent gave up:

```typescript
type ChildWorkflowTimeoutError<TChildWorkflows> = {
  [K in keyof TChildWorkflows & string]: {
    type: "ChildWorkflowTimeoutError";
    childWorkflowName: K;
    idempotencyKey: string;
    args: StandardSchemaV1.InferOutput<TChildWorkflows[K]["args"]>;
    scopePath: string[];
  };
}[keyof TChildWorkflows & string];
```

**`LooseWorkflowError`** — the recursively nested error structure inside `ChildWorkflowError.error`. Uses the same `type` discriminant but all fields are loosely typed (`string`, `unknown`). The recursive nesting IS the propagation path — each `ChildWorkflowError` layer carries the identity and args of the child that failed:

```typescript
type LooseWorkflowError =
  | { type: "WorkflowError"; errorCode: string; message: string; details: unknown }
  | { type: "StepTimeoutError"; stepName: string; args: unknown; reason: "attempts_exhausted" | "deadline" }
  | { type: "RequestTimeoutError"; requestName: string; args: unknown; reason: "attempts_exhausted" | "deadline" }
  | { type: "ChildWorkflowError"; childWorkflowName: string; idempotencyKey: string; args: unknown; error: LooseWorkflowError }
  | { type: "ChildWorkflowTimeoutError"; childWorkflowName: string; idempotencyKey: string; args: unknown };
```

### External caller usage

```typescript
const result = await client.workflows.order.execute({ ... });
if (!result.ok && result.status === "failed") {
  switch (result.error.type) {
    case "WorkflowError":
      switch (result.error.errorCode) {
        case "OrderInvalid":
          // result.error.details: { orderId: string } — fully typed
          break;
        case "InsufficientFunds":
          // result.error.details: { amount: number, balance: number }
          break;
        case "Cancelled":
          // result.error.details: never — no details
          break;
      }
      break;
    case "StepTimeoutError":
      // result.error.stepName: "bookFlight" | "validateOrder" | ...
      // result.error.args: typed per step
      break;
    case "RequestTimeoutError":
      // result.error.requestName: "humanReview" | ...
      // result.error.args: typed per request
      break;
    case "ChildWorkflowError":
      // result.error.childWorkflowName: "payment" | ...
      // result.error.idempotencyKey: string
      // result.error.args: typed per child workflow
      // result.error.error: LooseWorkflowError — drill into the actual cause
      break;
    case "ChildWorkflowTimeoutError":
      // result.error.childWorkflowName: "payment" | ...
      // result.error.idempotencyKey: string
      // result.error.args: typed per child workflow
      break;
  }
}
```

### Child workflow error propagation

When a child workflow fails and `.failure()` is NOT chained on the `WorkflowCall`, the child's error propagates to the parent as an unhandled failure — the parent workflow fails. At the parent's external result level, this appears as a `ChildWorkflowError` with the child's identity, args, and the actual error recursively nested under `.error`.

When the parent's `.timeout()` fires on a child without a handler, the child is terminated and the parent fails with a `ChildWorkflowTimeoutError`.

When `.failure()` IS chained, the handler receives a `ChildWorkflowFailureInfo` containing the child's serialized error value. The handler returns a recovery value and the parent continues. The child's error does not propagate.

This avoids recursive type expansion: child workflow errors are `ChildWorkflowError` at the parent's external boundary with the nested error loosely typed as `LooseWorkflowError`. Only the workflow's own declared errors are fully typed. The recursive nesting of `LooseWorkflowError` provides the full propagation path without a separate `propagationPath` field.

---

## Part 5: Step Timeout Unification

### Problem

`maxAttempts` lives in `RetryPolicyOptions` alongside retry behavior configuration. But `maxAttempts` is not a retry behavior — it is a stop condition. It answers "when to give up," not "how to retry." This creates confusion: a step configured with no `maxAttempts` and no deadline retries forever, making `.failure()` unreachable dead code.

### Solution

Remove `maxAttempts` from `RetryPolicyOptions`. Move it to the `.timeout()` builder method. Remove `.failure()` from `StepCall` entirely — steps can only succeed or time out.

**`RetryPolicyOptions` becomes purely about retry behavior:**

```typescript
interface RetryPolicyOptions {
  intervalSeconds?: number; // initial retry interval (default: 1)
  backoffRate?: number; // backoff multiplier (default: 2)
  maxIntervalSeconds?: number; // interval cap (default: 300)
  timeoutSeconds?: number; // per-attempt execution timeout (signal abort)
}
```

**`.timeout()` becomes the single surface for stop conditions:**

```typescript
type StepBoundary =
  | { maxAttempts: number; seconds?: number; deadline?: never }
  | { seconds: number; maxAttempts?: number; deadline?: never }
  | { deadline: Date; maxAttempts?: number; seconds?: never }
  | { maxAttempts: number; deadline?: Date; seconds?: never };
```

`seconds` and `deadline` are mutually exclusive — `seconds` is a relative wall-clock timeout, `deadline` is an absolute timestamp. `maxAttempts` can coexist with either.

The shorthand accepts `number` (seconds) or `Date` (deadline):

```typescript
.timeout(60)                                    // 60 seconds overall
.timeout(60, () => null)                        // 60 seconds, return null on timeout
.timeout(new Date("2027-01-10"))                // absolute deadline
.timeout(new Date("2027-01-10"), () => null)    // deadline, return null on timeout
.timeout({ maxAttempts: 5 })                    // 5 attempts max
.timeout({ maxAttempts: 5, seconds: 60 })       // whichever fires first
.timeout({ maxAttempts: 5, deadline: d })       // whichever fires first
.timeout({ maxAttempts: 5, seconds: 60 }, () => null)
```

`maxAttempts` and `seconds`/`deadline` complement each other — both can coexist in the same boundary. `maxAttempts` limits how many times the step is tried. `seconds`/`deadline` limits total wall-clock time. Whichever boundary is reached first terminates the step.

**Updated `StepCall`:**

Builder methods use the `Called` type parameter to make invalid states unrepresentable — each builder method returns `never` if it has already been called in the chain, preventing duplicate calls at compile time.

```typescript
interface StepCall<
  TArgs,
  T,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
  Called extends string = never,
> extends DeterministicAwaitable<T | TTimeout, ExecutionRoot> {
  compensate: "compensate" extends Called ? never :
    & ((
        cb: (ctx: Tctx, result: StepCompensationResult<TArgs, T>) => Promise<void>,
      ) => StepCall<TArgs, T, TTimeout, true, Tctx, Called | "compensate">)
    & ((
        name: string,
        cb: (ctx: Tctx, result: StepCompensationResult<TArgs, T>) => Promise<void>,
      ) => StepCall<TArgs, T, TTimeout, true, Tctx, Called | "compensate">);

  retry: "retry" extends Called ? never :
    (policy: RetryPolicyOptions) =>
      StepCall<TArgs, T, TTimeout, HasCompensation, Tctx, Called | "retry">;

  timeout: "timeout" extends Called ? never :
    & ((secondsOrDeadline: number | Date) =>
        StepCall<TArgs, T, never, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(secondsOrDeadline: number | Date, cb: () => R) =>
        StepCall<TArgs, T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">)
    & ((opts: StepBoundary) =>
        StepCall<TArgs, T, never, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(opts: StepBoundary, cb: () => R) =>
        StepCall<TArgs, T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">);

  complete: "complete" extends Called ? never :
    <R>(cb: (data: T) => R) =>
      StepCall<TArgs, Awaited<R>, TTimeout, HasCompensation, Tctx, Called | "complete">;
}
```

Key changes:

- **`TFail` is gone.** Replaced by `TTimeout`. Steps cannot "fail" — they succeed or time out.
- **`.failure()` is removed.** Steps retry forever unless bounded by `.timeout()`.
- **`.timeout()` replaces `.failure()` as the explicit error handling surface.** Without `.timeout()` chained and a timeout boundary reached, the workflow fails with a `StepTimeoutError`.

The old pattern:

```typescript
const result = await ctx.steps
  .bookFlight(dest, id)
  .failure(() => null)
  .resolve(ctx);
```

Becomes:

```typescript
const result = await ctx.steps
  .bookFlight({ destination: dest, passengerId: id })
  .timeout({ maxAttempts: 3 }, () => null)
  .resolve(ctx);
```

### Updated `StepCompensationResult`

```typescript
type StepCompensationResult<TArgs, T> =
  | { status: "complete"; args: TArgs; data: T; attempts: AttemptAccessor }
  | {
      status: "timed_out";
      args: TArgs;
      reason: "attempts_exhausted" | "deadline";
      attempts: AttemptAccessor;
    }
  | { status: "terminated" };
```

`args` is the deserialized step arguments, typed by the step's `args` schema. Available on all variants except `"terminated"` (where the step was never attempted).

### Child workflow timeout

Child workflows keep `.failure()` (child workflows genuinely fail via their declared `ctx.errors`). A new `.timeout()` is added separately:

```typescript
interface WorkflowCall<
  T,
  TFail = never,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
  Called extends string = never,
> extends DeterministicAwaitable<T | TFail | TTimeout, ExecutionRoot> {
  compensate: "compensate" extends Called ? never :
    & ((
        cb: (ctx: Tctx, result: ChildWorkflowCompensationResult<T>) => Promise<void>,
      ) => WorkflowCall<T, TFail, TTimeout, true, Tctx, Called | "compensate">)
    & ((
        name: string,
        cb: (ctx: Tctx, result: ChildWorkflowCompensationResult<T>) => Promise<void>,
      ) => WorkflowCall<T, TFail, TTimeout, true, Tctx, Called | "compensate">);

  failure: "failure" extends Called ? never :
    <R>(cb: (failure: ChildWorkflowFailureInfo) => R) =>
      WorkflowCall<T, Awaited<R>, TTimeout, HasCompensation, Tctx, Called | "failure">;

  timeout: "timeout" extends Called ? never :
    & ((secondsOrDeadline: number | Date) =>
        WorkflowCall<T, TFail, never, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(secondsOrDeadline: number | Date, cb: () => R) =>
        WorkflowCall<T, TFail, Awaited<R>, HasCompensation, Tctx, Called | "timeout">)
    & ((opts: StepBoundary) =>
        WorkflowCall<T, TFail, never, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(opts: StepBoundary, cb: () => R) =>
        WorkflowCall<T, TFail, Awaited<R>, HasCompensation, Tctx, Called | "timeout">);

  complete: "complete" extends Called ? never :
    <R>(cb: (data: T) => R) =>
      WorkflowCall<Awaited<R>, TFail, TTimeout, HasCompensation, Tctx, Called | "complete">;
}
```

The distinction:

- `.failure()` handles child workflow failure (child threw a declared error via `ctx.errors`) and termination.
- `.timeout()` handles parent-side patience (the parent gives up waiting). This is separate from child-side failure. Accepts `number` (seconds), `Date` (deadline), or `StepBoundary` (structured options with `maxAttempts`/`seconds`/`deadline`).
- Without `.failure()` chained, a child workflow failure auto-fails the parent. Without `.timeout()` chained, a timeout auto-fails the parent.
- Each builder method can only be called once per chain — the `Called` type parameter tracks which methods have been used and makes duplicates resolve to `never`.

---

## Part 6: Context Splitting

### Problem

The execution VEL and compensation VEL run in parallel. If they share channels, state, streams, events, attributes, and rng, their interactions become non-deterministic — the order in which the two VELs read/write shared state is unpredictable across replays.

### Solution

Split all shared primitives between the two VELs. Each VEL gets its own dedicated instances:

| Primitive        | Execution VEL        | Compensation VEL                           |
| ---------------- | -------------------- | ------------------------------------------ |
| `ctx.channels`   | Execution channels   | Compensation channels                      |
| `ctx.state`      | Execution state      | Compensation state (separate factory call) |
| `ctx.streams`    | Execution streams    | Compensation streams                       |
| `ctx.events`     | Execution events     | Compensation events                        |
| `ctx.attributes` | Execution attributes | Compensation attributes                    |
| `ctx.rng`        | Execution RNG        | Compensation RNG (separate seed)           |

This is a hard split. The execution VEL cannot read from or write to compensation channels, and vice versa. External callers target specific channels when sending messages.

The state factory function is called twice — once for each VEL — producing independent state objects. RNG streams are seeded separately so the same `ctx.rng.txnId.uuidv4()` call produces different (but individually deterministic) values in each VEL.

---

## Part 7: Convenience Scope Methods

All scopes must be named. The convenience methods follow the same pattern.

### `ctx.joinSafe(handle, onError)`

Joins a branch handle, catching failure via a handler callback instead of throwing. The error handler receives the failure info and returns a recovery value. The return type is `T | Awaited<R>` — either the branch succeeded normally, or the handler produced a fallback. This follows the same pattern as `.timeout()` and `.failure()` elsewhere in the API.

```typescript
const result = await ctx.joinSafe(
  flightHandle,
  (error) => null,   // error: ScopeFailureInfo<TSteps, TChildWorkflows>
);
// result: FlightResult | null
```

### `ctx.best(name, entries)`

Collect as many results as possible. Branches that fail are compensated eagerly; branches that succeed have their results collected. Returns all successful results as an array:

```typescript
const results = await ctx
  .best("GetAllQuotes", {
    providerA: async (ctx) => ctx.steps.getQuote({ provider: "A" }).resolve(ctx),
    providerB: async (ctx) => ctx.steps.getQuote({ provider: "B" }).resolve(ctx),
    providerC: async (ctx) => ctx.steps.getQuote({ provider: "C" }).resolve(ctx),
  })
  .resolve(ctx);
// results: Array<{ key: "providerA" | "providerB" | "providerC", data: Quote }>
```

### `ctx.atMost(name, n, entries)`

Collect at most `n` results. Short-circuits after `n` successes; remaining branches are compensated eagerly:

```typescript
const results = await ctx
  .atMost("PickTwo", 2, {
    providerA: async (ctx) => ctx.steps.getQuote({ provider: "A" }).resolve(ctx),
    providerB: async (ctx) => ctx.steps.getQuote({ provider: "B" }).resolve(ctx),
    providerC: async (ctx) => ctx.steps.getQuote({ provider: "C" }).resolve(ctx),
  })
  .resolve(ctx);
// results: Array<{ key: "providerA" | "providerB" | "providerC", data: Quote }>
// results.length <= 2
```

### `ctx.atLeast(name, n, entries)`

Collect at least `n` results before returning. Fails if fewer than `n` branches succeed:

```typescript
const results = await ctx
  .atLeast("EnsureQuorum", 3, {
    nodeA: async (ctx) => ctx.steps.healthCheck({ node: "A" }).resolve(ctx),
    nodeB: async (ctx) => ctx.steps.healthCheck({ node: "B" }).resolve(ctx),
    nodeC: async (ctx) => ctx.steps.healthCheck({ node: "C" }).resolve(ctx),
    nodeD: async (ctx) => ctx.steps.healthCheck({ node: "D" }).resolve(ctx),
    nodeE: async (ctx) => ctx.steps.healthCheck({ node: "E" }).resolve(ctx),
  })
  .resolve(ctx);
// results: Array<{ key: ..., data: HealthCheckResult }>
// results.length >= 3
```

### Return type

All three methods return `Array<{ key: K, data: EntryResult<K> }>`. This provides true type safety with a natural iteration interface. The consumer expects to iterate options, so an array is more natural than a partial object.

### Type signatures

```typescript
best<
  Name extends string,
  E extends Record<string, ScopeEntry<any>>,
>(
  name: ScopeNameArg<TScopePath, Name>,
  entries: E,
): BestCall<Array<{ key: keyof E & string; data: EntryResult<E, keyof E & string> }>, E, TSteps, TChildWorkflows, ExecutionRoot>;

atMost<
  Name extends string,
  E extends Record<string, ScopeEntry<any>>,
>(
  name: ScopeNameArg<TScopePath, Name>,
  n: number,
  entries: E,
): AtMostCall<Array<{ key: keyof E & string; data: EntryResult<E, keyof E & string> }>, E, TSteps, TChildWorkflows, ExecutionRoot>;

atLeast<
  Name extends string,
  E extends Record<string, ScopeEntry<any>>,
>(
  name: ScopeNameArg<TScopePath, Name>,
  n: number,
  entries: E,
): AtLeastCall<Array<{ key: keyof E & string; data: EntryResult<E, keyof E & string> }>, E, TSteps, TChildWorkflows, ExecutionRoot>;
```

`ScopeNameArg` enforces the ancestor name collision check, consistent with `ctx.scope()`.

---

## Part 8: Database Schema

The unified schema represents both execution and compensation trees using the same tables. Phase is not stored as a column — it is derived by traversing the tree to the root branch and checking against the workflow's `execution_branch_id` or `compensation_branch_id`.

### `branch`

```sql
CREATE TABLE branch (
  id          BIGSERIAL PRIMARY KEY,
  scope_id    BIGINT,           -- NULL for root branches
  key         TEXT NOT NULL,
  key_path    TEXT[] NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  consumed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_branch_status CHECK (
    status IN ('active', 'complete', 'failed', 'settled', 'cancelled')
  )
);

CREATE UNIQUE INDEX uq_branch_scope_key
  ON branch (scope_id, key) WHERE scope_id IS NOT NULL;
```

Root branches have `scope_id IS NULL`. These serve as VEL entry points. All other branches belong to a scope.

`consumed` tracks whether the scope body joined/matched this branch's result. Unconsumed branches with compensations trigger eager compensation on scope exit.

### `scope`

```sql
CREATE TABLE scope (
  id              BIGSERIAL PRIMARY KEY,
  parent_step_id  BIGINT NOT NULL, -- FK added via ALTER
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_scope_status CHECK (status IN ('active', 'complete', 'failed'))
);
```

Every scope is spawned by an `execute_scope` step. The `parent_step_id` is always non-null — root branches are not scopes.

### `step`

```sql
CREATE TABLE step (
  id               BIGSERIAL PRIMARY KEY,
  branch_id        BIGINT NOT NULL,  -- FK added via ALTER
  ordinal          INT NOT NULL,
  type             TEXT NOT NULL,
  definition_name  TEXT,
  promise_id       BIGINT,           -- set for await_promise and Tier 2 steps
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (branch_id, ordinal)
);
```

Steps do not store their arguments. Steps are deterministic on replay — the engine replays the workflow code which calls the step with the same arguments. The step record only needs to capture the operation type, definition name, and result.

`promise_id` is set for `await_promise` steps (Tier 1 await phase) and Tier 2 steps (`sleep`, `channel_receive`) which both create and await a promise.

### Circular FK resolution

```sql
ALTER TABLE branch ADD CONSTRAINT fk_branch_scope
  FOREIGN KEY (scope_id) REFERENCES scope(id);
ALTER TABLE scope ADD CONSTRAINT fk_scope_parent_step
  FOREIGN KEY (parent_step_id) REFERENCES step(id);
ALTER TABLE step ADD CONSTRAINT fk_step_branch
  FOREIGN KEY (branch_id) REFERENCES branch(id);
ALTER TABLE step ADD CONSTRAINT fk_step_promise
  FOREIGN KEY (promise_id) REFERENCES promise(id);
```

### `workflow`

```sql
CREATE TABLE workflow (
  id                            TEXT PRIMARY KEY,
  definition_name               TEXT NOT NULL,
  idempotency_key               TEXT,
  seed                          TEXT,
  execution_branch_id           BIGINT NOT NULL REFERENCES branch(id),
  compensation_branch_id        BIGINT NOT NULL REFERENCES branch(id),
  args                          JSONB,
  metadata                      JSONB,
  result                        JSONB,
  status                        TEXT NOT NULL DEFAULT 'pending',
  scheduled_at                  TIMESTAMPTZ,
  deadline_at                   TIMESTAMPTZ,
  error_type                    TEXT,
  error_message                 TEXT,
  error_details                 JSONB,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at                    TIMESTAMPTZ,
  completed_at                  TIMESTAMPTZ,
  failed_at                     TIMESTAMPTZ,
  terminated_at                 TIMESTAMPTZ,
  retention_complete_seconds    INT,
  retention_failed_seconds      INT,
  retention_terminated_seconds  INT,
  retention_deadline_at         TIMESTAMPTZ,

  CONSTRAINT chk_status CHECK (
    status IN ('pending', 'running', 'complete', 'failed', 'terminated', 'halted')
  ),
  CONSTRAINT chk_schedule_before_deadline CHECK (
    scheduled_at IS NULL OR deadline_at IS NULL OR scheduled_at < deadline_at
  ),
  CONSTRAINT chk_different_roots CHECK (
    execution_branch_id != compensation_branch_id
  ),
  UNIQUE (definition_name, idempotency_key)
);
```

The workflow references two root branches directly. Both are created at workflow start time. The compensation root branch may remain empty. No branch, scope, or step knows its workflow — the relationship is derived by traversing up to the root branch and matching against the workflow table. This is normalized and avoids redundancy.

### `promise`

```sql
CREATE TABLE promise (
  id           BIGSERIAL PRIMARY KEY,
  step_id      BIGINT NOT NULL REFERENCES step(id),
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  result       JSONB,
  error        JSONB,
  sequence_no  BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);
```

`sequence_no` is assigned atomically under a per-VEL advisory lock on resolution. Each VEL uses a separate advisory lock namespace derived from the root branch ID, ensuring independent sequence numbering. The engine caches the root branch mapping in memory — no DB traversal is needed for the hot path.

### `halt`

```sql
CREATE TABLE halt (
  id                BIGSERIAL PRIMARY KEY,
  after_step_id     BIGINT REFERENCES step(id),
  status            TEXT NOT NULL DEFAULT 'pending',
  error_type        TEXT,
  error_message     TEXT,
  error_stacktrace  TEXT,
  error_details     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_halt_status CHECK (status IN ('pending', 'resolved'))
);
```

Multiple pending halts per workflow are allowed. Each represents a replay attempt that encountered an exception. When execution proceeds past `after_step_id` (due to a code patch), halts at or before that point are automatically resolved.

---

## Part 9: Search Query Refactoring

### Goal

The existing `src/types/search-query.ts` implements a typed query AST parameterized over two hardcoded namespaces: `engine` and `meta`. Generalizing it enables reuse for topic metadata filters, dead-letter payload filters, and any future query surfaces.

### Task

```typescript
type SearchQueryNode<TNamespaces extends Record<string, SearchMetadataRecord>>
type SearchQuery<TNamespaces extends Record<string, SearchMetadataRecord>>

type WorkflowSearchQueryNode<TMeta extends SearchMetadataRecord> =
  SearchQueryNode<{ engine: WorkflowSearchEngineFields; meta: TMeta }>

type WorkflowSearchQueryBuilder<TMeta extends SearchMetadataRecord> =
  SearchQuery<{ engine: WorkflowSearchEngineFields; meta: TMeta }>
```

The `SearchQuery<TNamespaces>` builder exposes one sub-builder per namespace key, each using the existing predicate machinery (`eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`, `containsAny`, `containsAll`) typed to that namespace's field record. The `and`, `or`, `not` combinators remain top-level.

Existing aliases are kept so no call sites break.

---

## Part 10: Queues

### Purpose

A global competing-consumer work queue. Any workflow can enqueue a typed message to a named queue. Any registered worker can consume from it. Messages are processed exactly once via `SELECT FOR UPDATE SKIP LOCKED`.

### Definition

```typescript
const notificationsQueue = defineQueue({
  name: "notifications",
  message: z.object({ userId: z.string(), body: z.string() }),
  defaultTTL: 3600,
  retention: {
    processed: 86400,
    deadLettered: 86400 * 30,
  },
});
```

- `name` — globally unique DB namespace.
- `message` — standard-schema. Input type for enqueuing, output type for handler.
- `defaultTTL` — optional. Seconds before unclaimed message is dead-lettered with `ttl_expired`. If absent, `ttl` is required on every `enqueue`.
- `retention.processed` — row retention seconds after processing. `null` = never delete.
- `retention.deadLettered` — row retention seconds after dead-lettering. `null` = never delete.

### TTL semantics

- `ttl: number` — expires N seconds from enqueue time.
- `ttl: null` — never expires, regardless of `defaultTTL`.

When `defaultTTL` is not specified, `ttl` is required on every `enqueue` call. When `defaultTTL` is specified, `ttl` is an optional override.

### Scheduling semantics

- `delay: number` — eligible N seconds from enqueue time.
- `scheduledAt: Date` — eligible at absolute timestamp.

Both optional. If neither is provided, eligible immediately. If `delay >= ttl` (or `scheduledAt >= expires_at`), the engine raises an error at enqueue time.

Ordering once eligible: `priority ASC, COALESCE(scheduled_at, created_at) ASC, id ASC`. Lower priority number = higher urgency (0 is highest).

### Priority

- `priority: number` — optional. Lower number = higher urgency. Default: `0`.
- Messages with lower priority numbers are claimed before messages with higher numbers.
- Among messages with the same priority, FIFO ordering applies (by scheduled/created time, then id).
- Priority is preserved on redrive.

### Workflow-internal API

```typescript
ctx.queues.notifications.enqueue({ userId: "u1", body: "Hello" });
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Urgent" },
  { ttl: 300 },
);
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Reminder" },
  { delay: 3600 },
);
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Renew your subscription" },
  { scheduledAt: addDays(ctx.date, 30) },
);
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Weekly digest" },
  { priority: 10 },  // lower urgency than default (0)
);
```

- Synchronous buffered operation — returns `void`, not awaited.
- Workflow can only enqueue, never read.
- Available in both `WorkflowContext` and `CompensationContext`.
- Exactly-once enqueue: insert is colocated in the workflow's batch commit transaction. On replay, the existing record is detected and the re-insert is skipped.

### Client registration API

```typescript
const unregister = client.registerQueueHandler(
  notificationsQueue,
  async ({ signal }, message) => {
    await sendEmail(message.userId, message.body, { signal });
  },
  {
    retryPolicy: {
      timeoutSeconds: 30,
      maxAttempts: 5,
      intervalSeconds: 2,
      backoffRate: 2,
      maxIntervalSeconds: 60,
    },
  },
);

unregister();
```

The handler receives `{ signal: AbortSignal }` as its first argument. The signal fires after `retryPolicy.timeoutSeconds` per attempt. `maxAttempts` is meaningful for queues: after exhaustion, the message is dead-lettered with `max_attempts`. Failed attempts are written to `queue_message_attempt` — only failures are recorded, successful processing writes the result directly. All retry policy fields are in seconds (durable, persisted to DB).

### Dead-letter client API

```typescript
const dl = client.deadLetters(notificationsQueue);

const { messages, nextCursor } = await dl.list({
  sort: [{ namespace: "record", path: "deadLetteredAt", direction: "desc" }],
  filter: (q) =>
    q.and(q.record.reason.eq("max_attempts"), q.payload.userId.eq("u1")),
});

await dl.redriveAll({
  filter: (q) => q.record.reason.eq("max_attempts"),
  ttl: 3600,
});
await dl.discardAll({ filter: (q) => q.record.reason.eq("ttl_expired") });

const unsubscribe = dl.listen(
  async (msg) => {
    await dl.redrive({ ids: [msg.id], ttl: 3600 });
  },
  { filter: (q) => q.record.reason.eq("max_attempts") },
);
```

**`DeadLetterHandle<TMessage>` methods:** `list`, `count`, `redrive`, `redriveAll`, `discard`, `discardAll`, `listen`.

**Redrive TTL behavior:** On redrive, `status` resets to `pending`, `attempt_count` resets to zero, `priority` is preserved. If `ttl` provided, `expires_at = NOW() + ttl`; if `ttl: null`, never expires; if omitted, `defaultTTL` re-applied.

### Postgres implementation

```sql
CREATE TABLE queue_messages (
  id                                BIGSERIAL PRIMARY KEY,
  queue_name                        TEXT NOT NULL,
  payload                           JSONB NOT NULL,
  status                            TEXT NOT NULL DEFAULT 'pending',
  priority                          INT NOT NULL DEFAULT 0,
  attempt_count                     INT NOT NULL DEFAULT 0,
  dead_letter_reason                TEXT,
  scheduled_at                      TIMESTAMPTZ,
  expires_at                        TIMESTAMPTZ,
  claimed_at                        TIMESTAMPTZ,
  dead_lettered_at                  TIMESTAMPTZ,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_retention_deadline_at   TIMESTAMPTZ,
  dead_letter_retention_deadline_at TIMESTAMPTZ,

  CONSTRAINT chk_status CHECK (
    status IN ('pending', 'claimed', 'processed', 'dead_lettered')
  ),
  CONSTRAINT chk_dead_letter_reason CHECK (
    dead_letter_reason IS NULL OR dead_letter_reason IN ('max_attempts', 'ttl_expired')
  ),
  CONSTRAINT chk_schedule_before_expiry CHECK (
    scheduled_at IS NULL OR expires_at IS NULL OR scheduled_at < expires_at
  )
);

CREATE TABLE queue_message_attempt (
  id              BIGSERIAL PRIMARY KEY,
  message_id      BIGINT NOT NULL REFERENCES queue_messages(id) ON DELETE CASCADE,
  attempt         INT NOT NULL,
  error_message   TEXT,
  error_type      TEXT,
  error_details   JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at       TIMESTAMPTZ NOT NULL
);
```

**Consumer claim:**

```sql
SELECT * FROM queue_messages
WHERE queue_name = $1
  AND status = 'pending'
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (scheduled_at IS NULL OR scheduled_at <= NOW())
ORDER BY priority ASC, COALESCE(scheduled_at, created_at) ASC, id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

---

## Part 11: Requests

### Purpose

A global typed request-response primitive. A workflow posts a typed request and blocks until a registered handler returns a typed response. The workflow does not know who handles the request.

### Definition

```typescript
const humanReview = defineRequest({
  name: "humanReview",
  request: z.object({ context: z.string(), data: z.unknown() }),
  response: z.object({
    decision: z.enum(["approve", "reject"]),
    note: z.string(),
  }),
  retention: {
    resolved: 86400,
    timedOut: 86400 * 7,
    cancelled: 3600,
  },
});
```

### Workflow-internal API

Requests are Tier 1 but NOT `StepCall` instances. They have their own call type extending `DeterministicAwaitable` directly. Timeout is controlled via the `.timeout()` builder, following the same pattern as `StepCall` — not as a constructor option.

```typescript
// Wait indefinitely (no .timeout() chained)
const result = await ctx.requests
  .humanReview({ context: "...", data: signals })
  .compensate(async (ctx, result) => {
    /* ... */
  })
  .resolve(ctx);

// With timeout + fallback
const result = await ctx.requests
  .humanReview({ context: "...", data: signals })
  .compensate(async (ctx, result) => {
    /* ... */
  })
  .timeout(300, () => null)
  .complete((r) => r.decision)
  .resolve(ctx);
// result: "approve" | "reject" | null

// With deadline
const result = await ctx.requests
  .humanReview({ context: "...", data: signals })
  .timeout(new Date("2027-01-10T08:00:00Z"), () => null)
  .resolve(ctx);
```

### `RequestCall` type

```typescript
interface RequestCall<
  T,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
  Called extends string = never,
> extends DeterministicAwaitable<T | TTimeout, ExecutionRoot> {
  compensate: "compensate" extends Called ? never :
    & ((
        cb: (ctx: Tctx, result: RequestCompensationResult<T>) => Promise<void>,
      ) => RequestCall<T, TTimeout, true, Tctx, Called | "compensate">)
    & ((
        name: string,
        cb: (ctx: Tctx, result: RequestCompensationResult<T>) => Promise<void>,
      ) => RequestCall<T, TTimeout, true, Tctx, Called | "compensate">);

  timeout: "timeout" extends Called ? never :
    & ((secondsOrDeadline: number | Date) =>
        RequestCall<T, never, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(secondsOrDeadline: number | Date, cb: () => R) =>
        RequestCall<T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">)
    & ((opts: StepBoundary) =>
        RequestCall<T, never, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(opts: StepBoundary, cb: () => R) =>
        RequestCall<T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">);

  complete: "complete" extends Called ? never :
    <R>(cb: (data: T) => R) =>
      RequestCall<Awaited<R>, TTimeout, HasCompensation, Tctx, Called | "complete">;
}
```

### Compensation semantics

```typescript
type RequestCompensationResult<TResponse> =
  | { status: "complete"; data: TResponse }
  | { status: "attempted" };
```

| Scenario                     | Compensation? | result.status |
| ---------------------------- | ------------- | ------------- |
| Resolved + workflow succeeds | No            | —             |
| Resolved + workflow fails    | Yes (LIFO)    | `"complete"`  |
| Timeout + ever claimed       | Yes (eager)   | `"attempted"` |
| Timeout + never claimed      | No            | Row deleted   |

### Retry policy and exhaustion

The workflow caller does NOT control retry behavior. The caller controls only payload and timeout (via `.timeout()` builder). Retry policy is the handler's concern.

The handler registration supports an **eager attempt → exhaustion fallback** pattern. The handler tries to resolve the request programmatically. If all attempts are exhausted or the overall timeout is reached, the `onExhausted` callback is invoked. The callback can either:

1. **Return a result** — the request is resolved with this fallback value. The workflow unblocks with the fallback. Status: `"resolved"`.
2. **Return `MANUAL`** (sentinel) — the request transitions to `status = 'manual'` and waits for external resolution (e.g., a human operator or third-party system resolving it via the client API). The workflow stays blocked.

When `onExhausted` is omitted, the default behavior is `MANUAL` — the request silently transitions to manual mode. This is the safest default: no data is lost, nothing is auto-resolved with potentially incorrect fallback data.

If `onExhausted` throws, it is retried according to `onExhausted.retryPolicy` — a runtime-level retry policy with milliseconds precision, retrying infinitely until the callback succeeds or the request is resolved externally. The callback receives `{ signal: AbortSignal }` that fires if the request is resolved externally (e.g., an admin resolves it by hand) while the callback is retrying, interrupting the retry loop.

Failed handler attempts are written to the `request_attempt` table. Only failures are recorded — successful resolution writes the response directly. This enables inspection of attempt history and reliable scheduling of the next retry.

### `MANUAL` sentinel

```typescript
declare const MANUAL: unique symbol;
```

A module-level export. Returned from `onExhausted` to signal that the request should transition to manual mode.

### Client registration API

**Example: retry with notification and manual fallback**

```typescript
const unregister = client.registerRequestHandler(
  humanReview,
  async ({ signal }, request) => {
    const decision = await routeToHumanUI(request, { signal });
    return { decision, note: "reviewed" };
  },
  {
    retryPolicy: {
      timeoutSeconds: 60,
      maxAttempts: 3,
      totalTimeoutSeconds: 300,
      intervalSeconds: 5,
      backoffRate: 2,
      maxIntervalSeconds: 120,
    },
    onExhausted: {
      callback: async ({ signal }, request) => {
        await notifyOpsTeam(request, { signal });
        return MANUAL;
      },
      retryPolicy: {
        intervalMs: 5000,
        backoffRate: 1.5,
        maxIntervalMs: 60_000,
      },
    },
  },
);
```

**Example: try once, default to manual (event-driven resolution)**

```typescript
const unregister = client.registerRequestHandler(
  reserveHotel,
  async ({ signal }, request) => {
    const hotel = await db.findAvailableHotel(request, { signal });
    if (hotel) return { hotelId: hotel.id, confirmation: hotel.confirmation };
    throw new Error("No matching hotel available");
  },
  {
    retryPolicy: {
      timeoutSeconds: 10,
      maxAttempts: 1,
    },
    // onExhausted omitted → default is MANUAL
    // Request sits in DB with status='manual' until an external event resolves it
  },
);
```

**Example: exhaustion with fallback value**

```typescript
const unregister = client.registerRequestHandler(
  humanReview,
  async ({ signal }, request) => {
    const decision = await routeToHumanUI(request, { signal });
    return { decision, note: "reviewed" };
  },
  {
    retryPolicy: {
      timeoutSeconds: 60,
      maxAttempts: 3,
      intervalSeconds: 5,
      backoffRate: 2,
      maxIntervalSeconds: 120,
    },
    onExhausted: {
      callback: async ({ signal }, request) => {
        // Return a fallback result — request is resolved, workflow unblocks
        return { decision: "reject", note: "auto-rejected after timeout" };
      },
      retryPolicy: {
        intervalMs: 1000,
        backoffRate: 2,
        maxIntervalMs: 30_000,
      },
    },
  },
);
```

**Handler options:**

- `retryPolicy` — handler retry policy (durable, seconds, persisted to DB):
  - `timeoutSeconds` — per-attempt execution timeout. The handler receives `{ signal: AbortSignal }` as first argument; the signal fires after this duration.
  - `maxAttempts` — max handler attempts before exhaustion. Optional — if omitted, only `totalTimeoutSeconds` controls exhaustion.
  - `totalTimeoutSeconds` — overall wall-clock timeout for all attempts. Optional — if omitted, only `maxAttempts` controls exhaustion.
  - `intervalSeconds`, `backoffRate`, `maxIntervalSeconds` — retry spacing.
- `onExhausted.callback` — called when handler attempts are exhausted. Receives `{ signal: AbortSignal }` (fires if request is resolved externally) and the request payload. Returns either a typed result (fallback) or `MANUAL` (sentinel). If omitted, defaults to `MANUAL`.
- `onExhausted.retryPolicy` — runtime-level retry policy (milliseconds, infinite) for when `onExhausted.callback` throws. `intervalMs`, `backoffRate`, `maxIntervalMs`.

At least one of `retryPolicy.maxAttempts` or `retryPolicy.totalTimeoutSeconds` must be provided. Without either, the handler retries forever and never reaches exhaustion — if that is the desired behavior, `onExhausted` should be omitted entirely and the handler is responsible for eventual resolution.

### Postgres implementation

```sql
CREATE TABLE requests (
  id                      BIGSERIAL PRIMARY KEY,
  request_name            TEXT NOT NULL,
  payload                 JSONB NOT NULL,
  response                JSONB,
  status                  TEXT NOT NULL DEFAULT 'pending',
  claimed_at              TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  timed_out_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_deadline_at   TIMESTAMPTZ,

  CONSTRAINT chk_status CHECK (
    status IN ('pending', 'claimed', 'resolved', 'manual', 'timedOut', 'cancelled')
  )
);
```

Compensation trigger: `EXISTS (SELECT 1 FROM request_attempt WHERE request_id = $id)`. If no attempt rows exist, no work was done — compensation is skipped.

---

## Part 12: Topics

### Purpose

A global ordered append log per topic, with named independent consumers. Multiple workflows publish, multiple named consumers track their own read positions.

### Definition

```typescript
const auditTopic = defineTopic({
  name: "auditEvents",
  record: z.object({ type: z.string(), payload: z.unknown() }),
  metadata: z.object({ tenantId: z.string(), type: z.string() }),
  retentionSeconds: 86400 * 7,
});
```

### Workflow-internal API

```typescript
ctx.topics.auditEvents.publish(
  { type: "booking.confirmed", payload: { orderId: "o1" } },
  { metadata: { tenantId: "acme", type: "booking.confirmed" } },
);
```

Synchronous buffered operation — returns `void`, not awaited. Publish only, never consume. Available in both contexts.

### Client registration API

```typescript
const unregister = client.registerTopicConsumer(
  auditTopic,
  "analyticsConsumer",
  async ({ signal }, record) => {
    if (record.metadata?.tenantId !== "acme") return;
    await ingestToWarehouse(record, { signal });
  },
  {
    retryPolicy: {
      timeoutSeconds: 10,
      maxAttempts: 5,
      intervalSeconds: 1,
      backoffRate: 2,
      maxIntervalSeconds: 30,
    },
    registration: {
      retryPolicy: {
        intervalMs: 5000,
        backoffRate: 1.5,
        maxIntervalMs: 60_000,
      },
      onRegistered: () => {
        logger.info("Consumer registered, consuming records");
      },
      onError: (event) => {
        logger.warn("Topic consumer lock conflict", event.error);
      },
    },
    onConsumeError: {
      callback: async ({ signal }, event) => {
        if (event.type === "attemptsExhausted") {
          // event.attempts: AttemptAccessor — inspect error history
          return "skip";
        }
        if (event.type === "offsetExpired") return "skip";
        return "halt";
      },
      retryPolicy: {
        intervalMs: 1000,
        backoffRate: 2,
        maxIntervalMs: 30_000,
      },
    },
  },
);
```

**Consumer handler:**

The consumer callback receives `{ signal: AbortSignal }` as its first argument. The signal fires after `retryPolicy.timeoutSeconds` per attempt. Failed attempts are written to a `topic_consumer_attempt` table (FK on consumer + record) — only failures are recorded, successful processing advances the offset. All retry policy fields are in seconds (durable, persisted to DB).

**Registration options (`registration`):**

- `registration.retryPolicy` — runtime-level retry policy (milliseconds, infinite) for re-acquiring the advisory lock after a failed registration attempt. Purely runtime — never persisted.
- `registration.onRegistered` — called when the consumer successfully acquires the advisory lock and becomes active. Useful for logging, metrics, readiness probes. Purely runtime notification.
- `registration.onError` — called when a registration attempt fails (e.g., advisory lock conflict). Purely runtime notification.

**Consume error handling (`onConsumeError`):**

When record processing exhausts its `retryPolicy.maxAttempts` or the consumer's offset has expired, the engine needs a decision: `"skip"` (advance past the record) or `"halt"` (stop consuming). The `onConsumeError` callback makes this decision.

- `onConsumeError.callback` — receives `{ signal: AbortSignal }` (fires on consumer shutdown) and an event. Returns `"skip"` or `"halt"`.
  - `event.type === "attemptsExhausted"`: record processing failed after all retry attempts. `event.attempts: AttemptAccessor` provides the error history for informed decisions.
  - `event.type === "offsetExpired"`: the consumer's offset points to records that have been purged by retention. The consumer must skip ahead.
- `onConsumeError.retryPolicy` — runtime-level retry policy (milliseconds, infinite) for when the callback throws. `intervalMs`, `backoffRate`, `maxIntervalMs`. If the callback keeps failing, the consumer halts (safe default — don't silently skip messages).

**Defaults when `onConsumeError` is omitted:**

| Event type         | Default behavior |
| ------------------ | ---------------- |
| `attemptsExhausted` | `"halt"`         |
| `offsetExpired`     | `"skip"`         |

`"halt"` for exhausted attempts is the safe default — it prevents silently dropping messages that may need attention. `"skip"` for expired offsets is the only viable option — the records are gone.

**If `onConsumeError.callback` exhausts its own retries** (keeps throwing), the consumer halts. This prevents an infinite loop where the decision callback itself is broken.

Consumer identity is enforced via session-level Postgres advisory locks. One active instance per named consumer per topic at a time.

### Insert ordering guarantee

Per-topic transaction-scoped advisory locks serialize commits for the same topic, eliminating the visibility hazard where a consumer could advance past a not-yet-committed record.

### Postgres implementation

```sql
CREATE TABLE topic_records (
  id          BIGSERIAL PRIMARY KEY,
  topic_name  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON topic_records (topic_name, id);

CREATE TABLE topic_consumers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  topic_name     TEXT NOT NULL,
  last_id        BIGINT NOT NULL DEFAULT 0,
  offset_expired BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at   TIMESTAMPTZ,
  UNIQUE (topic_name, name)
);

CREATE TABLE topic_consumer_attempt (
  id              BIGSERIAL PRIMARY KEY,
  consumer_id     BIGINT NOT NULL REFERENCES topic_consumers(id) ON DELETE CASCADE,
  record_id       BIGINT NOT NULL REFERENCES topic_records(id) ON DELETE CASCADE,
  attempt         INT NOT NULL,
  error_message   TEXT,
  error_type      TEXT,
  error_details   JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at       TIMESTAMPTZ NOT NULL
);
```

**Liveness-based retention sweeper:** classifies consumers as live or dead (based on advisory lock status and `last_seen_at` grace period). Deletes records that are both behind all live consumers AND older than `retentionSeconds`. Marks dead consumers with expired offsets via `offset_expired = TRUE`.

---

## Part 13: Attributes

### Purpose

An observable single current value on a workflow instance. Externally readable, workflow-writable.

### Workflow-internal API

```typescript
ctx.attributes.progress.set({ percent: 0.75, phase: "finalizing" });
```

Synchronous buffered operation — returns `void`, not awaited. Set only, never read. Available in both contexts.

### External handle API

```typescript
// Blocking — long-poll via LISTEN/NOTIFY
const result = await handle.attributes.progress.get({
  afterVersion: 3,
  signal,
});
// { status: "ok", value: T, version: number } | { status: "never" }

// Non-blocking
const current = await handle.attributes.progress.getNowait();
// { status: "ok", value: T, version: number } | { status: "not_set" }
```

### Postgres implementation

```sql
CREATE TABLE workflow_attributes (
  workflow_id    TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  value          JSONB NOT NULL,
  version        BIGINT NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, attribute_name)
);
```

Per-instance, per-attribute `NOTIFY` channels for efficient long-polling without thundering herd. `{ status: "never" }` driven by `wf_ended:<workflow_id>` notification on workflow termination.

---

## Part 14: Streams Extension

### `readNowait` on external handle

```typescript
readNowait(offset: number): Promise<StreamReadResult<T> | { status: "not_found" }>
readNowait(offset: number, defaultValue: D): Promise<StreamReadResult<T> | { status: "not_found"; value: D }>
```

Non-blocking read at a specific offset. Mirrors `receiveNowait()` on channels and `getNowait()` on attributes.

### Channel `receive` deadline support

`channel.receive()` now accepts `Date` as a deadline in addition to `number` (seconds timeout):

```typescript
receive(timeoutOrDeadline: number | Date): ChannelReceiveCall<T | undefined>;
receive<TDefault>(
  timeoutOrDeadline: number | Date,
  defaultValue: TDefault,
): ChannelReceiveCall<T | TDefault>;
```

When a `Date` is provided, the receive blocks until a message arrives or the absolute deadline is reached. When a `number` is provided, it behaves as before — relative timeout in seconds.

---

## Part 15: AttemptAccessor Refactoring

### Changes

**Rename `StepErrorAccessor` → `AttemptAccessor`:** shared interface for lazy access to per-attempt records across steps, queue dead-lettered messages, topic consumer failures, and request handler failures.

**Rename `StepExecutionError` → `Attempt`:** the previous name leaked the step origin into a type shared across all attempt-bearing contexts. A queue handler's dead-letter inspection should not surface a "StepExecutionError." The new name is context-neutral and reflects that an attempt is not always erroneous — it may have ended abruptly (process crash, signal abort) with no error information captured.

**Introduce `AttemptError` class:** a throwable `Error` subclass that handlers can use to attach structured, JSON-serializable details to failures. When the engine catches an `AttemptError`, it persists `type`, `message`, and `details` directly. When it catches a plain `Error`, it extracts `message` and `constructor.name`. When it catches any other thrown value, it best-efforts `String(thrown)` for the message. This means all error fields on the `Attempt` record are nullable — JavaScript's `throw` can throw anything, including values with no message, no type, and no details.

**Unify attempt record shape:** all attempt-bearing subsystems (steps, queue handlers, topic consumers, request handlers) share the same DB column pattern: `attempt`, `error_message`, `error_type`, `error_details`, `started_at`, `failed_at`. Error columns are nullable (a thrown `undefined` or an abruptly terminated attempt has no error info). The public type reflects this with `startedAt` and `failedAt` (both `Date`), replacing the old single `timestamp` field. This captures attempt duration — useful for diagnosing slow failures vs immediate crashes.

**`count` property → `count()` async method:** consistent with the fully lazy interface.

**Rename `errors` → `attempts` on `StepCompensationResult`:** accurate in all variants.

### `AttemptError` (throwable class)

A structured error class for handler code (step execute, queue handlers, topic consumers, request handlers). Extends `Error`. Not generic — `details` is typed as `JsonInput` (any JSON-serializable value) at the throw site.

```typescript
class AttemptError extends Error {
  /** Stable error classifier (e.g. "ValidationError", "NetworkError"). */
  readonly type: string | undefined;
  /** JSON-serializable structured details. */
  readonly details: JsonInput | undefined;

  constructor(options?: {
    type?: string;
    message?: string;
    details?: JsonInput;
  });
}
```

**Engine extraction rules** when catching a thrown value:

| Thrown value | `error_type` | `error_message` | `error_details` |
| --- | --- | --- | --- |
| `AttemptError` instance | `.type` | `.message` | `.details` |
| `Error` instance | `.constructor.name` | `.message` | `null` |
| `string` | `null` | the string | `null` |
| anything else | `null` | `String(thrown)` | `null` |

### `Attempt` (read-side record)

A plain data record representing a single persisted attempt. All error fields are nullable — the attempt may have been abrupt (no clean failure captured), or the thrown value may not have carried the relevant information.

```typescript
interface Attempt {
  /** 1-indexed attempt number */
  readonly attempt: number;
  /** When the attempt started */
  readonly startedAt: Date;
  /** When the attempt was recorded as failed */
  readonly failedAt: Date;
  /** Error message (null if unknown) */
  readonly message: string | null;
  /** Error classifier / class name (null if unknown) */
  readonly type: string | null;
  /** Structured details (undefined if not provided) */
  readonly details: JsonInput | undefined;
}
```

### `AttemptAccessor`

```typescript
interface AttemptAccessor {
  last(): Promise<Attempt>;
  all(): Promise<Attempt[]>;
  count(): Promise<number>;
  [Symbol.asyncIterator](): AsyncIterableIterator<Attempt>;
  reverse(): AsyncIterable<Attempt>;
}
```

---

## Part 16: Scheduled Delivery

### `ScheduleOptions` type

```typescript
export type ScheduleOptions =
  | { delaySeconds: number; scheduledAt?: never }
  | { scheduledAt: Date; delaySeconds?: never }
  | { delaySeconds?: undefined; scheduledAt?: undefined };
```

### Queue messages

Described in Part 10. `enqueue` opts accept `delay: number` (seconds) or `scheduledAt: Date`.

### Workflow starts

`ScheduleOptions` is intersected into `StartWorkflowOptions` and `ChildWorkflowStartOptions`. `CompensationChildWorkflowStartOptions` intentionally does NOT receive `ScheduleOptions`.

```typescript
const handle = await client.workflows.order.start({
  idempotencyKey: "order-jan-2027",
  scheduledAt: new Date("2027-01-10T08:00:00Z"),
  args: { destination: "Paris", customerId: "cust-123" },
});

await ctx.childWorkflows.followUp.startDetached({
  idempotencyKey: "follow-up-next-day",
  delaySeconds: 86400,
  args: { parentId: ctx.instanceId },
});
```

The deadline clock starts from creation time, not scheduled start. If `delaySeconds >= deadlineSeconds`, the engine raises an error.

---

## Part 17: `idempotencyKeyFactory`

### Problem

`idempotencyKey` is currently optional on workflow start calls. This means some workflow instances may lack a meaningful external identifier, making error tracing, deduplication, and child workflow identity incomplete.

### Solution

Make `idempotencyKey` required on all workflow start calls. To avoid boilerplate when the key can be deterministically derived from the workflow arguments, introduce `idempotencyKeyFactory` on `defineWorkflow`:

```typescript
defineWorkflow({
  name: "orderWorkflow",
  args: z.object({ orderId: z.string(), customerId: z.string() }),
  idempotencyKeyFactory: (args) => `order-${args.orderId}`,
  // ...
});
```

The factory receives the post-validation args (same as the `execute` callback) and returns a `string`. When a factory is defined, `idempotencyKey` becomes optional on start calls — the factory generates it from the args. An explicit `idempotencyKey` overrides the factory.

```typescript
// With factory: key auto-generated from args → "order-o-123"
await client.workflows.order.start({
  args: { orderId: "o-123", customerId: "cust-456" },
});

// With factory: explicit key overrides → "custom-key"
await client.workflows.order.start({
  idempotencyKey: "custom-key",
  args: { orderId: "o-123", customerId: "cust-456" },
});

// Without factory: key is required
await client.workflows.other.start({
  idempotencyKey: "explicit-key",
  args: { ... },
});
```

### Type

```typescript
type StartWorkflowOptions<TArgs, HasFactory extends boolean> =
  HasFactory extends true
    ? { args: TArgs; idempotencyKey?: string } & ScheduleOptions
    : { args: TArgs; idempotencyKey: string } & ScheduleOptions;
```

The same conditionality applies to `ctx.childWorkflows.X.start(...)` and `ctx.childWorkflows.X.startDetached(...)`.

---

## Part 18: Serializable Step Arguments

### Problem

Step arguments are currently regular TypeScript function parameters — positional, untyped at the persistence level, and invisible in the database. Every other input in the system (workflow args, request payloads, queue messages, channel messages, error details) is schema-constrained and serialized to JSONB. Step args are the sole outlier. This means:

- Step timeout errors cannot carry typed args to the external caller.
- Step compensation callbacks don't know what args were passed.
- Failed step attempts in the database have no record of the input.
- Observability tooling cannot inspect step invocations.

### Solution

Add an `args` schema to `defineStep`. Rename the existing `schema` field to `result`. Step arguments become a single schema-validated object (not positional), consistent with workflows, requests, and queues.

**Before:**

```typescript
const bookFlight = defineStep({
  name: "bookFlight",
  schema: z.object({ confirmationId: z.string() }),
  execute: async ({ signal }, destination: string, passengerId: string) => {
    const booking = await flightAPI.book(destination, passengerId, { signal });
    return { confirmationId: booking.id };
  },
});
```

**After:**

```typescript
const bookFlight = defineStep({
  name: "bookFlight",
  args: z.object({ destination: z.string(), passengerId: z.string() }),
  result: z.object({ confirmationId: z.string() }),
  execute: async ({ signal }, args) => {
    const booking = await flightAPI.book(args.destination, args.passengerId, { signal });
    return { confirmationId: booking.id };
  },
});
```

The call site changes from positional args to a single object:

**Before:** `ctx.steps.bookFlight("Paris", "p-123")`

**After:** `ctx.steps.bookFlight({ destination: "Paris", passengerId: "p-123" })`

The `args` field is a `JsonSchemaConstraint` — the same constraint as everything else that goes into JSONB. Arguments are serialized into the step record alongside the result, enabling full observability: the database records what was attempted, failed attempts carry the input, and timeout errors at the external boundary include typed args.

### Input/Output convention

The codebase follows a strict encode-on-write, decode-on-read discipline using `StandardSchemaV1`'s two type parameters. Standard Schema does not support bidirectional transforms (there is no `encode(Output) → Input`), so the write side must always accept `InferInput` (the JSON-serializable form):

- **Call sites** (write side) accept `InferInput`: `ctx.steps.X(args)`, `ctx.childWorkflows.X.start({ args })`, `ctx.errors.X(message, details)`, `channel.send(data)`, `stream.write(data)`. The developer provides the serializable form.
- **Callbacks** (read side) receive `InferOutput`: `execute({ signal }, args)`, `beforeSettle`, compensation callbacks, `idempotencyKeyFactory(args)`. The engine deserializes from the database and validates through the schema, producing the decoded form.
- **External results** (read side) are typed as `InferOutput`: step results, workflow results, error details, timeout error args. The external caller receives the decoded form.

For most schemas (no transforms), `InferInput` and `InferOutput` are identical and the distinction is invisible. The distinction only matters for schemas with transforms (e.g., `z.string().datetime()` where input is `string` and output is `Date`).

---

## Summary of Public API Changes

### New `defineWorkflow` options

```typescript
defineWorkflow({
  queues:                { [name: string]: QueueDefinition<M> },
  requests:              { [name: string]: RequestDefinition<Req, Res> },
  topics:                { [name: string]: TopicDefinition<R, Meta> },
  attributes:            { [name: string]: JsonSchemaConstraint },
  errors:                { [name: string]: JsonSchemaConstraint | true },
  idempotencyKeyFactory: (args: InferOutput<TArgs>) => string,  // optional
});
```

### `defineStep` changes

```typescript
defineStep({
  name: string,
  args: JsonSchemaConstraint,      // NEW — serializable args schema
  result: JsonSchemaConstraint,    // renamed from `schema`
  execute: ({ signal }, args) => Promise<Result>,  // single object arg, not positional
  retryPolicy?: RetryPolicyOptions,
});
```

### `WorkflowContext` changes

| Change                                  | Details                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ctx.queues.X.enqueue(payload, opts?)`  | Sync buffered, both contexts                                                             |
| `ctx.requests.X(payload)`               | Tier 1, both contexts (no `.compensate()` in `CompensationContext`). Timeout via builder. |
| `ctx.topics.X.publish(payload, opts?)`  | Sync buffered, both contexts                                                             |
| `ctx.attributes.X.set(value)`           | Sync buffered, both contexts                                                             |
| `ctx.errors.X(message, details?)`       | Factory functions for declared error classes. Keyed by error name.                       |
| `ctx.registerCompensation(name, cb)`    | Sync buffered, `WorkflowContext` only. Registers deferred LIFO compensation.             |
| `ctx.compensateEagerly(name, cb)`       | Sync buffered, `WorkflowContext` only. Dispatches eager FIFO compensation.               |
| `ctx.joinSafe(handle, onError)`         | Available on concurrency contexts. Error handler returns recovery value.                 |
| `ctx.best(name, entries)`               | Tier 1, collects all successful results.                                                 |
| `ctx.atMost(name, n, entries)`          | Tier 1, collects at most N results.                                                      |
| `ctx.atLeast(name, n, entries)`         | Tier 1, collects at least N results (fails if fewer).                                    |
| `ctx.first(name, entries)`              | Now requires a name argument.                                                            |
| `ctx.all(name, entries)`                | Now requires a name argument.                                                            |
| `ctx.scope(name, entries, callback)`    | Unchanged (already named).                                                               |

### `StepCall` changes

| Change                                            | Details                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `.failure()` removed                              | Steps cannot fail — they succeed or time out.                                     |
| `.timeout(boundary, cb?)` added                   | Replaces `.failure()`. Accepts `number`, `Date`, or `StepBoundary`.               |
| `TFail` type parameter removed                    | Replaced by `TTimeout`.                                                           |
| `TArgs` type parameter added                      | Threads serializable args type through to compensation callbacks.                 |
| `.compensate()` accepts optional name              | `.compensate("name", cb)` for explicit identity.                                  |
| `Called` type parameter added                      | Builder methods resolve to `never` after first call — prevents duplicate chaining. |

### `WorkflowCall` changes

| Change                                | Details                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `.timeout(boundary, cb?)` added       | Parent-side patience. Accepts `number`, `Date`, or `StepBoundary`.                |
| `.compensate()` accepts optional name | `.compensate("name", cb)` for explicit identity.                                  |
| `Called` type parameter added          | Builder methods resolve to `never` after first call — prevents duplicate chaining. |

### `RetryPolicyOptions` changes (step-level)

| Change                | Details                                     |
| --------------------- | ------------------------------------------- |
| `maxAttempts` removed | Moved to `.timeout()` builder on `StepCall`. |

### Handler registration retry policy

All handler registrations (queue, request, topic) consolidate retry configuration into a single `retryPolicy` object containing both stop conditions (`timeoutSeconds`, `maxAttempts`, `totalTimeoutSeconds`) and spacing (`intervalSeconds`, `backoffRate`, `maxIntervalSeconds`). All fields are in seconds — these are durable execution concerns with attempts persisted to the database. Runtime-level retry policies (`registration.retryPolicy` on topic consumers, `onExhausted.retryPolicy` on request handlers, `onConsumeError.retryPolicy` on topic consumers) use milliseconds (`intervalMs`, `maxIntervalMs`) — purely runtime concerns, never persisted.

### Channel `receive` changes

| Change                          | Details                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `receive(Date)` overload added  | Absolute deadline support alongside `receive(seconds)` timeout. |

### New exports

- `defineQueue`, `defineRequest`, `defineTopic`
- `SearchQueryNode`, `SearchQuery`
- `DeadLetterRecordFields`, `DeadLetterSort`, `DeadLetterCursor`, `DeadLetteredMessage`, `DeadLetterHandle`
- `RequestCompensationResult`, `AttemptAccessor`, `Attempt`, `AttemptError`
- `WorkflowError`, `WorkflowErrorValue`, `WorkflowFailureInfo`
- `StepTimeoutError`, `RequestTimeoutError`, `ChildWorkflowError`, `ChildWorkflowTimeoutError`, `LooseWorkflowError`
- `StepBoundary`, `MAIN_BRANCH`, `BranchPathItem`, `MANUAL`
- `Unsubscribe`
- `RegisterTopicConsumerError`, `RegisterTopicConsumerErrorEvent`, `TopicConsumerAlreadyActiveError`, `TopicConsumerConsumeErrorEvent`
- `ScheduleOptions`
- `IWorkflowConnection`, `IWorkflowTransaction`
- `RetentionSetter`

### Breaking changes

- `StepErrorAccessor` renamed to `AttemptAccessor`.
- `StepExecutionError` renamed to `Attempt`. Fields changed: `timestamp: number` (epoch ms) replaced by `startedAt: Date` and `failedAt: Date`. Error fields (`message`, `type`, `details`) are now nullable — reflects that JavaScript can throw non-Error values and attempts can end abruptly.
- New `AttemptError` throwable class introduced for structured error reporting from handler code.
- `StepCompensationResult.errors` renamed to `.attempts`. `status: "failed"` renamed to `status: "timed_out"` with `reason: "attempts_exhausted" | "deadline"`.
- `StepCompensationResult` gains `args` field (typed by step's `args` schema). Now generic over `<TArgs, T>`.
- `StepErrorAccessor.count` (sync) → `AttemptAccessor.count()` (async).
- `StepCall.failure()` removed. Use `.timeout()`.
- `StepCall` gains `TArgs` type parameter for serializable step arguments.
- `StepFailureInfo` removed.
- `maxAttempts` removed from `RetryPolicyOptions`.
- `addCompensation()` renamed to `registerCompensation(name, cb)` (now named, now sync buffered).
- `ctx.first(entries)` → `ctx.first(name, entries)` (name required).
- `ctx.all(entries)` → `ctx.all(name, entries)` (name required).
- `RetentionSettings` → `RetentionSetter<TStatus extends string>`.
- Unhandled exceptions now halt the workflow instead of failing it (only declared `ctx.errors` cause failure).
- `WorkflowError` is no longer subclassed. Errors are defined as `{ name: schema | true }` on `defineWorkflow`. `ctx.errors.X(...)` factory functions replace direct `throw new WorkflowError(...)`.
- Throwing a `WorkflowError` with an undeclared `errorCode` halts the workflow instead of failing it.
- External error types use `type` as the unified discriminant field: `"WorkflowError"`, `"StepTimeoutError"`, `"RequestTimeoutError"`, `"ChildWorkflowError"`, `"ChildWorkflowTimeoutError"`.
- Created `ChildWorkflowError` (with recursively nested `LooseWorkflowError`) and `ChildWorkflowTimeoutError`.
- Queue `publish` renamed to `enqueue` (`ctx.queues.X.enqueue(...)`).
- `ctx.joinSafe(handle)` → `ctx.joinSafe(handle, onError)` (error handler callback, not discriminated union).
- Branch key path representation changed from `(string | Symbol)[]` to `BranchPathItem[]` (`{ scope, branch }` objects with `MAIN_BRANCH` unique symbol).
- `topic_consumer_offsets` table removed — `last_id` merged into `topic_consumers`.
- Request workflow API: `timeout` removed from call options — use `.timeout()` builder instead.
- Builder methods on `StepCall`, `WorkflowCall`, `RequestCall` resolve to `never` after first call (prevents duplicate chaining via `Called` type parameter).
- All handler registration callbacks (`queue`, `request`, `topic`) now receive `{ signal: AbortSignal }` as first argument.
- Handler retry policies use seconds (`intervalSeconds`, `maxIntervalSeconds`) instead of milliseconds. Runtime-level retry policies remain in milliseconds.
- Topic consumer: `registrationRetry` and `onRegisterError` restructured into `registration: { retryPolicy, onRegistered, onError }`. `onConsumeError` restructured into `onConsumeError: { callback, retryPolicy }` with defined throw/retry behavior.
- `.timeout()` on `StepCall` and `WorkflowCall` now accepts `Date` (deadline) in addition to `number` (seconds).
- `channel.receive()` now accepts `Date` (deadline) in addition to `number` (seconds timeout).
- `StepDefinition.schema` renamed to `result`. New `args` field added (required `JsonSchemaConstraint`).
- Step call sites: positional arguments replaced by single schema-validated object (`ctx.steps.X({ ... })`).
- Step `execute` callback: `({ signal }, ...args: TArgs)` → `({ signal }, args: InferOutput<TArgsSchema>)`.
- `idempotencyKey` is now required on all workflow start calls (client, child workflow, detached). Optional if `idempotencyKeyFactory` is defined on the workflow.
- `idempotencyKeyFactory` receives post-validation args (same as `execute`).
- VEL execution strategy: branch interleaving order within a scope is an implementation detail. Workflow logic must not rely on it.
- Buffered operations (`stream.write`, `event.set`, `attribute.set`, `queue.enqueue`, `topic.publish`, `channel.send` (foreign), `registerCompensation`, `compensateEagerly`, `startDetached`) are now synchronous — they return `void` and are not `await`ed. `DirectAwaitable<void>` is removed for these operations.
- Step records are batched and committed in a single transaction when all branches are blocked. Side-effecting work (step execution, child workflow dispatch, request dispatch) starts only after the batch commit.
- `receiveNowait` and `patch` are awaitable reads — they trigger a buffer flush before reading from committed state.

### Connection and transaction model

Two opaque types:

```typescript
type IWorkflowConnection;
type IWorkflowTransaction;
```

Client and engine-level CRUD APIs accept optional `txOrConn?: IWorkflowTransaction | IWorkflowConnection`. Workflow logic (`ctx.*`) is entirely exempt — it runs inside the engine's own durable execution transaction. Blocking operations and subscriptions are also exempt.
