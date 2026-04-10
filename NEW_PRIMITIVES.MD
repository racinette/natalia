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
7. **Scheduled delivery** — `delay`/`scheduledAt` option on queue message publish and workflow starts

**Architectural changes** — corrections and redesigns to existing engine behavior:

8. **Virtual Event Loop (VEL)** — deterministic concurrent execution model
9. **Compensation model redesign** — parallel compensation VEL, eager/deferred separation, structured compensation lifecycle
10. **Halt model** — unified soft failure mechanism for unexpected exceptions
11. **`WorkflowError` class** — explicit vs accidental failure distinction
12. **Step timeout unification** — `maxAttempts` moves from retry policy to `.timeout()` builder
13. **AttemptAccessor refactoring** — rename `StepErrorAccessor` → `AttemptAccessor`, make `count()` async
14. **Context splitting** — separate primitive instances for execution and compensation VELs
15. **Convenience scope methods** — `ctx.best()`, `ctx.atMost()`, `ctx.atLeast()`, `ctx.joinSafe()`
16. **Database schema** — unified tree model for execution and compensation

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

1. **Non-concurrent code** executes as-is. Sequential operations within a single branch need no scheduling.

2. **Entering a scope** transitions to structured concurrency. The scope body is treated as a branch with a synthetic key (`Symbol("MAIN")`), placed first in the deterministic branch ordering.

3. **Branch ordering** is alphanumeric by key path. The key path is a `readonly (string | ScopeDivider | BranchDivider)[]` array that encodes the full nested scope lineage. For a scope `"A"` with branches `"foo"` and `"bar"`:

   ```
   ["A", Symbol("MAIN")]     ← scope body, always first
   ["A", "bar"]               ← alphanumeric order
   ["A", "foo"]
   ```

4. **Execute the first branch** in the sorted list until a genuine context switch point is reached.

5. **Tier 3 awaitables** (`DirectAwaitable`) are treated as sequential operations — no context switch. Stream writes, event sets, attribute sets, `receiveNowait()`, patches, compensation registrations — all complete atomically within the current branch.

6. **Tier 2 awaitables** (`WorkflowAwaitable`) block on external resolution: `sleep`, `channel.receive`. The engine records a step and promise, then context-switches to the next branch.

7. **Tier 1 awaitables** (`DeterministicAwaitable`) require two-phase execution:
   - **Start phase**: record a `start_step` / `start_child_workflow` / `send_request` step. Create a promise. Spin up the work (coroutine for steps, enqueue for workflows/requests).
   - **Await phase**: record an `await_promise` step referencing the created promise. Context-switch.

8. **Context switch**: move to the next branch in the sorted list. Execute it until it also reaches a context switch point. Continue until all branches are blocked.

9. **Promise resolution fetch**: all branches are blocked. Fetch resolved promises from the database. Each promise records a `sequence_no` on resolution, assigned from a Postgres sequence protected by a per-VEL advisory lock. This ensures deterministic ordering: no two promises from the same VEL can resolve with the same or out-of-order sequence numbers.

10. **Resume**: take the first resolved promise by sequence number. Resume the branch that was blocked on it. Execute until the next context switch.

11. **Continue**: if more resolved promises exist, resume the next. If none remain, fetch again. The cycle continues until the scope body returns or all branches complete.

### Nested scope ordering

Nested scopes exist on the same VEL — they do not create separate VELs. When a nested scope is entered, its branches are inserted into the global ordering by their full key path:

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

Initial ordering:

```
["A", Symbol("MAIN")]
["A", "bar"]
["A", "foo"]
```

After the scope body enters scope `"B"`:

```
["A", Symbol("MAIN")]
["A", Symbol("MAIN"), "B", Symbol("MAIN")]
["A", Symbol("MAIN"), "B", "baz"]
["A", Symbol("MAIN"), "B", "fuz"]
["A", "bar"]
["A", "foo"]
```

### Scope body priority

The scope body is always the first element in the branch ordering (via `Symbol("MAIN")` sorting before any string key). This gives it natural priority: it starts executing before any branches, and after any batch of resolved promises is processed, it gets first pick of resolutions. This allows the scope body to short-circuit before executing unnecessary branch logic, minimizing wasted work.

### Two VELs per workflow

Each workflow instance has exactly two independent VELs:

1. **Execution VEL** — runs the main workflow logic. Rooted at `workflow.execution_branch_id`.
2. **Compensation VEL** — runs all compensation work (eager and deferred). Rooted at `workflow.compensation_branch_id`.

Both VELs are created at workflow start time. The compensation VEL may remain empty if no compensations are registered. Each VEL has its own advisory lock namespace for promise resolution sequencing, ensuring complete independence.

### Step types

| Type                     | Tier      | Creates promise | Has `promise_id` |
| ------------------------ | --------- | --------------- | ---------------- |
| `start_step`             | 1 (start) | yes             | no               |
| `start_child_workflow`   | 1 (start) | yes             | no               |
| `send_request`           | 1 (start) | yes             | no               |
| `await_promise`          | 1 (await) | no              | **yes**          |
| `execute_scope`          | —         | no              | no               |
| `sleep`                  | 2         | yes             | yes              |
| `sleep_until`            | 2         | yes             | yes              |
| `channel_receive`        | 2         | yes             | yes              |
| `channel_receive_nowait` | 3         | no              | no               |
| `stream_write`           | 3         | no              | no               |
| `event_set`              | 3         | no              | no               |
| `attribute_set`          | 3         | no              | no               |
| `register_compensation`  | 3         | no              | no               |
| `eager_compensation`     | 3         | no              | no               |
| `patch_check`            | 3         | no              | no               |
| `queue_publish`          | 3         | no              | no               |
| `topic_publish`          | 3         | no              | no               |
| `start_detached`         | 3         | no              | no               |

Every real await point produces a promise, and the `await_promise` step references it via `promise_id`. The promise already knows its origin (via `promise.step_id` → the `start_*` step). The await step just says "I'm parked here until this promise resolves." This correctly models multi-branch sharing: two branches awaiting the same step's result both record `await_promise` pointing to the same `promise_id`.

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

**Deferred compensation (LIFO stack):** registered via `.compensate()` on step/workflow calls, or standalone via `ctx.registerCompensation(name, cb)`. Pushed onto a LIFO stack. Executed in reverse order when the workflow fails (throws `WorkflowError`). The LIFO order ensures that the most recently registered compensation runs first, preserving the natural "undo in reverse" semantics.

**Eager compensation (FIFO queue):** dispatched when a step times out and the timeout is caught, or when a scope exits with unconsumed branches, or standalone via `ctx.compensateEagerly(name, cb)`. Pushed to the compensation VEL's FIFO queue and executed immediately in the background while the main workflow continues.

### Registration as durable steps

Both standalone compensation methods are Tier 3 Direct Awaitables that write a step record to the execution tree:

```typescript
await ctx.registerCompensation("cancel-hotel", async (ctx) => {
  await ctx.steps.cancelHotel(hotel.id).resolve(ctx);
});

await ctx.compensateEagerly("refund-booking", async (ctx) => {
  await ctx.steps.refundBooking(booking.id).resolve(ctx);
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
await ctx.steps.bookFlight(dest)
  .compensate(async (ctx) => { ... })
  .resolve(ctx);

// Desugars to (conceptually):
const result = await ctx.steps.bookFlight(dest).resolve(ctx);
await ctx.registerCompensation("compensate:bookFlight", cb);
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

Any unexpected exception (non-`WorkflowError`) in workflow or compensation code puts the engine in an undefined state. The code between the last durable step and the exception is non-deterministic on replay. Retrying the code block is not safe — it may have already modified in-memory state.

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

## Part 4: `WorkflowError` and Explicit Failure Distinction

### Problem

Currently, any thrown exception fails the entire workflow. There is no way to distinguish between an intentional business failure ("this order is invalid") and an accidental programming error ("cannot read property of undefined").

### Solution

Introduce a `WorkflowError` class:

```typescript
class WorkflowError extends Error {
  constructor(message: string, details?: Record<string, unknown>);
}
```

The distinction:

- **`throw new WorkflowError("Order invalid")`** → the workflow **fails**. This is an intentional business decision. The LIFO compensation unwind is triggered. The workflow settles as `failed`.
- **`throw new Error("Cannot read property of undefined")`** → the workflow **halts**. This is an accidental exception. The engine records a halt and pauses execution. An admin must deploy a patch or SIGKILL the workflow.

This ensures that no accidental exception can silently fail a workflow and trigger the full LIFO compensation chain. Only explicit `WorkflowError` instances trigger failure semantics.

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
  | { maxAttempts: number; seconds?: number }
  | { seconds: number; maxAttempts?: number };
```

The `number` shorthand means seconds:

```typescript
.timeout(60)                                    // 60 seconds overall
.timeout(60, () => null)                        // 60 seconds, return null on timeout
.timeout({ maxAttempts: 5 })                    // 5 attempts max
.timeout({ maxAttempts: 5, seconds: 60 })       // whichever fires first
.timeout({ maxAttempts: 5, seconds: 60 }, () => null)
```

`maxAttempts` and `seconds` complement each other — both can coexist in the same boundary. `maxAttempts` limits how many times the step is tried. `seconds` limits total wall-clock time. Whichever boundary is reached first terminates the step.

**Updated `StepCall`:**

```typescript
interface StepCall<
  T,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DeterministicAwaitable<T | TTimeout, ExecutionRoot> {
  compensate(
    cb: (ctx: Tctx, result: StepCompensationResult<T>) => Promise<void>,
  ): StepCall<T, TTimeout, true, Tctx>;

  compensate(
    name: string,
    cb: (ctx: Tctx, result: StepCompensationResult<T>) => Promise<void>,
  ): StepCall<T, TTimeout, true, Tctx>;

  retry(
    policy: RetryPolicyOptions,
  ): StepCall<T, TTimeout, HasCompensation, Tctx>;

  timeout(seconds: number): StepCall<T, never, HasCompensation, Tctx>;
  timeout<R>(
    seconds: number,
    cb: () => R,
  ): StepCall<T, Awaited<R>, HasCompensation, Tctx>;
  timeout(opts: StepBoundary): StepCall<T, never, HasCompensation, Tctx>;
  timeout<R>(
    opts: StepBoundary,
    cb: () => R,
  ): StepCall<T, Awaited<R>, HasCompensation, Tctx>;

  complete<R>(
    cb: (data: T) => R,
  ): StepCall<Awaited<R>, TTimeout, HasCompensation, Tctx>;
}
```

Key changes:

- **`TFail` is gone.** Replaced by `TTimeout`. Steps cannot "fail" — they succeed or time out.
- **`.failure()` is removed.** Steps retry forever unless bounded by `.timeout()`.
- **`.timeout()` replaces `.failure()` as the explicit error handling surface.** Without `.timeout()` chained and a timeout boundary reached, the workflow fails (throws `WorkflowError` internally).

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
  .bookFlight(dest, id)
  .timeout({ maxAttempts: 3 }, () => null)
  .resolve(ctx);
```

### Updated `StepCompensationResult`

```typescript
type StepCompensationResult<T> =
  | { status: "complete"; data: T; attempts: AttemptAccessor }
  | {
      status: "timed_out";
      reason: "attempts_exhausted" | "deadline";
      attempts: AttemptAccessor;
    }
  | { status: "terminated" };
```

### Child workflow timeout

Child workflows keep `.failure()` (child workflows genuinely fail via `WorkflowError`). A new `.timeout()` is added separately:

```typescript
interface WorkflowCall<
  T,
  TFail = never,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DeterministicAwaitable<T | TFail | TTimeout, ExecutionRoot> {
  compensate(
    cb: (
      ctx: Tctx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCall<T, TFail, TTimeout, true, Tctx>;

  failure<R>(
    cb: (failure: ChildWorkflowFailureInfo) => R,
  ): WorkflowCall<T, Awaited<R>, TTimeout, HasCompensation, Tctx>;

  timeout<R>(
    seconds: number,
    cb: () => R,
  ): WorkflowCall<T, TFail, Awaited<R>, HasCompensation, Tctx>;

  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCall<Awaited<R>, TFail, TTimeout, HasCompensation, Tctx>;
}
```

The distinction:

- `.failure()` handles child workflow failure (child threw `WorkflowError`) and termination.
- `.timeout()` handles parent-side patience (the parent gives up waiting). This is separate from child-side failure.
- Without `.failure()` chained, a child workflow failure auto-fails the parent. Without `.timeout()` chained, a timeout auto-fails the parent.

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

### `ctx.joinSafe(handle)`

Joins a branch handle and returns a result union instead of throwing on failure:

```typescript
type JoinSafeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ScopeFailureInfo<TSteps, TChildWorkflows> };

const result = await ctx.joinSafe(flightHandle);
if (result.ok) {
  // result.data: FlightResult
} else {
  // result.error: ScopeFailureInfo
}
```

### `ctx.best(name, entries)`

Collect as many results as possible. Branches that fail are compensated eagerly; branches that succeed have their results collected. Returns all successful results as an array:

```typescript
const results = await ctx
  .best("GetAllQuotes", {
    providerA: async (ctx) => ctx.steps.getQuote("A").resolve(ctx),
    providerB: async (ctx) => ctx.steps.getQuote("B").resolve(ctx),
    providerC: async (ctx) => ctx.steps.getQuote("C").resolve(ctx),
  })
  .resolve(ctx);
// results: Array<{ key: "providerA" | "providerB" | "providerC", data: Quote }>
```

### `ctx.atMost(name, n, entries)`

Collect at most `n` results. Short-circuits after `n` successes; remaining branches are compensated eagerly:

```typescript
const results = await ctx
  .atMost("PickTwo", 2, {
    providerA: async (ctx) => ctx.steps.getQuote("A").resolve(ctx),
    providerB: async (ctx) => ctx.steps.getQuote("B").resolve(ctx),
    providerC: async (ctx) => ctx.steps.getQuote("C").resolve(ctx),
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
    nodeA: async (ctx) => ctx.steps.healthCheck("A").resolve(ctx),
    nodeB: async (ctx) => ctx.steps.healthCheck("B").resolve(ctx),
    nodeC: async (ctx) => ctx.steps.healthCheck("C").resolve(ctx),
    nodeD: async (ctx) => ctx.steps.healthCheck("D").resolve(ctx),
    nodeE: async (ctx) => ctx.steps.healthCheck("E").resolve(ctx),
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

A global competing-consumer work queue. Any workflow can publish a typed message to a named queue. Any registered worker can consume from it. Messages are processed exactly once via `SELECT FOR UPDATE SKIP LOCKED`.

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
- `message` — Zod schema. Input type for publishing, output type for handler.
- `defaultTTL` — optional. Seconds before unclaimed message is dead-lettered with `ttl_expired`. If absent, `ttl` is required on every `publish`.
- `retention.processed` — row retention seconds after processing. `null` = never delete.
- `retention.deadLettered` — row retention seconds after dead-lettering. `null` = never delete.

### TTL semantics

- `ttl: number` — expires N seconds from publish time.
- `ttl: null` — never expires, regardless of `defaultTTL`.

When `defaultTTL` is not specified, `ttl` is required on every `publish` call. When `defaultTTL` is specified, `ttl` is an optional override.

### Scheduling semantics

- `delay: number` — eligible N seconds from publish time.
- `scheduledAt: Date` — eligible at absolute timestamp.

Both optional. If neither is provided, eligible immediately. If `delay >= ttl` (or `scheduledAt >= expires_at`), the engine raises an error at publish time.

Ordering once eligible: `COALESCE(scheduled_at, created_at) ASC, id ASC`.

### Workflow-internal API

```typescript
await ctx.queues.notifications.publish({ userId: "u1", body: "Hello" });
await ctx.queues.notifications.publish(
  { userId: "u1", body: "Urgent" },
  { ttl: 300 },
);
await ctx.queues.notifications.publish(
  { userId: "u1", body: "Reminder" },
  { delay: 3600 },
);
await ctx.queues.notifications.publish(
  { userId: "u1", body: "Renew your subscription" },
  { scheduledAt: addDays(ctx.date, 30) },
);
```

- Tier 3 — `DirectAwaitable<void>`.
- Workflow can only publish, never read.
- Available in both `WorkflowContext` and `CompensationContext`.
- Exactly-once publish: insert is colocated in the workflow's checkpoint transaction. On replay, the existing record is detected and the re-insert is skipped.

### Client registration API

```typescript
const unregister = client.registerQueueHandler(
  notificationsQueue,
  async (message) => {
    await sendEmail(message.userId, message.body);
  },
  {
    timeout: 30,
    retryPolicy: {
      maxAttempts: 5,
      intervalMs: 2000,
      backoffRate: 2,
      maxIntervalMs: 60_000,
    },
  },
);

unregister();
```

`maxAttempts` is meaningful for queues: after exhaustion, the message is dead-lettered with `max_attempts`.

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

**Redrive TTL behavior:** On redrive, `status` resets to `pending`, `attempt_count` resets to zero. If `ttl` provided, `expires_at = NOW() + ttl`; if `ttl: null`, never expires; if omitted, `defaultTTL` re-applied.

### Postgres implementation

```sql
CREATE TABLE queue_messages (
  id                                BIGSERIAL PRIMARY KEY,
  queue_name                        TEXT NOT NULL,
  payload                           JSONB NOT NULL,
  status                            TEXT NOT NULL DEFAULT 'pending',
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
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES queue_messages(id) ON DELETE CASCADE,
  attempt     INT NOT NULL,
  error       TEXT NOT NULL,
  error_type  TEXT,
  details     JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at   TIMESTAMPTZ NOT NULL
);
```

**Consumer claim:**

```sql
SELECT * FROM queue_messages
WHERE queue_name = $1
  AND status = 'pending'
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (scheduled_at IS NULL OR scheduled_at <= NOW())
ORDER BY COALESCE(scheduled_at, created_at) ASC, id ASC
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

Requests are Tier 1 but NOT `StepCall` instances. They have their own call type extending `DeterministicAwaitable` directly.

`timeout` is a required option. `null` means wait indefinitely (`UntimedRequestCall`); a number sets the deadline in seconds (`TimedRequestCall`).

```typescript
// Wait indefinitely
const result = await ctx.requests
  .humanReview({ context: "...", data: signals }, { timeout: null })
  .compensate(async (ctx, result) => {
    /* ... */
  })
  .resolve(ctx);

// With timeout + fallback
const result = await ctx.requests
  .humanReview({ context: "...", data: signals }, { timeout: 300 })
  .compensate(async (ctx, result) => {
    /* ... */
  })
  .timeout(() => null)
  .complete((r) => r.decision)
  .resolve(ctx);
// result: "approve" | "reject" | null
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

### Retry policy

The workflow caller does NOT control retry behavior. The caller controls only payload and timeout. Retry policy is the handler's concern. `maxAttempts` is absent from the handler retry policy — a handler failure releases the lock and makes the request eligible for any other worker.

### Client registration API

```typescript
const unregister = client.registerRequestHandler(
  humanReview,
  async (request) => {
    const decision = await routeToHumanUI(request);
    return { decision, note: "reviewed" };
  },
  {
    timeout: 60,
    retryPolicy: {
      intervalMs: 5000,
      backoffRate: 2,
      maxIntervalMs: 120_000,
    },
  },
);
```

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
    status IN ('pending', 'claimed', 'resolved', 'timedOut', 'cancelled')
  )
);

CREATE TABLE request_attempt (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  attempt     INT NOT NULL,
  error       TEXT NOT NULL,
  error_type  TEXT,
  details     JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at   TIMESTAMPTZ NOT NULL
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
await ctx.topics.auditEvents.publish(
  { type: "booking.confirmed", payload: { orderId: "o1" } },
  { metadata: { tenantId: "acme", type: "booking.confirmed" } },
);
```

Tier 3 — `DirectAwaitable<void>`. Publish only, never consume. Available in both contexts.

### Client registration API

```typescript
const unregister = client.registerTopicConsumer(
  auditTopic,
  "analyticsConsumer",
  async (record) => {
    if (record.metadata?.tenantId !== "acme") return;
    await ingestToWarehouse(record);
  },
  {
    timeout: 10,
    retryPolicy: {
      intervalMs: 1000,
      backoffRate: 2,
      maxIntervalMs: 30_000,
      maxAttempts: 5,
    },
    registrationRetry: {
      intervalMs: 5000,
      backoffRate: 1.5,
      maxIntervalMs: 60_000,
    },
    onRegisterError: (event) => {
      logger.warn("Topic consumer lock conflict", event.error);
    },
    onConsumeError: async (event) => {
      if (event.type === "attemptsExhausted") return "skip";
      if (event.type === "offsetExpired") return "skip";
      return "halt";
    },
  },
);
```

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
  offset_expired BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at   TIMESTAMPTZ,
  UNIQUE (topic_name, name)
);

CREATE TABLE topic_consumer_offsets (
  consumer_id BIGINT REFERENCES topic_consumers(id),
  last_id     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (consumer_id)
);
```

**Liveness-based retention sweeper:** classifies consumers as live or dead (based on advisory lock status and `last_seen_at` grace period). Deletes records that are both behind all live consumers AND older than `retentionSeconds`. Marks dead consumers with expired offsets via `offset_expired = TRUE`.

---

## Part 13: Attributes

### Purpose

An observable single current value on a workflow instance. Externally readable, workflow-writable.

### Workflow-internal API

```typescript
await ctx.attributes.progress.set({ percent: 0.75, phase: "finalizing" });
```

Tier 3 — `DirectAwaitable<void>`. Set only, never read. Available in both contexts.

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

---

## Part 15: AttemptAccessor Refactoring

### Changes

**Rename `StepErrorAccessor` → `AttemptAccessor`:** shared interface for lazy access to per-attempt error records across steps and queue dead-lettered messages.

**`count` property → `count()` async method:** consistent with the fully lazy interface.

**Rename `errors` → `attempts` on `StepCompensationResult`:** accurate in all variants.

### Updated interface

```typescript
interface AttemptAccessor {
  last(): Promise<StepExecutionError>;
  all(): Promise<StepExecutionError[]>;
  count(): Promise<number>;
  [Symbol.asyncIterator](): AsyncIterableIterator<StepExecutionError>;
  reverse(): AsyncIterable<StepExecutionError>;
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

Described in Part 10. `publish` opts accept `delay: number` (seconds) or `scheduledAt: Date`.

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

## Summary of Public API Changes

### New `defineWorkflow` options

```typescript
defineWorkflow({
  queues:     { [name: string]: QueueDefinition<M> },
  requests:   { [name: string]: RequestDefinition<Req, Res> },
  topics:     { [name: string]: TopicDefinition<R, Meta> },
  attributes: { [name: string]: ZodSchema },
});
```

### `WorkflowContext` changes

| Change                                 | Details                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `ctx.queues.X.publish(payload, opts?)` | Tier 3, both contexts                                                        |
| `ctx.requests.X(payload, opts)`        | Tier 1, both contexts (no `.compensate()` in `CompensationContext`)          |
| `ctx.topics.X.publish(payload, opts?)` | Tier 3, both contexts                                                        |
| `ctx.attributes.X.set(value)`          | Tier 3, both contexts                                                        |
| `ctx.registerCompensation(name, cb)`   | Tier 3, `WorkflowContext` only. Registers deferred LIFO compensation.        |
| `ctx.compensateEagerly(name, cb)`      | Tier 3, `WorkflowContext` only. Dispatches eager FIFO compensation.          |
| `ctx.joinSafe(handle)`                 | Available on concurrency contexts. Returns result union instead of throwing. |
| `ctx.best(name, entries)`              | Tier 1, collects all successful results.                                     |
| `ctx.atMost(name, n, entries)`         | Tier 1, collects at most N results.                                          |
| `ctx.atLeast(name, n, entries)`        | Tier 1, collects at least N results (fails if fewer).                        |
| `ctx.first(name, entries)`             | Now requires a name argument.                                                |
| `ctx.all(name, entries)`               | Now requires a name argument.                                                |
| `ctx.scope(name, entries, callback)`   | Unchanged (already named).                                                   |

### `StepCall` changes

| Change                                | Details                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| `.failure()` removed                  | Steps cannot fail — they succeed or time out.             |
| `.timeout(boundary, cb?)` added       | Replaces `.failure()`. Stop condition for step execution. |
| `TFail` type parameter removed        | Replaced by `TTimeout`.                                   |
| `.compensate()` accepts optional name | `.compensate("name", cb)` for explicit identity.          |

### `WorkflowCall` changes

| Change                                | Details                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `.timeout(seconds, cb)` added         | Parent-side patience, separate from child-side `.failure()`. |
| `.compensate()` accepts optional name | `.compensate("name", cb)` for explicit identity.             |

### `RetryPolicyOptions` changes

| Change                                 | Details                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `maxAttempts` removed                  | Moved to `.timeout()` builder on `StepCall`.         |
| `intervalSeconds` → `intervalMs`       | Milliseconds, consistent with TypeScript convention. |
| `maxIntervalSeconds` → `maxIntervalMs` | Milliseconds.                                        |

### New exports

- `defineQueue`, `defineRequest`, `defineTopic`
- `SearchQueryNode`, `SearchQuery`
- `DeadLetterRecordFields`, `DeadLetterSort`, `DeadLetterCursor`, `DeadLetteredMessage`, `DeadLetterHandle`
- `RequestCompensationResult`, `AttemptAccessor`
- `WorkflowError`
- `StepBoundary`
- `Unsubscribe`
- `RegisterTopicConsumerError`, `RegisterTopicConsumerErrorEvent`, `TopicConsumerAlreadyActiveError`, `TopicConsumerConsumeErrorEvent`
- `ScheduleOptions`
- `IWorkflowConnection`, `IWorkflowTransaction`
- `RetentionSetter`

### Breaking changes

- `StepErrorAccessor` renamed to `AttemptAccessor`.
- `StepCompensationResult.errors` renamed to `.attempts`. `status: "failed"` renamed to `status: "timed_out"` with `reason: "attempts_exhausted" | "deadline"`.
- `StepErrorAccessor.count` (sync) → `AttemptAccessor.count()` (async).
- `StepCall.failure()` removed. Use `.timeout()`.
- `StepFailureInfo` removed.
- `maxAttempts` removed from `RetryPolicyOptions`.
- `retryPolicy` interval fields: `intervalSeconds` → `intervalMs`, `maxIntervalSeconds` → `maxIntervalMs`.
- `addCompensation()` renamed to `registerCompensation(name, cb)` (now named, now Tier 3 awaitable).
- `ctx.first(entries)` → `ctx.first(name, entries)` (name required).
- `ctx.all(entries)` → `ctx.all(name, entries)` (name required).
- `RetentionSettings` → `RetentionSetter<TStatus extends string>`.
- Unhandled exceptions now halt the workflow instead of failing it (only `WorkflowError` causes failure).

### Connection and transaction model

Two opaque types:

```typescript
type IWorkflowConnection;
type IWorkflowTransaction;
```

Client and engine-level CRUD APIs accept optional `txOrConn?: IWorkflowTransaction | IWorkflowConnection`. Workflow logic (`ctx.*`) is entirely exempt — it runs inside the engine's own durable execution transaction. Blocking operations and subscriptions are also exempt.
