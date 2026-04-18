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
11. **Error model** — two-tier `terminalErrors` / `branchErrors`, `ExplicitError` throwable, `ctx.terminalErrors` / `ctx.branchErrors` factories, externally-visible `ErrorValue<TTerminalErrors>` only
12. **Step timeout unification** — `maxAttempts` moves from retry policy to `.timeout()` builder; `.timeout(boundary, cb)` callback is mandatory
13. **AttemptAccessor refactoring** — rename `StepErrorAccessor` → `AttemptAccessor`, introduce `Failure` base record + `Attempt extends Failure` for retried operations, introduce `AttemptError` throwable class, unify attempt record shape, make `count()` async
14. **Context splitting** — separate primitive instances for execution and compensation VELs
15. **Convenience scope methods and structured-concurrency consumption** — `ctx.scope`, `ctx.all`, `ctx.first`, `ctx.atMost`, `ctx.atLeast`, `ctx.best`; single-overload `ctx.match` returning a discriminated `{ key, val }` async iterable; `ctx.join` returning the typed `val` directly
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

**Deferred compensation (LIFO stack):** registered via `.compensate()` on step/workflow calls, or standalone via `ctx.registerCompensation(name, cb)`. Pushed onto a LIFO stack. Executed in reverse order when the workflow fails (throws a declared `terminalErrors` factory via `ctx.terminalErrors`). The LIFO order ensures that the most recently registered compensation runs first, preserving the natural "undo in reverse" semantics.

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

### Builder chain ordering

The chain on `StepCall`, `WorkflowCall`, and `RequestCall` is **strictly ordered**. Each method may be called at most once, and `.compensate` is a hard fence:

```
(.retry)? → (.timeout)? → (.failure on WorkflowCall — mandatory)? → (.compensate)? → (.complete)? → .resolve
```

After `.compensate` is called, subsequent attempts to call `.retry`, `.timeout`, or `.failure` resolve to `never` at the type level. The reason is that the compensation callback's `result` parameter type *depends on* whether `.timeout` and `.failure` were applied earlier in the chain (e.g., a step with `.timeout(boundary, () => null)` produces `T | null`; without `.timeout`, it produces `T`). Allowing later chained `.timeout` or `.failure` to retroactively widen or narrow the inferred type would change the type the compensation callback was authored against, silently invalidating it. Locking the chain after `.compensate` makes the callback's type stable at the point it is written.

`.failure` is type-mandatory on `WorkflowCall`: `.compensate` and `.resolve` both require `"failure" extends Called`. This collapses any "uncaught child workflow failure" path out of the external surface — child workflow failures must be handled at the call site or they halt (see Part 4 — child failures are not part of the external `FailureInfo`).

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

Any unexpected exception (anything that the surrounding context's mode does not classify as a declared failure — see the per-context throw rules below) in workflow or compensation code puts the engine in an undefined state. The code between the last durable step and the exception is non-deterministic on replay. Retrying the code block is not safe — it may have already modified in-memory state.

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

### Per-context throw rules

Whether a thrown value fails (the surrounding scope/branch) or halts (the workflow) depends on **which mode** the surrounding context is in. The error model in Part 4 introduces three branch modes (`"none"`, `"any"`, `"explicit"`) and a workflow-level `terminalErrors` map. The rules:

| Surrounding context | Throw recognized as failure | Anything else |
| --- | --- | --- |
| `execute` body of `defineWorkflow` | `ctx.terminalErrors.X(...)` only | **halts** |
| Scope body / branch in mode `"none"` (the default for shorthand-form bodies and branches) | `ctx.terminalErrors.X(...)` only — escapes the scope | **halts** |
| Branch (or scope body) in mode `"any"` | any throw is captured as a `Failure` record at the parent's consumption point | engine-internal exceptions only — these halt |
| Branch (or scope body) in mode `"explicit"` (declared `errors` map) | `ctx.branchErrors.X(...)` factories scoped to the declared keys; surfaces as `ErrorValue<TBranchErrors>` at the parent's consumption point | **halts** |
| Inside `.timeout(cb)` / `.failure(cb)` callbacks | inherits the surrounding context's mode (the callback is chained inline; throws propagate to the same enclosing branch/body and obey the rules above) | inherits |
| Inside a compensation callback | `ctx.terminalErrors.X(...)` from the compensation namespace only | **halts** the compensation VEL |

Two things to keep in mind:

1. **`terminalErrors` always escape.** A `terminalErrors` factory thrown from anywhere inside the workflow execution (including from inside a branch in mode `"any"` or `"explicit"`) bypasses the branch's local error contract and propagates up to fail the workflow. The local contract only governs *non-terminal* throws.
2. **Engine-level failures are not in scope here.** Step timeouts, request timeouts, and child workflow failures never reach the throw machinery — they are surfaced via mandatory `.timeout(cb)` / `.failure(cb)` callbacks at the call site. If those callbacks themselves throw, the rules above apply to the throw.

---

## Part 4: Error Model

### Problem

Three distinct concerns have historically been collapsed into one error surface:

1. **Intentional business failure** ("this order is invalid") that the developer wants the external caller to handle.
2. **Recoverable per-branch failure** ("provider A's quote lookup blew up — fall back to provider B") that should not bubble out of the structured-concurrency boundary that contains it.
3. **Operational engine events** (a step timed out, a child workflow failed, a request was cancelled) that are call-site-local — the developer either handles them at the call site or treats their occurrence as a bug.

Lumping all three into a single external failure union forces the caller to triage fundamentally different categories with the same switch statement, and forces engine-level events through recursive child-workflow nesting that defeats type safety.

### Solution: a two-tier error model

The library exposes two kinds of error declarations, with sharply different visibility:

| Concept | Declared at | Caught at | Visible at the external boundary |
| --- | --- | --- | --- |
| `terminalErrors` | `defineWorkflow.terminalErrors`, `defineWorkflow.compensation.terminalErrors` | Nothing — escapes all scopes; fails the workflow | **Yes** — sole variant of external `FailureInfo` |
| `branchErrors` | Per-branch `errors:` field on the branch's object form | The branch's parent consumption point (`match` / `join` / the outer `.resolve()` of a scope or convenience method) | **No** — handled locally |

Plus one residual category: unexpected throws **halt** (Part 3). The `terminalErrors` map is therefore the *only* external-failure surface; engine-level events (step timeouts, request timeouts, child workflow failures) are not part of `FailureInfo` at all — they are surfaced through mandatory `.timeout(cb)` / `.failure(cb)` callbacks at the call site, and if the developer does nothing about them, an unhandled engine-level event halts the workflow.

### Schema-only error definitions at the workflow level

`terminalErrors` are declared as named entries at `defineWorkflow` level, following the same pattern as channels, streams, events, and other primitives. Each entry has a name (the object key) and either a standard-schema for its details or `true` (no details).

```typescript
defineWorkflow({
  terminalErrors: {
    OrderInvalid: z.object({ orderId: z.string() }),
    InsufficientFunds: z.object({ amount: z.number(), balance: z.number() }),
    Cancelled: true,
  },
  // ...
});
```

There are no `ExplicitError` subclasses — error classes are not user-defined. Instead, the workflow context exposes factory functions keyed by terminal-error name:

```typescript
execute: async (ctx) => {
  if (!valid) {
    throw ctx.terminalErrors.OrderInvalid("Order is invalid", { orderId: "123" });
  }
  if (balance < amount) {
    throw ctx.terminalErrors.InsufficientFunds("Not enough balance", { amount, balance });
  }
  throw ctx.terminalErrors.Cancelled("User cancelled the order");
}
```

A `terminalErrors` throw escapes every scope, every branch, every convenience method, and every callback. It is the **only** way to fail the workflow from inside `execute`. The compensation LIFO unwind is triggered. The workflow settles as `failed` and the external caller receives the typed value.

**For errors with details** (schema provided), the factory signature is `(message: string, details: InferInput<TSchema>) => ExplicitError`.

**For errors without details** (`true`), the factory signature is `(message: string) => ExplicitError`.

### Per-branch error declarations

Branches inside scopes (and the scope body itself) declare their failure contract via an `errors:` field on the branch's object form. Three modes:

```typescript
errors?: "none" | "any" | { [name: string]: JsonSchemaConstraint | true };
```

| Mode | When `errors` is | `ctx.branchErrors` inside `execute` | Recognized failure | Anything else |
| --- | --- | --- | --- | --- |
| `"none"` (default) | omitted, or `"none"` | empty | only `terminalErrors` (escapes) | **halts** |
| `"any"` | `"any"` | empty (no factories — the dev throws plain `Error` or any value) | any throw becomes a `Failure` record | engine-internal exceptions only |
| `"explicit"` | a non-empty map | factories scoped to the declared keys | `ctx.branchErrors.X(...)` becomes typed `ErrorValue<TBranchErrors>` | **halts** |

The four shapes a branch (or scope body) can take, all equivalent in the modes they imply:

```typescript
// Form 1 — function shorthand. Mode "none". Default.
async (ctx) => { /* returns T */ }

// Form 2 — object form, mode "none" (explicit).
{ execute: async (ctx) => { /* ... */ }, errors: "none" }

// Form 3 — object form, mode "any".
{ execute: async (ctx) => { /* ... */ }, errors: "any" }
// The dev throws `throw new Error(...)` or any value; the engine captures it as Failure.

// Form 4 — object form, mode "explicit".
{
  execute: async (ctx) => {
    if (badInput) throw ctx.branchErrors.InvalidInput("...", { field: "amount" });
  },
  errors: { InvalidInput: z.object({ field: z.string() }), Cancelled: true },
}
```

**Default for shorthand-form branches and scope bodies is mode `"none"`.** A function-shorthand branch only halts on anything other than a `terminalErrors` throw. The dev opts into `"any"` or `"explicit"` via the object form. This default is conservative: it prevents accidental capture of programming errors and forces the developer to make an explicit decision about which throws are recoverable.

### Two namespaces in `ctx`

The workflow context exposes two distinct error-factory namespaces:

| Namespace | Available where | Sourced from | Throw escapes to |
| --- | --- | --- | --- |
| `ctx.terminalErrors` | everywhere — `execute`, every branch, every callback, every compensation | `defineWorkflow.terminalErrors` (in execution context) or `defineWorkflow.compensation.terminalErrors` (in compensation context) | the workflow root → fails the workflow → external `FailureInfo` |
| `ctx.branchErrors` | only inside a branch (or scope body) whose `errors:` is an explicit map | the branch's own `errors:` map | the parent consumption point → typed `ErrorValue<TBranchErrors>` at `match` / `join` / `.resolve()` |

The two namespaces never share names — they are separate properties on `ctx`. A branch in mode `"none"` or `"any"` simply has `ctx.branchErrors` typed as `Record<string, never>` (empty). A branch in mode `"explicit"` has `ctx.branchErrors` typed against its declared keys.

The split makes "this throw escapes everything" (terminal) vs "this throw is a value at my parent's consumption point" (branch) syntactically distinct at the throw site.

### `ExplicitError` — the throwable class

`ExplicitError` is the internal throwable created by both `ctx.terminalErrors.X(...)` and `ctx.branchErrors.X(...)`. It is not subclassed by users, and constructing it directly is not supported — the factories are the only sanctioned way to create instances.

```typescript
class ExplicitError extends Error {
  readonly errorCode: string;
  readonly details: unknown;
}
```

When the engine catches an `ExplicitError`:

- If its `errorCode` matches a declared `terminalErrors` key → the workflow fails (or, in compensation, the compensation VEL fails). The error escapes all scopes.
- Else if its `errorCode` matches the *current* branch's declared `branchErrors` keys → the branch fails with a typed `ErrorValue<TBranchErrors>` at the parent consumption point.
- Else → halt.

The same class covers both contexts because the two are distinguished by which factory minted the instance and by where it is caught. From the engine's perspective, every `ExplicitError` is a candidate for either escape (terminal) or local capture (branch); the resolution is purely a function of where the catch boundary sits and what's declared at that boundary.

A `ExplicitError` with an `errorCode` that matches *neither* the workflow's `terminalErrors` nor the current branch's `branchErrors` halts. This catches the case where a branch is refactored, a key is renamed, and a stale throw remains.

### `Failure` — the captured-throw record

When a branch is in mode `"any"`, every throw that isn't a `terminalErrors` factory is captured into a `Failure` record (defined in Part 15). `Failure` is also the base shape that `Attempt` extends — the engine uses identical extraction rules for both, the only difference being that `Attempt` adds an `attempt: number` for retried operations.

```typescript
interface Failure {
  readonly startedAt: Date;
  readonly failedAt: Date;
  readonly message: string | null;
  readonly type: string | null;       // class name or AttemptError.type
  readonly details: JsonInput | undefined;
}

interface Attempt extends Failure {
  readonly attempt: number;           // 1-indexed
}
```

Branches use `Failure` (single attempt — no number). Steps, queue handlers, request handlers, and topic consumers continue to use `Attempt` because they retry. See Part 15 for the engine extraction rules.

### Per-context throw rules — recap

The full rules (also given in Part 3) for what a throw does, indexed by the context it originates in:

| Context | Recognized failure throws | Anything else |
| --- | --- | --- |
| `execute` body of `defineWorkflow` | `ctx.terminalErrors.X(...)` | **halt** |
| Branch / scope body in mode `"none"` (shorthand default) | `ctx.terminalErrors.X(...)` | **halt** |
| Branch / scope body in mode `"any"` | any throw → `Failure` at parent consumption point; `ctx.terminalErrors.X(...)` still escapes | engine-internal exceptions only — these halt |
| Branch / scope body in mode `"explicit"` | `ctx.branchErrors.X(...)` from the declared map; `ctx.terminalErrors.X(...)` still escapes | **halt** |
| `.timeout(cb)` / `.failure(cb)` callback | inherits the surrounding context's mode (the throw propagates as if from where the chain was authored) | inherits |
| Compensation `execute` / shorthand body / mode-`"none"` branch | `ctx.terminalErrors.X(...)` from the *compensation* namespace | **halt the compensation VEL** |
| Compensation branch / body in mode `"any"` or `"explicit"` | same as execution-side `"any"` / `"explicit"` (uses compensation's `ctx.branchErrors`) | **halt the compensation VEL** |

### External error types

At the external caller level the failure surface collapses to a single type — the workflow's declared terminal errors:

```typescript
type FailureInfo<TTerminalErrors> = ErrorValue<TTerminalErrors>;
```

`ErrorValue<T>` is a distributive mapped type used both for terminal-error external surfaces and for branch-error consumption points:

```typescript
type ErrorValue<TErrors> = {
  [K in keyof TErrors & string]: {
    readonly type: "ExplicitError";
    readonly errorCode: K;
    readonly message: string;
    readonly details: TErrors[K] extends true
      ? undefined
      : StandardSchemaV1.InferOutput<TErrors[K]>;
  };
}[keyof TErrors & string];
```

> **Engine-level failures (step timeouts, request timeouts, child workflow failures) are not part of the external failure surface.** They are call-site-local. Each must be either consumed by a mandatory callback (`.timeout(boundary, cb)`, `.failure(cb)`) at the call site — in which case the callback can throw a `terminalErrors` to surface the failure externally, throw a `branchErrors` to surface it at the local consumption point, or return a recovery value — or, if no callback is chained where one would have applied, the engine treats the unhandled engine event as a programmer oversight and **halts** (consistent with Part 3).

Engine-level events surface only as *callback info* types — `StepFailureInfo` for `.timeout(cb)` and `ChildWorkflowFailureInfo<TChildTerminalErrors>` for `.failure(cb)` (see Part 5) — never as a value the external caller sees.

A direct consequence: **child workflow failure typing works cleanly without recursion.** The parent's `.failure(cb)` on a child `WorkflowCall` receives `ChildWorkflowFailureInfo<TChildTerminalErrors>` where `TChildTerminalErrors` are exactly the child's declared `terminalErrors`, fully typed. The parent then either returns a recovery value, throws `ctx.terminalErrors.X(...)` (lifting into the parent's own terminal contract — typed in the parent's own terms), throws `ctx.branchErrors.X(...)` (lifting into the local branch contract), or rethrows. Nothing recursive escapes; the parent's external surface contains only the parent's own `terminalErrors`.

### External caller usage

```typescript
const result = await client.workflows.order.execute({ ... });
if (!result.ok && result.status === "failed") {
  // result.error is ErrorValue<{ OrderInvalid, InsufficientFunds, Cancelled }>
  switch (result.error.errorCode) {
    case "OrderInvalid":
      // result.error.details: { orderId: string } — fully typed
      break;
    case "InsufficientFunds":
      // result.error.details: { amount: number, balance: number }
      break;
    case "Cancelled":
      // result.error.details: undefined — no details
      break;
  }
}
```

There is no outer discriminant (no union of error categories). The external caller discriminates on `errorCode` directly.

### Compensation error model

The compensation VEL has its own `terminalErrors` map, declared separately at `defineWorkflow.compensation.terminalErrors`:

```typescript
defineWorkflow({
  terminalErrors: {
    OrderInvalid: z.object({ orderId: z.string() }),
    InsufficientFunds: z.object({ amount: z.number(), balance: z.number() }),
  },
  compensation: {
    terminalErrors: {
      RefundFailed: z.object({ chargeId: z.string(), reason: z.string() }),
    },
  },
  // ...
});
```

Inside compensation callbacks, `ctx.terminalErrors` exposes the *compensation* terminal-error factories — not the execution ones (the contexts are split, see Part 6):

```typescript
.compensate("cancel-booking", async (ctx, result) => {
  const refundResult = await ctx.steps
    .refund({ chargeId: result.data.chargeId })
    .timeout(60, () => ({ ok: false, reason: "timeout" } as const))
    .resolve(ctx);
  if (!refundResult.ok) {
    throw ctx.terminalErrors.RefundFailed("Refund could not be processed", {
      chargeId: result.data.chargeId,
      reason: refundResult.reason,
    });
  }
})
```

The same per-branch error-declaration system applies symmetrically inside compensation. A compensation branch can be in mode `"none"`, `"any"`, or `"explicit"`. The defaults are identical: shorthand-form bodies and branches default to mode `"none"`.

**The asymmetry with execution is structural, not type-level:** compensation is the cleanup pass and the only structural special-case is that `defineWorkflow.compensation.terminalErrors` is optional (when omitted, `ctx.terminalErrors` in compensation has no factories — there is no way to fail the compensation VEL with an explicit error, only halt). The recommendation remains: leave `compensation.terminalErrors` empty unless there is a genuine "compensation cannot proceed" condition the external observer must distinguish.

| Event | Execution VEL | Compensation VEL |
| --- | --- | --- |
| `ctx.terminalErrors.X(...)` thrown | Workflow fails → compensation runs | Compensation VEL fails (stops) |
| `ctx.branchErrors.X(...)` thrown (in an `"explicit"` branch/body) | Captured at the parent consumption point as `ErrorValue<TBranchErrors>` | Same |
| Any throw in an `"any"` branch/body | Captured at the parent consumption point as `Failure` | Same |
| Step timeout (no `.timeout(cb)` chained) | Halt | Halt |
| Step timeout (caught via `.timeout(cb)`) | Callback runs; its return value is the resolved result | Same |
| Child workflow failure (no `.failure(cb)` chained — disallowed by type) | Compile-time error | Compile-time error |
| Child workflow failure (caught via `.failure(cb)`) | Callback runs; its return value or rethrow follows per-context rules | Same |
| Undeclared exception (anywhere mode is `"none"` or `"explicit"`) | Halt the execution VEL | Halt the compensation VEL |

The rationale for keeping compensation strict-by-default: cleanup is supposed to be defensive. If a step times out or a child workflow fails inside a compensation callback, that is an *expected* condition — the systems being undone may be partially degraded. The `.timeout(cb)` / `.failure(cb)` callbacks at the call site are how the developer declares what to do. There is no implicit "if anything goes wrong in compensation, give up silently."

**`CompensationFailureInfo<TCompensationTerminalErrors>`** collapses to `ErrorValue<TCompensationTerminalErrors>` — the same shape, sourced from the compensation map. Observable via `handle.compensation.wait()`.

### Rationale recap

Three rough edges in the prior design motivated this collapse:

1. **The external failure surface lumped conceptually disjoint things.** A developer-declared business signal lived in the same union as engine-generated operational events (step timeout, request timeout, child workflow failure, child workflow timeout). The external caller had to triage both categories with the same switch, and child workflow failures had to recursively carry a fully untyped child error variant — defeating type safety for any non-trivial child workflow tree. The fix: only developer-declared errors reach the external boundary.

2. **Error scoping was binary (workflow vs nothing).** There was no clean way to model recoverable per-branch failures that should fail one branch without failing the whole workflow. Scope-level `.failure(cb)` existed but received a loose `ScopeFailureInfo<TSteps, TChildWorkflows>` with an `{ kind: "exception"; error: unknown }` escape hatch, defeating type safety. The fix: per-branch `errors:` declarations with three modes; the consumer pattern-matches on a typed result.

3. **`match` was verbose and weakly typed.** The prior `ctx.match(sel, handlers)` form accepted a per-key `{ complete, failure }` object whose `failure` parameter was the loose `ScopeFailureInfo` rather than the branch's own typed errors. The fix (Part 7): a single `match` overload returning a discriminated `{ key, val }` async iterable, where `val` shape per key reflects the source's mode.

---

## Part 5: Step Timeout Unification

### Problem

`maxAttempts` lives in `RetryPolicyOptions` alongside retry behavior configuration. But `maxAttempts` is not a retry behavior — it is a stop condition. It answers "when to give up," not "how to retry." Compounding this: today's `StepCall.failure(cb)` and `WorkflowCall.failure(cb)` callbacks receive only an `info` argument, with no surrounding context — making it impossible to do durable recovery work like "post a Slack notification when this step times out." And there is no clean rule about which call-site error events become external-visible vs call-site-local — engine events surface alongside developer errors at the workflow boundary.

### Solution

Remove `maxAttempts` from `RetryPolicyOptions`. Move it into a `.timeout()` builder boundary. Make the `.timeout(boundary, cb)` callback form the **only** valid form (no callback = the call has no boundary at all and retries forever). Make `.failure(cb)` mandatory on `WorkflowCall`. Order the chain. Remove the engine-level error variants from the external `FailureInfo` (Part 4).

**`RetryPolicyOptions` becomes purely about retry behavior:**

```typescript
interface RetryPolicyOptions {
  intervalSeconds?: number;     // initial retry interval (default: 1)
  backoffRate?: number;         // backoff multiplier (default: 2)
  maxIntervalSeconds?: number;  // interval cap (default: 300)
  timeoutSeconds?: number;      // per-attempt execution timeout (signal abort)
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

`seconds` and `deadline` are mutually exclusive — `seconds` is a relative wall-clock timeout, `deadline` is an absolute timestamp. `maxAttempts` can coexist with either. The shorthand `number` (seconds) or `Date` (deadline) is accepted in place of a `StepBoundary` everywhere.

```typescript
.timeout(60, (ctx, info) => null)                        // 60 seconds overall
.timeout(new Date("2027-01-10"), (ctx, info) => null)    // absolute deadline
.timeout({ maxAttempts: 5 }, (ctx, info) => null)        // 5 attempts max
.timeout({ maxAttempts: 5, seconds: 60 }, (ctx, info) => null)
.timeout({ maxAttempts: 5, deadline: d }, (ctx, info) => null)
```

`maxAttempts` and `seconds`/`deadline` complement each other — both can coexist in the same boundary. `maxAttempts` limits how many times the step is tried. `seconds`/`deadline` limits total wall-clock time. Whichever boundary is reached first terminates the step.

> **`.timeout()` is itself optional, but the callback is mandatory when `.timeout()` is called.** If `.timeout()` is omitted entirely, the operation retries forever (per `RetryPolicyOptions`); there is no boundary, and the only way the call returns is success. If `.timeout()` is called, it must include a callback. There is no `.timeout(boundary)` no-callback form: such a form would force a "timeout exceeded with no recourse" path into the workflow's external `FailureInfo`, which is exactly the engine-level surface that Part 4 collapses out. The mandatory callback ensures every declared boundary has an explicit local recovery path. If recovery should fail the workflow, the callback throws `ctx.terminalErrors.X(...)`; if it should fail just the local branch, throws `ctx.branchErrors.X(...)`; if it should produce a value, it returns one.

### Chain ordering

The chain on `StepCall`, `WorkflowCall`, and `RequestCall` is strictly ordered, encoded via the `Called` type parameter:

```
(.retry)? → (.timeout)? → (.failure on WorkflowCall — mandatory)? → (.compensate)? → (.complete)? → .resolve
```

Each method may be called at most once. `.compensate` is a fence: after it is called, subsequent attempts to call `.retry`, `.timeout`, or `.failure` resolve to `never`. The reason — repeated from Part 2 because it is the central rationale — is that the compensation callback's `result` parameter type *depends on* the union narrowed by the prior chain steps. Allowing later chained `.timeout` or `.failure` to retroactively widen or narrow that union would silently invalidate the type the compensation callback was authored against. Locking the chain after `.compensate` is what makes the callback's type stable at the point it is written.

### Callback signatures

`.timeout` and `.failure` callbacks both receive `(ctx, info)`. The `ctx` parameter is the surrounding workflow or compensation context — callbacks can invoke durable primitives (steps, requests, channels, attribute writes) inside recovery, just as they can in the surrounding body. This was a real expansion: the prior design exposed only `info`, which made it impossible to do durable recovery work like "post a Slack notification when this step times out."

```typescript
type TimeoutInfo<TArgs> = {
  readonly reason: "attempts_exhausted" | "deadline";
  readonly args: TArgs;
  readonly attempts: AttemptAccessor;
};

type StepFailureInfo<TArgs> = TimeoutInfo<TArgs>;
// Identical shape — kept as an alias for callback-info typing on steps.

type ChildWorkflowFailureInfo<TArgs, TChildTerminalErrors> =
  | { readonly status: "failed"; readonly args: TArgs; readonly error: ErrorValue<TChildTerminalErrors> }
  | { readonly status: "terminated"; readonly args: TArgs }
  | { readonly status: "timed_out"; readonly args: TArgs; readonly reason: "attempts_exhausted" | "deadline" };
```

A throw inside any callback follows the per-context throw rules (Part 3). The callback inherits the mode of the branch or body where its enclosing chain was authored:

- Inside an `"any"` branch (or `"any"` scope body): captured as `Failure`.
- Inside an `"explicit"` branch: must match the branch's declared subset, else halt.
- Inside a `"none"` branch (or `"none"` body): must be a `terminalErrors` factory, else halt.
- Inside the workflow's `execute` body: must be a `terminalErrors` factory, else halt.

### Updated `StepCall`

```typescript
interface StepCall<
  TArgs,
  T,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
  Called extends string = never,
> extends DurableHandle<T | TTimeout, ExecutionRoot> {
  retry: "retry" | "timeout" | "compensate" | "complete" extends Called ? never :
    (policy: RetryPolicyOptions) =>
      StepCall<TArgs, T, TTimeout, HasCompensation, Tctx, Called | "retry">;

  timeout: "timeout" | "compensate" | "complete" extends Called ? never :
    & (<R>(secondsOrDeadline: number | Date, cb: (ctx: Tctx, info: TimeoutInfo<TArgs>) => R) =>
        StepCall<TArgs, T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(opts: StepBoundary, cb: (ctx: Tctx, info: TimeoutInfo<TArgs>) => R) =>
        StepCall<TArgs, T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">);

  compensate: "compensate" | "complete" extends Called ? never :
    & ((
        cb: (ctx: Tctx, result: StepCompensationResult<TArgs, T>) => Promise<void>,
      ) => StepCall<TArgs, T, TTimeout, true, Tctx, Called | "compensate">)
    & ((
        name: string,
        cb: (ctx: Tctx, result: StepCompensationResult<TArgs, T>) => Promise<void>,
      ) => StepCall<TArgs, T, TTimeout, true, Tctx, Called | "compensate">);

  complete: "complete" extends Called ? never :
    <R>(cb: (data: T | TTimeout) => R) =>
      StepCall<TArgs, Awaited<R>, never, HasCompensation, Tctx, Called | "complete">;
}
```

Key changes from the prior version:

- **No `.failure()` on `StepCall`.** Steps don't fail — they succeed or hit a boundary. Reaching a boundary fires `.timeout(boundary, cb)` if chained; if `.timeout()` was omitted, the operation retries forever.
- **`.timeout(boundary)` no-callback form is gone.** The callback is mandatory when `.timeout()` is chained.
- **No engine-level `StepTimeoutError` in the external surface.** If the developer omits `.timeout(cb)` and the operation never naturally terminates, that's their choice (retry forever). If they chain `.timeout(cb)`, the callback owns the recovery.
- **Callback receives `(ctx, info)`** — recovery can invoke durable primitives.

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
  .timeout({ maxAttempts: 3 }, (ctx, info) => null)
  .resolve(ctx);
```

### `StepCompensationResult`

The compensation callback's `result` parameter — passed at LIFO unwind or eager promotion — is unchanged in shape and remains a discriminated union. It represents the *engine-level* outcome of the step (was the work completed, did it hit its boundary, was it terminated), not the workflow-side recovery value (which is what `.timeout(cb)` produced and is the one used by the rest of the workflow). The engine-level outcome is what compensation needs to know about: whether the side effect was performed.

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

### Updated `WorkflowCall`

`.failure(cb)` is **type-mandatory**: `.compensate` and `.resolve` both require `"failure" extends Called`. There is no path to terminating a child workflow chain without declaring how to handle the child's failure. This is what collapses every "uncaught child workflow failure" event out of the parent's external `FailureInfo`.

```typescript
interface WorkflowCall<
  TArgs,
  T,
  TChildTerminalErrors,
  TFail = never,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
  Called extends string = never,
> extends DurableHandle<T | TFail | TTimeout, ExecutionRoot> {
  retry: "retry" | "timeout" | "failure" | "compensate" | "complete" extends Called ? never :
    (policy: RetryPolicyOptions) =>
      WorkflowCall<TArgs, T, TChildTerminalErrors, TFail, TTimeout, HasCompensation, Tctx, Called | "retry">;

  timeout: "timeout" | "failure" | "compensate" | "complete" extends Called ? never :
    & (<R>(secondsOrDeadline: number | Date, cb: (ctx: Tctx, info: TimeoutInfo<TArgs>) => R) =>
        WorkflowCall<TArgs, T, TChildTerminalErrors, TFail, Awaited<R>, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(opts: StepBoundary, cb: (ctx: Tctx, info: TimeoutInfo<TArgs>) => R) =>
        WorkflowCall<TArgs, T, TChildTerminalErrors, TFail, Awaited<R>, HasCompensation, Tctx, Called | "timeout">);

  // Type-mandatory: must be called before .compensate or .resolve.
  failure: "failure" | "compensate" | "complete" extends Called ? never :
    <R>(cb: (ctx: Tctx, info: ChildWorkflowFailureInfo<TArgs, TChildTerminalErrors>) => R) =>
      WorkflowCall<TArgs, T, TChildTerminalErrors, Awaited<R>, TTimeout, HasCompensation, Tctx, Called | "failure">;

  compensate: "failure" extends Called
    ? "compensate" | "complete" extends Called ? never :
        & ((
            cb: (ctx: Tctx, result: StepCompensationResult<TArgs, T | TFail | TTimeout>) => Promise<void>,
          ) => WorkflowCall<TArgs, T, TChildTerminalErrors, TFail, TTimeout, true, Tctx, Called | "compensate">)
        & ((
            name: string,
            cb: (ctx: Tctx, result: StepCompensationResult<TArgs, T | TFail | TTimeout>) => Promise<void>,
          ) => WorkflowCall<TArgs, T, TChildTerminalErrors, TFail, TTimeout, true, Tctx, Called | "compensate">)
    : never;

  complete: "failure" extends Called
    ? "complete" extends Called ? never :
        <R>(cb: (data: T | TFail | TTimeout) => R) =>
          WorkflowCall<TArgs, Awaited<R>, TChildTerminalErrors, never, never, HasCompensation, Tctx, Called | "complete">
    : never;

  // Inherited from DurableHandle, but also gated on .failure being called:
  // resolve(ctx): "failure" extends Called ? Promise<T | TFail | TTimeout> : never;
}
```

The `TChildTerminalErrors` type parameter threads the child workflow's declared `terminalErrors` map into the `.failure(cb)` callback's info type. The callback receives `ChildWorkflowFailureInfo<TArgs, TChildTerminalErrors>`:

```typescript
type ChildWorkflowFailureInfo<TArgs, TChildTerminalErrors> =
  | { status: "failed"; args: TArgs; error: ErrorValue<TChildTerminalErrors> }
  | { status: "terminated"; args: TArgs }
  | { status: "timed_out"; args: TArgs; reason: "attempts_exhausted" | "deadline" };
```

The `error` field is fully typed against the child's own `terminalErrors` — no untyped child variant, no recursive nesting. The parent narrows on `errorCode` exactly as if it had received an `ErrorValue` directly. This is the central type-safety win of the redesign.

What `.failure(cb)` can do:

- **Return a recovery value** — the parent continues with that value. The child's failure does not propagate.
- **Throw `ctx.terminalErrors.X(...)`** — lifts the child's failure into the parent's own terminal contract. The parent's external surface uses the parent's terms.
- **Throw `ctx.branchErrors.X(...)`** — lifts into the local branch's contract. Fails only the local branch (escapes to the local match/join consumption point).
- **Rethrow** the engine's own `info` value — semantically equivalent to "I have nothing to add, fail the parent." But because `.failure(cb)` is type-mandatory, this rethrow must also obey the per-context throw rules: rethrowing the typed `info` (which is not an `ExplicitError`) inside a `"none"` body would halt. The intended pattern is to throw a typed terminal/branch error explicitly.

### Rationale recap

- **Mandatory callback on `.timeout()`.** Without it, the no-callback form would push a typed engine event into the external `FailureInfo`. The whole point of Part 4's collapse is to keep that surface free of engine events.
- **Mandatory `.failure(cb)` on `WorkflowCall`.** Same argument, doubled: a child workflow's failure can only be safely observed in the parent if it is typed against the *parent's* error vocabulary. Forcing the parent to declare a handler at the call site means the child's failure either becomes the parent's recovery value, or becomes one of the parent's own typed terminal/branch errors. Either way the parent's external surface stays clean.
- **Chain ordering.** Compensation callbacks were authored against the union narrowed by `.timeout` and `.failure` chained earlier. Allowing those to be chained later would change the type and silently invalidate the callback. Locking the chain after `.compensate` keeps the type stable.

---

## Part 6: Context Splitting

### Problem

The execution VEL and compensation VEL run in parallel. If they share channels, state, streams, events, attributes, and rng, their interactions become non-deterministic — the order in which the two VELs read/write shared state is unpredictable across replays.

### Solution

Split all shared primitives between the two VELs. Each VEL gets its own dedicated instances:

| Primitive             | Execution VEL                              | Compensation VEL                                            |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `ctx.channels`        | Execution channels                         | Compensation channels                                       |
| `ctx.state`           | Execution state                            | Compensation state (separate factory call)                  |
| `ctx.streams`         | Execution streams                          | Compensation streams                                        |
| `ctx.events`          | Execution events                           | Compensation events                                         |
| `ctx.attributes`      | Execution attributes                       | Compensation attributes                                     |
| `ctx.rng`             | Execution RNG                              | Compensation RNG (separate seed)                            |
| `ctx.terminalErrors`  | From `terminalErrors`                      | From `compensation.terminalErrors` (may be empty)           |
| `ctx.branchErrors`    | From the surrounding branch's `errors:` map (only inside an `"explicit"`-mode branch; empty record otherwise) | Same — sourced from the surrounding compensation branch's `errors:` map |

This is a hard split. The execution VEL cannot read from or write to compensation channels, and vice versa. External callers target specific channels when sending messages.

The state factory function is called twice — once for each VEL — producing independent state objects. RNG streams are seeded separately so the same `ctx.rng.txnId.uuidv4()` call produces different (but individually deterministic) values in each VEL.

### Unified builder shape across contexts

The compensation context exposes the **same** `StepCall`, `WorkflowCall`, and `RequestCall` types as the execution context — there are no `CompensationStepCall<T>` / `CompensationWorkflowCall<T>` distinct types. The single `Tctx` type parameter on each call type carries the compensation-context flavor (so `.compensate(cb)`, `.timeout(cb)`, `.failure(cb)` callbacks receive the appropriate context). The implication is that a step or child workflow invoked from inside a compensation callback uses identical builder ergonomics — `.retry`, `.timeout(boundary, cb)`, `.failure(cb)` (on `WorkflowCall`), `.compensate(cb)`, `.complete(cb)`, `.resolve(ctx)` — and obeys identical chain ordering and per-context throw rules.

The previous distinction (separate compensation-side call types) is dropped because it added a parallel API surface without adding any expressive power: the only meaningful axis of variation between execution and compensation is which `ctx` the chain runs against, and that's already a type parameter.

---

## Part 7: Scopes, Convenience Scope Methods, and Structured-Concurrency Consumption

All scopes must be named. The convenience scope methods (`.all`, `.first`, `.atMost`, `.atLeast`, `.best`) and the consumption surface (`select` / `match` / `join`) live on the same context.

### Branch and scope-body shape

A scope branch (and a scope body) accepts the same four shapes (defined in Part 4):

```typescript
// Form 1 — function shorthand. Mode "none" by default. Anything thrown that isn't
// a `terminalErrors` factory halts.
async (ctx) => { /* returns T */ }

// Form 2 — object form, mode "none" (explicit).
{ execute: async (ctx) => { /* ... */ }, errors: "none" }

// Form 3 — object form, mode "any". Any throw → captured as Failure at the parent
// consumption point. terminalErrors still escape.
{ execute: async (ctx) => { /* ... */ }, errors: "any" }

// Form 4 — object form, mode "explicit". Throws of `ctx.branchErrors.X(...)`
// from the declared keys are captured as ErrorValue<TBranchErrors> at the parent
// consumption point. Anything else halts. terminalErrors still escape.
{
  execute: async (ctx) => {
    if (badInput) throw ctx.branchErrors.InvalidInput("...", { field: "x" });
  },
  errors: { InvalidInput: z.object({ field: z.string() }) },
}
```

**Default for shorthand and bare object form is mode `"none"`.** This is the conservative default that prevents accidental capture of programming errors. Branches and scope bodies are symmetric in this regard.

`ctx.scope(name, branches, body)` follows the same shape rules. A function-shorthand body means mode `"none"`: the body's outer `.resolve()` returns the bare value `T`, and any non-`terminalErrors` throw inside the body halts. An object-form body in mode `"any"` makes the outer `.resolve()` return `{ ok: true; res: T } | { ok: false; err: Failure }`. An object-form body in mode `"explicit"` makes it return `{ ok: true; res: T } | { ok: false; err: ErrorValue<TBodyErrors> }`. The body's `errors:` declaration is independent of any branch's `errors:`.

```typescript
const result = await ctx
  .scope("Confirm", { /* branches */ }, async (ctx, handles) => {
    /* mode "none" — bare T return */
    return computed;
  })
  .resolve(ctx);
// result: <bare T>

const wrapped = await ctx
  .scope("Confirm", { /* branches */ }, {
    execute: async (ctx, handles) => { return computed; },
    errors: "any",
  })
  .resolve(ctx);
// wrapped: { ok: true; res: T } | { ok: false; err: Failure }
```

### Structured-concurrency consumption: `select`, `match`, `join`

These three methods consume the typed handles produced by the surrounding scope. They live on `ctx` (and on the inner `ctx` exposed to scope bodies).

**`ctx.select(handles)`** — wait for the first selectable to complete, return its key. Unchanged from prior versions. Returns the key only; the developer subsequently awaits the chosen handle if a value is needed.

**`ctx.match(sel)`** — single overload, no handlers. Returns an async iterable of `{ key, val }` pairs in the order each selectable resolves. The consumer pattern-matches in a `for await` loop. The shape of `val` is determined by the source:

| Source | `val` shape |
| --- | --- |
| Branch handle in mode `"none"` | `T` (bare value) |
| Branch handle in mode `"any"` | `{ ok: true; res: T } \| { ok: false; err: Failure }` |
| Branch handle in mode `"explicit"` | `{ ok: true; res: T } \| { ok: false; err: ErrorValue<TBranchErrors> }` |
| `ChannelHandle<T>` / `ChannelReceiveCall<T>` | `T` (channels don't fail) |
| `Sleep` (`ctx.sleep(...)` / `ctx.sleepUntil(...)`) | `void` — the key alone is the signal |

```typescript
type MatchYield<S extends Record<string, Selectable>> = {
  [K in keyof S & string]: { key: K; val: ValShape<S[K]> };
}[keyof S & string];

match<S extends Record<string, Selectable>>(sel: S): AsyncIterable<MatchYield<S>>;
```

The discriminant is `key`. The consumer narrows `val` by switching on `key`:

```typescript
for await (const { key, val } of ctx.match({
  flight: flightHandle,        // mode "any"
  hotel: hotelHandle,          // mode "explicit" with errors { Sold: true }
  msg: ctx.channels.cancel.receive(),
  giveUp: ctx.sleep(60),
})) {
  switch (key) {
    case "flight":
      // val: { ok: true; res: FlightBooking } | { ok: false; err: Failure }
      if (!val.ok) console.warn(val.err.message);
      else recordFlight(val.res);
      break;
    case "hotel":
      // val: { ok: true; res: HotelBooking } | { ok: false; err: ErrorValue<{ Sold: true }> }
      if (!val.ok) {
        if (val.err.errorCode === "Sold") fallbackToOtherHotel();
      }
      break;
    case "msg":
      // val: CancelMessage
      return cancelEverything(val);
    case "giveUp":
      // val: void
      return abortAll();
  }
}
```

**There is no handler-form `match`.** The previous `ctx.match(sel, handlers)` overload (with per-key `{ complete, failure }` callbacks) is removed entirely. The reasons: handlers nest poorly (the onboarding example previously took 5 branches × 2 handlers each = 50+ lines of nested closures), the `failure` parameter was the loose `ScopeFailureInfo` instead of the branch's own typed errors, and developers reaching for early-exit, ordered-effect, or shared-mutable-state patterns inside handlers were forced into awkward workarounds. A linear `for await` loop with discriminated yields collapses both the verbosity and the typing weakness.

The onboarding example (`src/examples/onboarding-verification.example.ts`) is the canonical motivation: under this revision it collapses from ~60 lines of handler closures to ~25 lines of straight-line control flow with stronger types throughout.

**`ctx.join(handle)`** — returns the typed `val` shape directly (no `{ key, val }` wrapper, since there is only one source).

```typescript
join<H extends Selectable>(handle: H): Promise<ValShape<H>>;
```

For a mode-`"none"` handle, `join` returns `T`. For a mode-`"any"` handle, it returns `{ ok: true; res: T } | { ok: false; err: Failure }`. For a mode-`"explicit"` handle, `{ ok: true; res: T } | { ok: false; err: ErrorValue<TBranchErrors> }`. There is no separate "safe" form of `join` — authoring a branch in mode `"any"` or `"explicit"` is the way to opt into "join doesn't throw, it returns a value to switch on."

These three operations are also available on the compensation context with identical signatures.

### Convenience scope methods

These are *scope variants* where the engine acts as the body — each defines its own consumption strategy. All return `{ ok: true; res: ... } | { ok: false; err: ... }` (or, for primitives that have no failure case, the bare result). The `err` shape is defined per primitive inline. **None of these primitives expose a `.failure(cb)` builder method** — failure is in the return value; the developer pattern-matches.

| Method | Strategy | `res` (when `ok`) | `err` (when not `ok`) |
| --- | --- | --- | --- |
| `.all` | wait for every branch | `Record<K, branch-K's val shape>` | `{ errorCode: "SomeBranchesFailed"; message; details: { failed: Partial<Record<K, branch-K's err shape>>; completed: Partial<Record<K, branch-K's res shape>> } }` |
| `.first` | first to complete wins; the rest are eagerly compensated | `{ key: K; value: T_K }` | `{ errorCode: "NoBranchCompleted"; message; details: { branchFailures: Record<K, branch-K's err shape> } }` |
| `.atMost(n)` | first `n` to complete; the rest are eagerly compensated. No failure case (always returns whatever is available) | `Array<{ key: K; value: T_K }>` (length ≤ `n`) | (no failure case — always unwrapped) |
| `.atLeast(n)` | wait until at least `n` complete | `Array<{ key: K; value: T_K }>` (length ≥ `n`) | `{ errorCode: "QuorumNotMet"; message; details: { required: n; got: number; failed: Partial<Record<K, branch-K's err shape>>; completed: Partial<Record<K, branch-K's res shape>> } }` |
| `.best` | collect as many as complete; failures are eagerly compensated. No failure case | `Array<{ key: K; value: T_K }>` (best-effort) | (no failure case — always unwrapped) |

The "branch-K's val shape" / "branch-K's err shape" / "branch-K's res shape" terminology references the per-branch mode table from `match`:

- A branch in mode `"none"`: its `val` shape is `T`. Its `res` shape is `T`. Its `err` shape is *uninhabited* (the branch can't fail without halting). If a `"none"`-mode branch is used inside an `.all` / `.first` / `.atLeast` and it halts, the convenience method itself halts (the halt propagates).
- A branch in mode `"any"`: `val` is `{ ok, res } | { ok, err }`. Its `res` shape is `T`. Its `err` shape is `Failure`.
- A branch in mode `"explicit"`: `val` is `{ ok, res } | { ok, err }`. Its `res` shape is `T`. Its `err` shape is `ErrorValue<TBranchErrors>`.

Examples:

```typescript
const result = await ctx
  .all("BookEverything", {
    flight: { execute: async (c) => bookFlight(c), errors: "any" },
    hotel:  { execute: async (c) => bookHotel(c),  errors: { Sold: true } },
    car:    async (c) => bookCar(c),  // mode "none" — halts if anything goes wrong
  })
  .resolve(ctx);
// result:
//   { ok: true;  res: { flight: FlightBooking; hotel: HotelBooking; car: CarBooking } }
// | { ok: false; err: { errorCode: "SomeBranchesFailed"; message; details: {
//                        failed: Partial<{ flight: Failure; hotel: ErrorValue<{ Sold: true }> }>;
//                        completed: Partial<{ flight: FlightBooking; hotel: HotelBooking; car: CarBooking }>;
//                      } } }
```

```typescript
const winner = await ctx
  .first("FastestQuote", {
    providerA: async (c) => c.steps.getQuote({ provider: "A" }).resolve(c),
    providerB: async (c) => c.steps.getQuote({ provider: "B" }).resolve(c),
    providerC: async (c) => c.steps.getQuote({ provider: "C" }).resolve(c),
  })
  .resolve(ctx);
// winner:
//   { ok: true;  res: { key: "providerA" | "providerB" | "providerC"; value: Quote } }
// | { ok: false; err: { errorCode: "NoBranchCompleted"; ... } }
```

```typescript
const some = await ctx
  .atMost("PickTwo", 2, {
    providerA: async (c) => c.steps.getQuote({ provider: "A" }).resolve(c),
    providerB: async (c) => c.steps.getQuote({ provider: "B" }).resolve(c),
    providerC: async (c) => c.steps.getQuote({ provider: "C" }).resolve(c),
  })
  .resolve(ctx);
// some: Array<{ key: ...; value: Quote }>  (length ≤ 2). No failure case.
```

```typescript
const quorum = await ctx
  .atLeast("EnsureQuorum", 3, {
    nodeA: async (c) => c.steps.healthCheck({ node: "A" }).resolve(c),
    nodeB: async (c) => c.steps.healthCheck({ node: "B" }).resolve(c),
    nodeC: async (c) => c.steps.healthCheck({ node: "C" }).resolve(c),
    nodeD: async (c) => c.steps.healthCheck({ node: "D" }).resolve(c),
    nodeE: async (c) => c.steps.healthCheck({ node: "E" }).resolve(c),
  })
  .resolve(ctx);
// quorum:
//   { ok: true;  res: Array<{ key; value: HealthCheck }> /* length ≥ 3 */ }
// | { ok: false; err: { errorCode: "QuorumNotMet"; details: { required: 3; got; ... } } }
```

```typescript
const results = await ctx
  .best("GetAllQuotes", {
    providerA: async (c) => c.steps.getQuote({ provider: "A" }).resolve(c),
    providerB: async (c) => c.steps.getQuote({ provider: "B" }).resolve(c),
    providerC: async (c) => c.steps.getQuote({ provider: "C" }).resolve(c),
  })
  .resolve(ctx);
// results: Array<{ key: ...; value: Quote }>. No failure case.
```

### Type signatures

The shape of the call types differs only in the result type and (for `.atLeast`) the additional `n` parameter:

```typescript
type EntryRes<E, K extends keyof E> = /* the branch's res shape */;
type EntryErr<E, K extends keyof E> = /* the branch's err shape */;

interface AllResult<E> {
  ok: true;
  res: { [K in keyof E]: EntryRes<E, K> };
} | {
  ok: false;
  err: {
    errorCode: "SomeBranchesFailed";
    message: string;
    details: {
      failed: Partial<{ [K in keyof E]: EntryErr<E, K> }>;
      completed: Partial<{ [K in keyof E]: EntryRes<E, K> }>;
    };
  };
}

all<Name extends string, E extends Record<string, ScopeEntry<any>>>(
  name: ScopeNameArg<TScopePath, Name>, entries: E,
): AllCall<AllResult<E>, E, TSteps, TChildWorkflows, ExecutionRoot>;

first<Name extends string, E extends Record<string, ScopeEntry<any>>>(
  name: ScopeNameArg<TScopePath, Name>, entries: E,
): FirstCall<FirstResult<E>, E, TSteps, TChildWorkflows, ExecutionRoot>;

atMost<Name extends string, E extends Record<string, ScopeEntry<any>>>(
  name: ScopeNameArg<TScopePath, Name>, n: number, entries: E,
): AtMostCall<Array<{ key: keyof E & string; value: EntryRes<E, keyof E & string> }>, E, TSteps, TChildWorkflows, ExecutionRoot>;

atLeast<Name extends string, E extends Record<string, ScopeEntry<any>>>(
  name: ScopeNameArg<TScopePath, Name>, n: number, entries: E,
): AtLeastCall<AtLeastResult<E>, E, TSteps, TChildWorkflows, ExecutionRoot>;

best<Name extends string, E extends Record<string, ScopeEntry<any>>>(
  name: ScopeNameArg<TScopePath, Name>, entries: E,
): BestCall<Array<{ key: keyof E & string; value: EntryRes<E, keyof E & string> }>, E, TSteps, TChildWorkflows, ExecutionRoot>;
```

`ScopeNameArg` enforces the ancestor name collision check, consistent with `ctx.scope()`. None of these call types exposes a `.failure(cb)` builder; the chain on each is `(.compensate)? → (.complete)? → .resolve` (compensation is for the synthetic engine-as-body, which is a single registered cleanup).

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

The existing `src/types/search-query.ts` implements a typed query AST parameterized over two hardcoded namespaces: `engine` and `meta`. Generalizing it enables reuse for topic consumer metadata filters, dead-letter payload filters, and any future query surfaces.

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

### Range comparison restriction for union types

Range comparisons (`gt`, `gte`, `lt`, `lte`) and sorting are now restricted to fields where the non-null/non-undefined value resolves to purely `string` or purely `number` — not a union of both, and not a union with non-comparable types.

**Rationale:** Postgres JSONB has a total ordering across types (`null < boolean < number < string < array < object`), but this ordering is opaque and backend-specific. "Is `[1,2,3]` greater than `{"a": 1}`?" is answerable in Postgres but not meaningfully answerable in client-side filtering or in other storage backends. Restricting range comparisons to homogeneously typed fields ensures:

1. **Client-side filterability** — queries can be evaluated in-process with trivial JavaScript comparisons.
2. **Storage portability** — no dependency on Postgres's JSONB type ordering semantics.
3. **Developer clarity** — `field.gt(42)` on a field that might hold a string is confusing, regardless of what the database does.

Equality comparisons (`eq`, `ne`, `in`, `notIn`) remain available for all scalar types including unions — equality is universally well-defined.

**Sorting** follows the same rule: only fields with a homogeneous comparable type can appear in `sort` clauses. `MetaSortablePath` is now `MetaComparablePath` (was `MetaAnyPath`).

| Field type | Equality (`eq`/`ne`/`in`/`notIn`) | Range (`gt`/`gte`/`lt`/`lte`) | Sort |
| --- | --- | --- | --- |
| `string` | yes | yes | yes |
| `number` | yes | yes | yes |
| `boolean` | yes | no | no |
| `null` | yes | no | no |
| `string \| null` | yes | no | no |
| `string \| number` | yes | no | no |
| `string \| object` | yes | no | no |
| `readonly string[]` | `contains`/`containsAny`/`containsAll` | no | no |

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
    maxConcurrent: 10, // max concurrent handler invocations; undefined = unlimited
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

The handler receives `{ signal: AbortSignal }` as its first argument. The signal fires after `retryPolicy.timeoutSeconds` per attempt. `maxAttempts` is meaningful for queues: after exhaustion, the message is dead-lettered with `max_attempts`. Failed attempts are written to `queue_message_attempt` — only failures are recorded, successful processing writes the result directly. All retry policy fields are in seconds (durable, persisted to DB). Throwing `UnrecoverableError` dead-letters the message immediately, bypassing remaining retry attempts (see Part 15b).

`maxConcurrent` controls the maximum number of messages this consumer instance handles concurrently. When omitted (`undefined`), there is no limit — the consumer claims messages as fast as they arrive. When set, the consumer claims at most `maxConcurrent` messages at a time and waits for a slot to open before claiming the next. This prevents overwhelming downstream services and controls resource usage per consumer instance.

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

### Use cases

The request primitive is distinct from steps: steps perform an action and return a result (the workflow controls the logic), while requests are passive waiters for an external entity to fulfill a need (the workflow doesn't know or care how). This creates four distinct handler configurations, each serving a different real-world pattern:

**1. Handler is the sole resolver**

The handler always resolves the request programmatically. No fallback, no manual mode. The handler is effectively "the service" — it receives work and returns results. Unlike a step, the logic lives on the worker side (separately deployed, independently versioned), and multiple workflows share the same handler.

*Use case:* An ML scoring service. Workflows submit data for scoring, a handler runs the model and returns predictions. The workflow doesn't embed ML logic — it delegates to the handler.

```typescript
client.registerRequestHandler(mlScoring, async ({ signal }, request) => {
  return await runModel(request.features, { signal });
}, {
  retryPolicy: { timeoutSeconds: 30, maxAttempts: 5, intervalSeconds: 2 },
  // No onExhausted — handler must resolve or the request stays pending.
});
```

**2. Handler resolves, with manual fallback on exhaustion**

The handler tries to resolve programmatically. If all attempts fail, the system transitions to manual mode — a human or external process completes the work. The handler is the optimistic fast path; manual resolution is the safety net.

*Use case:* A hotel reservation system. The handler searches for availability, but if no hotel matches after retries (inventory changes, API downtime), an operations team manually finds and books a room.

```typescript
client.registerRequestHandler(reserveHotel, async ({ signal }, request) => {
  const hotel = await searchAvailability(request, { signal });
  if (hotel) return { hotelId: hotel.id, confirmation: hotel.ref };
  throw new Error("No availability");
}, {
  retryPolicy: { timeoutSeconds: 10, maxAttempts: 3, intervalSeconds: 5 },
  onExhausted: {
    callback: async ({ signal }, request) => {
      await notifyOpsTeam(request, { signal });
      return MANUAL;
    },
    retryPolicy: { intervalMs: 5000, backoffRate: 1.5, maxIntervalMs: 60_000 },
  },
});
```

**3. Check-or-wait (handler returns `MANUAL` directly)**

The handler checks whether an external condition has already been met. If yes, it resolves immediately. If not, it returns `MANUAL` — signaling that the answer will arrive from outside (a webhook, a user action, a third-party callback). The handler doesn't retry blindly; it makes an informed decision on each attempt.

*Use case:* Payment confirmation. A workflow requests confirmation that a bank transfer has landed. The handler polls the bank API — if the transfer is confirmed, it resolves. If not, it returns `MANUAL`, and a webhook from the bank later calls `client.requests.paymentConfirmation.resolve()`.

```typescript
client.registerRequestHandler(paymentConfirmation, async ({ signal }, request) => {
  const status = await checkPaymentStatus(request.paymentId, { signal });
  if (status.confirmed) {
    return { confirmed: true, transactionId: status.txId };
  }
  // Not yet — stop retrying, wait for webhook
  return MANUAL;
}, {
  retryPolicy: { timeoutSeconds: 10, maxAttempts: 3, intervalSeconds: 10 },
});
```

The distinction from pattern 2: here the handler *decides* to stop on each attempt (returns `MANUAL`), rather than being forced to stop after exhaustion. Throwing an error still retries — the handler uses `throw` for transient failures (bank API unreachable) and `return MANUAL` for definitive "not yet" determinations.

**4. Full external resolution (no handler)**

No handler is registered. The request sits in the database until an external actor resolves it via `client.requests.<name>.resolve()`. The workflow is purely passive.

*Use case:* Human-in-the-loop approval. A compliance workflow creates a review request. A dashboard displays pending requests. A compliance officer reviews the data and clicks "approve" or "reject," which calls the client API.

```typescript
// No handler registered — resolution comes from the dashboard
const decision = await ctx.requests
  .complianceReview({ orderId, riskScore, flaggedRules })
  .timeout(86400 * 7, (ctx, info) => ({ decision: "auto-reject" as const, note: "Review timed out" }))
  .resolve(ctx);
```

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

Requests are Tier 1 but NOT `StepCall` instances. They have their own call type extending `DurableHandle` directly. Timeout is controlled via the `.timeout(boundary, cb)` builder, following the same pattern as `StepCall` — not as a constructor option. As with steps, the `.timeout()` callback is mandatory; the no-callback form does not exist.

```typescript
// Wait indefinitely (no .timeout() chained — request retries forever, only resolves on success)
const result = await ctx.requests
  .humanReview({ context: "...", data: signals })
  .compensate(async (ctx, result) => {
    /* ... */
  })
  .resolve(ctx);

// With timeout + fallback
const result = await ctx.requests
  .humanReview({ context: "...", data: signals })
  .priority(1)
  .timeout(300, (ctx, info) => null)
  .compensate(async (ctx, result) => {
    /* ... */
  })
  .complete((r) => r?.decision ?? "auto-reject")
  .resolve(ctx);
// result: "approve" | "reject" | "auto-reject"

// With deadline
const result = await ctx.requests
  .humanReview({ context: "...", data: signals })
  .timeout(new Date("2027-01-10T08:00:00Z"), (ctx, info) => null)
  .resolve(ctx);
```

### `RequestCall` type

The chain order is `(.priority)? → (.timeout)? → (.compensate)? → (.complete)? → .resolve`. Each method may be called at most once. Like `StepCall`, `RequestCall` has no `.failure(cb)` — requests do not have a "failure" concept distinct from timeout (the only outcomes the workflow sees are "resolved with response" and "timeout reached"; handler retries and the manual-mode lifecycle are entirely on the handler side, see "Retry policy and exhaustion" below). The chain after `.compensate` is locked from `.priority`/`.timeout` for the same reason as `StepCall` (Part 5): the compensation callback's `result` parameter type depends on the union narrowed by `.timeout(cb)`.

```typescript
interface RequestCall<
  TPayload,
  T,
  TTimeout = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
  Called extends string = never,
> extends DurableHandle<T | TTimeout, ExecutionRoot> {
  priority: "priority" | "timeout" | "compensate" | "complete" extends Called ? never :
    (value: number) =>
      RequestCall<TPayload, T, TTimeout, HasCompensation, Tctx, Called | "priority">;

  timeout: "timeout" | "compensate" | "complete" extends Called ? never :
    & (<R>(secondsOrDeadline: number | Date, cb: (ctx: Tctx, info: TimeoutInfo<TPayload>) => R) =>
        RequestCall<TPayload, T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">)
    & (<R>(opts: StepBoundary, cb: (ctx: Tctx, info: TimeoutInfo<TPayload>) => R) =>
        RequestCall<TPayload, T, Awaited<R>, HasCompensation, Tctx, Called | "timeout">);

  compensate: "compensate" | "complete" extends Called ? never :
    & ((
        cb: (ctx: Tctx, result: RequestCompensationResult<T | TTimeout>) => Promise<void>,
      ) => RequestCall<TPayload, T, TTimeout, true, Tctx, Called | "compensate">)
    & ((
        name: string,
        cb: (ctx: Tctx, result: RequestCompensationResult<T | TTimeout>) => Promise<void>,
      ) => RequestCall<TPayload, T, TTimeout, true, Tctx, Called | "compensate">);

  complete: "complete" extends Called ? never :
    <R>(cb: (data: T | TTimeout) => R) =>
      RequestCall<TPayload, Awaited<R>, never, HasCompensation, Tctx, Called | "complete">;
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

A module-level export. Can be returned from two places:

1. **From the handler itself** — the handler checked the external system and determined the result isn't available yet. Retrying won't help — the resolution will come from outside. The engine stops invoking the handler and transitions the request to `status = 'manual'`. This is a non-exceptional outcome: the handler successfully determined that it can't resolve the request.
2. **From `onExhausted`** — the handler exhausted its retry budget. The fallback decision is to wait for external resolution.

In both cases, the request transitions to manual mode and waits for `client.requests.<name>.resolve()`.

The handler return type is `TResponse | typeof MANUAL`.

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
    maxConcurrent: 5,
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

**Example: check-or-wait (handler returns `MANUAL` directly)**

```typescript
const unregister = client.registerRequestHandler(
  paymentConfirmation,
  async ({ signal }, request) => {
    // Check if the payment has already been confirmed externally
    const status = await checkPaymentStatus(request.paymentId, { signal });
    if (status.confirmed) {
      return { confirmed: true, transactionId: status.txId };
    }
    // Not confirmed yet — stop trying, wait for webhook to resolve via client API
    return MANUAL;
  },
  {
    retryPolicy: {
      timeoutSeconds: 10,
      maxAttempts: 3,
      intervalSeconds: 5,
    },
    // No onExhausted needed — the handler itself transitions to manual
    // when it determines the result isn't available yet.
    // If the handler throws (e.g., network error), it retries normally.
    // If it returns MANUAL, retries stop immediately.
  },
);
```

The distinction between throwing and returning `MANUAL` is important:
- **Throw** → transient failure, retry. The external system might be temporarily unreachable.
- **Return `MANUAL`** → definitive determination. The handler successfully checked and the result isn't available yet. Retrying won't change that.

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

- `maxConcurrent` — max concurrent handler invocations for this consumer instance. `undefined` = unlimited. Controls how many requests this handler processes in parallel.
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
  priority                INT NOT NULL DEFAULT 0,
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

### Priority

Requests support optional priority, mirroring queue message priority.

- `priority: number` — optional on the workflow call site. Lower number = higher urgency. Default: `0`.
- Handlers claim requests ordered by `priority ASC, created_at ASC, id ASC` — highest-urgency first, FIFO within the same priority.
- Priority is set by the workflow that creates the request, not by the handler.

```typescript
// Workflow call site — priority on the builder
const decision = await ctx.requests.humanReview({ context: "order-123", data: orderData })
  .priority(1)        // urgent — processed before default-priority requests
  .timeout(3600, (ctx, info) => ({ decision: "auto-reject" as const, note: "Review timed out" }))
  .resolve(ctx);
```

The `requests` table gains a `priority` column:

```sql
ALTER TABLE requests ADD COLUMN priority INT NOT NULL DEFAULT 0;
```

Claim query becomes: `SELECT ... FROM requests WHERE request_name = $1 AND status = 'pending' ORDER BY priority ASC, created_at ASC, id ASC FOR UPDATE SKIP LOCKED LIMIT 1`.

### Manual resolution client API

Requests in `status = 'manual'` (or `'pending'`, for direct external resolution) need a client-level API for external actors (admin dashboards, human operators, third-party integrations) to resolve them.

```typescript
// Resolve a manual request
const result = await client.requests.humanReview.resolve(requestId, {
  decision: "approve",
  note: "Approved by admin",
});
// result: { ok: true, status: "resolved" } | { ok: false, status: "already_resolved" | "not_found" | "cancelled" }

// List pending manual requests
const pending = await client.requests.humanReview.list({
  status: "manual",
  limit: 50,
  cursor: prevCursor,
});
// pending: { items: Array<{ id, payload, status, createdAt, attempts: AttemptAccessor }>, cursor }

// Cancel a request (workflow's .timeout(cb) callback fires with reason: "deadline";
// or, if no .timeout() was chained at the call site, the workflow halts)
const cancelResult = await client.requests.humanReview.cancel(requestId);
```

**Type:**

```typescript
type RequestResolveResult =
  | { ok: true; status: "resolved" }
  | { ok: false; status: "already_resolved" | "not_found" | "cancelled" };

type RequestCancelResult =
  | { ok: true; status: "cancelled" }
  | { ok: false; status: "already_resolved" | "not_found" | "already_cancelled" };

interface RequestListItem<TPayload> {
  readonly id: string;
  readonly payload: TPayload;
  readonly status: "pending" | "claimed" | "manual";
  readonly priority: number;
  readonly createdAt: Date;
  readonly claimedAt: Date | null;
  readonly attempts: AttemptAccessor;
}

interface RequestListResult<TPayload> {
  readonly items: readonly RequestListItem<TPayload>[];
  readonly cursor: string | null;
}
```

**Semantics:**

- `resolve()` validates the response against the request's response schema. Type-safe: the second argument is `InferInput<TResponseSchema>`.
- `resolve()` on a `'claimed'` request interrupts the handler via its `AbortSignal` (the handler's signal fires, the resolve wins).
- `resolve()` on a `'pending'` request resolves it before any handler claims it — useful for requests that don't need a handler at all (pure human-in-the-loop).
- `cancel()` transitions the request to `'cancelled'`. From the workflow's perspective, this fires the call site's `.timeout(cb)` callback with `reason: "deadline"` (the cancellation is treated as a deadline reached externally). If no `.timeout()` was chained at the call site, the workflow halts (per the per-context throw rules in Part 3).
- `list()` supports filtering by status and cursor-based pagination.
- `attempts` on each list item provides the error history for requests that have been attempted.

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
    await ingestToWarehouse(record, { signal });
  },
  {
    neverExpire: true,
    filter: (q) => q.and(
      q.meta.tenantId.eq("acme"),
      q.payload.type.eq("booking.confirmed"),
    ),
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
        // if (event.type === "offsetExpired") return "skip";  // neverExpire: true, so that event type is not possible
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

**Metadata filter (`filter`):**

Optional. A predicate builder callback that receives a `SearchQuery<{ meta: TMetadata; payload: TPayload }>` builder with namespaces for both the topic's metadata and payload schemas. Only records matching the filter are delivered to the handler — non-matching records are skipped (offset advances past them without invoking the handler).

```typescript
filter: (q) => q.meta.tenantId.eq("acme")
filter: (q) => q.and(q.meta.type.eq("booking.confirmed"), q.payload.amount.gte(100))
filter: (q) => q.or(q.payload.type.eq("booking.confirmed"), q.payload.type.eq("booking.cancelled"))
```

Both namespaces map directly to their JSONB columns in the `topic_records` table (`metadata` and `payload` respectively). The same restricted predicate system applies — equality-only for union types, range comparisons only for homogeneously typed fields.

**Execution strategy:** the engine batches multiple consumers for the same topic into a single query, fetching all potentially relevant records in one round-trip and routing them to the correct consumers client-side. The `affected_consumers` column uses each consumer's filter as a boolean expression inside `jsonb_build_object`, so the engine knows exactly which consumers need each record without re-evaluating the filters in application code.

```sql
-- Two consumers on the same topic, each with their own filter and offset:
--   analyticsConsumer: metadata tenantId = 'acme' AND payload type = 'booking.confirmed', last_id = 1042
--   billingConsumer:   metadata type = 'payment',                                        last_id = 1098

SELECT
  id,
  payload,
  metadata,
  jsonb_build_object(
    'analyticsConsumer', (metadata->>'tenantId' = 'acme' AND payload->>'type' = 'booking.confirmed'),
    'billingConsumer',   (metadata->>'type' = 'payment')
  ) AS affected_consumers
FROM topic_records
WHERE topic_name = 'auditEvents'
  AND id > 1042                           -- min(last_id) across all batched consumers
  AND (
    (id > 1042 AND metadata->>'tenantId' = 'acme' AND payload->>'type' = 'booking.confirmed')
    OR
    (id > 1098 AND metadata->>'type' = 'payment')
  )
ORDER BY id ASC
LIMIT 100;
```

Each row comes back with `affected_consumers: { "analyticsConsumer": true, "billingConsumer": false }` (or both true for overlapping matches). The engine dispatches accordingly. Since filters use the restricted predicate system (equality-only for union types), client-side fallback evaluation is trivially correct — no Postgres-specific ordering semantics leak into the routing logic.

**Registration options (`registration`):**

- `registration.retryPolicy` — runtime-level retry policy (milliseconds, infinite) for re-acquiring the advisory lock after a failed registration attempt. Purely runtime — never persisted.
- `registration.onRegistered` — called when the consumer successfully acquires the advisory lock and becomes active. Useful for logging, metrics, readiness probes. Purely runtime notification.
- `registration.onError` — called when a registration attempt fails (e.g., advisory lock conflict). Purely runtime notification.

**`neverExpire` option:**

When `neverExpire: true`, the topic's retention purge will not delete records that this consumer has not yet processed. The consumer's offset is guaranteed to always point to valid records — the `offsetExpired` event can never fire.

This is a per-consumer property, not per-topic. A topic can have both `neverExpire` consumers (that block retention) and normal consumers (that accept offset expiration). Retention purge deletes a record only when the retention period has elapsed AND no `neverExpire` consumer has `last_id < record.id`.

Consequence: a halted or offline `neverExpire` consumer causes unbounded storage growth. Deregistering the consumer (deleting the `topic_consumers` row) releases the hold.

The `onConsumeError` event type is narrowed at the type level based on `neverExpire`:

- `neverExpire: true` → event is only `"attemptsExhausted"`. No `"offsetExpired"` case.
- `neverExpire: false` or omitted → event is `"attemptsExhausted" | "offsetExpired"`.

**Consume error handling (`onConsumeError`):**

When record processing exhausts its `retryPolicy.maxAttempts` or (when `neverExpire` is not set) the consumer's offset has expired, the engine needs a decision: `"skip"` (advance past the record) or `"halt"` (stop consuming). The `onConsumeError` callback makes this decision.

- `onConsumeError.callback` — receives `{ signal: AbortSignal }` (fires on consumer shutdown) and an event. Returns `"skip"` or `"halt"`.
  - `event.type === "attemptsExhausted"`: record processing failed after all retry attempts. `event.attempts: AttemptAccessor` provides the error history for informed decisions.
  - `event.type === "offsetExpired"` (only when `neverExpire` is not `true`): the consumer's offset points to records that have been purged by retention. The consumer must skip ahead.
- `onConsumeError.retryPolicy` — runtime-level retry policy (milliseconds, infinite) for when the callback throws. `intervalMs`, `backoffRate`, `maxIntervalMs`. If the callback keeps failing, the consumer halts (safe default — don't silently skip messages).

**Defaults when `onConsumeError` is omitted:**

| Event type         | Default behavior |
| ------------------ | ---------------- |
| `attemptsExhausted` | `"halt"`         |
| `offsetExpired`     | `"skip"`         |

`"halt"` for exhausted attempts is the safe default — it prevents silently dropping messages that may need attention. `"skip"` for expired offsets is the only viable option — the records are gone.

**If `onConsumeError.callback` exhausts its own retries** (keeps throwing), the consumer halts. This prevents an infinite loop where the decision callback itself is broken.

Consumer identity is enforced via session-level Postgres advisory locks. One active instance per named consumer per topic at a time.

### Batch topic consumer

For bulk processing use cases (warehouse sync, analytics ingestion, batch API calls), a batch consumer processes multiple records per handler invocation. The entire batch is the unit of work — all records succeed or all are retried.

```typescript
const unregister = client.registerBatchTopicConsumer(
  auditTopic,
  "warehouseSync",
  async ({ signal }, records) => {
    // records: readonly TopicRecord<TPayload, TMetadata>[] — guaranteed non-empty
    await bulkInsertToWarehouse(records, { signal });
  },
  {
    batch: {
      maxRecords: 500,          // required — upper bound per handler invocation (SQL LIMIT)
      intervalSeconds: 10,      // required — polling frequency
      minRecords: 50,           // optional — skip tick if fewer available; default 1
      flushAfterSeconds: 60,    // optional — force-invoke below minRecords after this duration
    },
    neverExpire: true,
    filter: (q) => q.meta.tenantId.eq("acme"),
    retryPolicy: {
      timeoutSeconds: 120,
      maxAttempts: 3,
      intervalSeconds: 30,
      backoffRate: 2,
      maxIntervalSeconds: 300,
    },
    registration: { /* same as single-record consumer */ },
    onConsumeError: {
      callback: async ({ signal }, event) => {
        if (event.type === "attemptsExhausted") return "skip"; // skip entire batch
        // if (event.type === "offsetExpired") return "skip";  // is not an option, since neverExpire: true
        return "halt";
      },
      retryPolicy: { intervalMs: 5000, backoffRate: 2, maxIntervalMs: 60_000 },
    },
  },
);
```

**`TopicRecord` type:**

```typescript
interface TopicRecord<TPayload, TMetadata> {
  readonly id: string;
  readonly payload: TPayload;   // InferOutput<TPayloadSchema>
  readonly metadata: TMetadata; // InferOutput<TMetadataSchema>
}
```

Both the single-record consumer and the batch consumer receive records of this shape. The single-record handler gets one `TopicRecord`; the batch handler gets `readonly TopicRecord[]`.

**Batch options:**

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `maxRecords` | yes | — | Upper bound on batch size. Maps to SQL `LIMIT`. Controls memory and handler timeout budget. |
| `intervalSeconds` | yes | — | Polling frequency. Every N seconds, query for available records. |
| `minRecords` | no | `1` | Minimum records to trigger the handler. If fewer are available, skip this tick. |
| `flushAfterSeconds` | no | `undefined` | Force-invoke even below `minRecords` if this duration has elapsed since the last successful handler invocation. Prevents indefinite stalling on low-throughput topics with a `minRecords` threshold. |

**Polling loop:**

1. Every `intervalSeconds`, query up to `maxRecords` from `topic_records WHERE id > last_id` (with filter if set).
2. If result count >= `minRecords`, invoke the handler.
3. If result count < `minRecords` and `flushAfterSeconds` is set and `now - last_invoked_at >= flushAfterSeconds`, invoke the handler anyway.
4. If result count < `minRecords` and no flush condition, skip this tick.
5. On handler success, advance `last_id` to the highest record ID in the batch.
6. On handler failure, record the attempt (with `from_record_id` and `to_record_id`) and schedule retry per `retryPolicy`.

**Retry semantics:**

The entire batch is the unit of retry. If the handler throws, the attempt row records `from_record_id` and `to_record_id` to identify the chunk. The offset does not advance. On retry, the same batch is re-fetched (same ID range). After exhaustion, `onConsumeError` decides for the batch as a whole — `"skip"` advances past `to_record_id`, `"halt"` stops the consumer.

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
  from_record_id  BIGINT NOT NULL REFERENCES topic_records(id) ON DELETE CASCADE,
  to_record_id    BIGINT NOT NULL REFERENCES topic_records(id) ON DELETE CASCADE,
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

**Introduce `Failure` (base) and `Attempt extends Failure` (with `attempt: number`).** The previous single `StepExecutionError` type leaked the step origin into a type shared across all attempt-bearing contexts and conflated *captured throws with no retry context* (what a mode-`"any"` branch surfaces — a single throw, no attempt number) with *captured throws inside a retried operation* (what a step / queue handler / request handler / topic consumer surfaces — one record per attempt with a 1-indexed number). Splitting into `Failure` (the base) and `Attempt extends Failure` (the retried-operation extension) makes both contexts type-correct without losing field reuse.

**Introduce `AttemptError` class:** a throwable `Error` subclass that handlers can use to attach structured, JSON-serializable details to failures. When the engine catches an `AttemptError`, it persists `type`, `message`, and `details` directly. When it catches a plain `Error`, it extracts `message` and `constructor.name`. When it catches any other thrown value, it best-efforts `String(thrown)` for the message. This means all error fields on `Failure` (and therefore `Attempt`) are nullable — JavaScript's `throw` can throw anything, including values with no message, no type, and no details.

**Unify attempt record shape:** all attempt-bearing subsystems (steps, queue handlers, topic consumers, request handlers) share the same DB column pattern: `attempt`, `error_message`, `error_type`, `error_details`, `started_at`, `failed_at`. Error columns are nullable (a thrown `undefined` or an abruptly terminated attempt has no error info). The public type reflects this with `startedAt` and `failedAt` (both `Date`), replacing the old single `timestamp` field. This captures duration — useful for diagnosing slow failures vs immediate crashes.

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

### Engine extraction rules

The same rules apply to producing both `Failure` records (for any throw captured by a mode-`"any"` branch — see Part 4) and `Attempt` records (for steps, queue handlers, request handlers, topic consumers — one row per attempt). The only difference between the two contexts is that `Attempt` adds the `attempt: number` (1-indexed) on top of the `Failure` shape.

| Thrown value | `type` | `message` | `details` |
| --- | --- | --- | --- |
| `AttemptError` instance | `.type` | `.message` | `.details` |
| `ExplicitError` instance (escaped from inside a mode-`"any"` branch — usually shouldn't happen because terminal errors escape, but if a `branchErrors` is thrown into mode-`"any"` capture) | `"ExplicitError"` (or `null` for non-`AttemptError` `Error` subclasses, depending on serializer) | `.message` | `{ errorCode, details }` |
| `Error` instance | `.constructor.name` | `.message` | `null` |
| `string` | `null` | the string | `null` |
| anything else | `null` | `String(thrown)` | `null` |

### `Failure` (base record — captured single throw)

A plain data record representing a single captured throw. Used by mode-`"any"` branches at consumption points (`match`, `join`, `.all`/`.first`/`.atLeast` `err.details.failed[K]` slots).

```typescript
interface Failure {
  /** When the operation started */
  readonly startedAt: Date;
  /** When the operation was recorded as failed */
  readonly failedAt: Date;
  /** Error message (null if unknown) */
  readonly message: string | null;
  /** Error classifier / class name (null if unknown) */
  readonly type: string | null;
  /** Structured details (undefined if not provided) */
  readonly details: JsonInput | undefined;
}
```

### `Attempt` (retried-operation record)

A `Failure` augmented with the 1-indexed attempt number. Used by `AttemptAccessor` for steps / queue / request / topic handlers.

```typescript
interface Attempt extends Failure {
  /** 1-indexed attempt number */
  readonly attempt: number;
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

## Part 15b: Handler Early Termination

### `MANUAL` return from request handlers

Request handlers can return the `MANUAL` sentinel directly (in addition to `onExhausted` returning it). This enables the "check-or-wait" pattern: the handler checks an external system, resolves the request if the condition is met, or returns `MANUAL` to transition to manual mode immediately — without exhausting retry attempts.

- **Return `TResponse`** → request resolved. Workflow unblocks.
- **Return `MANUAL`** → stop retrying, transition to `status = 'manual'`. Wait for external resolution via `client.requests.<name>.resolve()`.
- **Throw** → transient failure, retry per `retryPolicy`.

Handler return type: `TResponse | typeof MANUAL`.

### `UnrecoverableError` for queue and topic handlers

A throwable `Error` subclass that signals the engine to skip retries and proceed directly to the exhaustion path. Used when the handler determines that retrying will not produce a different outcome — the input itself is the problem, not the handler or its dependencies.

```typescript
class UnrecoverableError extends Error {
  constructor(message?: string);
}
```

**Queue handlers:** throwing `UnrecoverableError` dead-letters the message immediately, bypassing remaining retry attempts. The attempt is recorded normally in `queue_message_attempt`.

**Topic consumers (single-record and batch):** throwing `UnrecoverableError` triggers `onConsumeError` with `event.type === "attemptsExhausted"` immediately, bypassing remaining retry attempts. The attempt is recorded normally in `topic_consumer_attempt`. The `onConsumeError` callback then decides: `"skip"` or `"halt"`.

```typescript
// Queue handler — dead-letter a malformed message immediately
client.registerQueueHandler(notificationsQueue, async ({ signal }, message) => {
  if (!isValidPayload(message)) {
    throw new UnrecoverableError("Malformed payload, retrying will not help");
  }
  await sendEmail(message.userId, message.body, { signal });
}, { retryPolicy: { ... } });

// Topic consumer — skip an unprocessable record immediately
client.registerTopicConsumer(auditTopic, "analyticsConsumer", async ({ signal }, record) => {
  if (!isSupportedEventType(record.payload.type)) {
    throw new UnrecoverableError(`Unsupported event type: ${record.payload.type}`);
  }
  await ingestToWarehouse(record, { signal });
}, { retryPolicy: { ... } });
```

**Distinction from regular exceptions:**

| Thrown value | Queue behavior | Topic behavior |
| --- | --- | --- |
| Regular `Error` | Retry per `retryPolicy` | Retry per `retryPolicy` |
| `UnrecoverableError` | Dead-letter immediately | `onConsumeError("attemptsExhausted")` immediately |
| `AttemptError` | Retry per `retryPolicy` (structured details persisted) | Retry per `retryPolicy` (structured details persisted) |

`UnrecoverableError` is NOT applicable to request handlers — use `return MANUAL` instead. Requests have a fundamentally different exhaustion semantic (manual mode vs dead-letter).

---

## Part 16: Scheduled Delivery

### `ScheduledDeliveryOptions` type

```typescript
export type ScheduledDeliveryOptions =
  | { delaySeconds: number; scheduledAt?: never }
  | { scheduledAt: Date; delaySeconds?: never }
  | { delaySeconds?: undefined; scheduledAt?: undefined };
```

### Queue messages

Described in Part 10. `enqueue` opts accept `delay: number` (seconds) or `scheduledAt: Date`.

### Workflow starts

`ScheduledDeliveryOptions` is intersected into `StartWorkflowOptions` and `ChildWorkflowStartOptions`. `CompensationChildWorkflowStartOptions` intentionally does NOT receive `ScheduledDeliveryOptions`.

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
    ? { args: TArgs; idempotencyKey?: string } & ScheduledDeliveryOptions
    : { args: TArgs; idempotencyKey: string } & ScheduledDeliveryOptions;
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

- **Call sites** (write side) accept `InferInput`: `ctx.steps.X(args)`, `ctx.childWorkflows.X.start({ args })`, `ctx.terminalErrors.X(message, details)`, `ctx.branchErrors.X(message, details)`, `channel.send(data)`, `stream.write(data)`. The developer provides the serializable form.
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
  terminalErrors:        { [name: string]: JsonSchemaConstraint | true },
  compensation: {
    terminalErrors:      { [name: string]: JsonSchemaConstraint | true },  // optional
  },
  idempotencyKeyFactory: (args: InferOutput<TArgs>) => string,  // optional
});
```

Per-branch `errors:` declarations are *not* set here — they are declared inline on the branch (or scope-body) object form (see Part 4).

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
| `ctx.requests.X(payload)`               | Tier 1, both contexts (no `.compensate()` distinction in compensation context — same builder shape). Timeout via builder; `.timeout(boundary, cb)` callback mandatory. |
| `ctx.topics.X.publish(payload, opts?)`  | Sync buffered, both contexts                                                             |
| `ctx.attributes.X.set(value)`           | Sync buffered, both contexts                                                             |
| `ctx.terminalErrors.X(message, details?)` | Factory functions for declared workflow-level terminal errors. Always available. Throw escapes everything. |
| `ctx.branchErrors.X(message, details?)` | Factory functions scoped to the *current branch*'s declared `errors:` map. Empty record outside an `"explicit"`-mode branch. Throw is captured at parent consumption point. |
| `ctx.registerCompensation(name, cb)`    | Sync buffered, `WorkflowContext` only. Registers deferred LIFO compensation.             |
| `ctx.compensateEagerly(name, cb)`       | Sync buffered, `WorkflowContext` only. Dispatches eager FIFO compensation.               |
| `ctx.match(sel)`                        | Single overload. Returns `AsyncIterable<{ key, val }>`. `val` shape per source mode (Part 7). No handler form. |
| `ctx.join(handle)`                      | Returns the typed `val` shape directly (no `{ key, val }` wrapper). For mode-`"any"`/`"explicit"` branches, returns `{ ok, res } \| { ok, err }`; for mode-`"none"`, bare `T`. |
| `ctx.select(handles)`                   | Unchanged. Returns the key of the first selectable to complete.                          |
| `ctx.best(name, entries)`               | Returns `Array<{ key, value }>` (best-effort). No failure case.                          |
| `ctx.atMost(name, n, entries)`          | Returns `Array<{ key, value }>` (length ≤ `n`). No failure case.                         |
| `ctx.atLeast(name, n, entries)`         | Returns `{ ok, res } \| { ok, err: { errorCode: "QuorumNotMet"; ... } }`.                |
| `ctx.first(name, entries)`              | Returns `{ ok, res: { key, value } } \| { ok, err: { errorCode: "NoBranchCompleted"; ... } }`. |
| `ctx.all(name, entries)`                | Returns `{ ok, res: Record<K, ...> } \| { ok, err: { errorCode: "SomeBranchesFailed"; ... } }`. |
| `ctx.scope(name, entries, body)`        | Body accepts the same shorthand/object forms as branches. Mode `"none"` default; outer `.resolve()` returns bare `T` in mode `"none"`, wrapped `{ ok, res } \| { ok, err }` in mode `"any"`/`"explicit"`. |

### `StepCall` changes

| Change                                            | Details                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `.failure()` not present                          | Steps don't fail; they succeed or hit a `.timeout` boundary.                      |
| `.timeout(boundary, cb)` callback mandatory       | No-callback form removed. `boundary` accepts `number`, `Date`, or `StepBoundary`. Callback receives `(ctx, info)` so it can invoke durable primitives. |
| `TFail` type parameter removed                    | Replaced by `TTimeout`.                                                           |
| `TArgs` type parameter added                      | Threads serializable args type through to compensation callbacks and `TimeoutInfo`. |
| `.compensate()` accepts optional name             | `.compensate("name", cb)` for explicit identity.                                  |
| `Called` type parameter ordered                   | Chain order `(.retry)? → (.timeout)? → (.compensate)? → (.complete)? → .resolve`. After `.compensate`, `.retry`/`.timeout` resolve to `never`. |

### `WorkflowCall` changes

| Change                                | Details                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `.failure(cb)` type-mandatory         | `.compensate` and `.resolve` require `"failure" extends Called`. Callback receives `(ctx, info: ChildWorkflowFailureInfo<TArgs, TChildTerminalErrors>)`, fully typed against the child's declared `terminalErrors`. |
| `.timeout(boundary, cb)` callback mandatory | Same shape as on `StepCall`. Callback receives `(ctx, info: TimeoutInfo<TArgs>)`. |
| `TArgs` and `TChildTerminalErrors` type parameters added | Threads parent-side child args + child's terminal-error map into callbacks. |
| `.compensate()` accepts optional name | `.compensate("name", cb)` for explicit identity.                                  |
| `Called` type parameter ordered       | Chain order `(.retry)? → (.timeout)? → .failure → (.compensate)? → (.complete)? → .resolve`. After `.compensate`, `.retry`/`.timeout`/`.failure` resolve to `never`. |

### `RequestCall` changes

| Change                                | Details                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| No `.failure(cb)`                     | Requests don't have a failure concept distinct from timeout.                      |
| `.timeout(boundary, cb)` callback mandatory | Same shape as on `StepCall`. Callback receives `(ctx, info: TimeoutInfo<TPayload>)`. |
| `.priority(n)`                        | Optional. Lower number = higher urgency. Default `0`.                             |
| `Called` type parameter ordered       | Chain order `(.priority)? → (.timeout)? → (.compensate)? → (.complete)? → .resolve`. |

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
- `RequestCompensationResult`, `RequestResolveResult`, `RequestCancelResult`, `RequestListItem`, `RequestListResult`, `AttemptAccessor`, `Failure`, `Attempt`, `AttemptError`
- `ExplicitError`, `ErrorValue`, `FailureInfo`, `CompensationFailureInfo`
- `TimeoutInfo`, `StepFailureInfo`, `ChildWorkflowFailureInfo`
- `StepBoundary`, `MAIN_BRANCH`, `BranchPathItem`, `MANUAL`, `UnrecoverableError`
- `Unsubscribe`
- `TopicRecord`
- `RegisterTopicConsumerError`, `RegisterTopicConsumerErrorEvent`, `TopicConsumerAlreadyActiveError`, `TopicConsumerConsumeErrorEvent`
- `ScheduledDeliveryOptions`
- `IWorkflowConnection`, `IWorkflowTransaction`
- `RetentionSetter`

### Removed exports

- `WorkflowError` (the user-throwable base error class). Replaced by `ExplicitError` (the single throwable for declared errors) and `ErrorValue<T>` / `FailureInfo<TTerminalErrors>` (external value types).
- `StepTimeoutError` (the user-throwable timeout error class). Engine-level step timeouts no longer surface as throwable error classes — the developer handles them at the call site via `.timeout(cb)`, or the workflow halts.
- The handler-form overload of `ctx.match` (handlers map). Only the `AsyncIterable<{ key, val }>` form remains.

### Breaking changes

#### Error model

- Two-tier error model introduced: `terminalErrors` (workflow-wide, escape all scopes, surface externally as `FailureInfo`) and per-branch `branchErrors` (caught at the parent consumption point). Per-branch `branchErrors` are declared inline on the branch (or scope-body) `errors:` field with three modes: `"none"` (default — no captures, throws halt), `"any"` (capture any throw as `Failure`), or an explicit `{ Name: schema | true }` map (typed branch errors only).
- `WorkflowError` (the user-throwable base error class) removed in favor of `ExplicitError` — the single throwable class for declared errors. `StepTimeoutError` likewise removed (engine-level step timeouts are now consumed by `.timeout(cb)` or they halt).
- Workflow-level `terminalErrors` are declared on `defineWorkflow.terminalErrors` (and `defineWorkflow.compensation.terminalErrors`). They are accessed via two namespaces on `ctx`:
    - `ctx.terminalErrors.X(...)` — always available; throw escapes all scopes and surfaces externally as `FailureInfo`.
    - `ctx.branchErrors.X(...)` — empty record outside an `"explicit"`-mode branch; throw is captured at the parent consumption point (`match` / `join` / convenience method) as `{ ok: false, err: ErrorValue<...> }`.
- The external failure surface is now `FailureInfo<TTerminalErrors> = ErrorValue<TTerminalErrors>` — only declared terminal errors. Engine-level events (step timeouts, request timeouts, child workflow failures) never appear externally; they are handled at the call site or they halt.
- Per-context throw rules: in any "execute" body or `"none"`-mode branch, only `ctx.terminalErrors.X(...)` fails (escapes); any other throw halts. In `"any"`-mode branches, every throw is captured as a `Failure`. In `"explicit"`-mode branches, only `ctx.branchErrors.X(...)` is captured; any other throw halts.

#### Builder chains

- All builder chains (`StepCall`, `WorkflowCall`, `RequestCall`) enforce strict ordering via the `Called` type parameter:
    - `StepCall`: `(.retry)? → (.timeout)? → (.compensate)? → (.complete)? → .resolve`
    - `WorkflowCall`: `(.retry)? → (.timeout)? → .failure → (.compensate)? → (.complete)? → .resolve` (`.failure` is type-mandatory)
    - `RequestCall`: `(.priority)? → (.timeout)? → (.compensate)? → (.complete)? → .resolve`
- `.compensate()` locks the chain — subsequent `.retry`/`.timeout`/`.failure` resolve to `never`. This stabilizes the result type passed to compensation callbacks.
- `.timeout(boundary, cb)` callback is now mandatory on `StepCall`, `WorkflowCall`, `RequestCall`. The no-callback overload is removed. Without `.timeout()`, the operation has no engine-imposed deadline (only its retry policy applies).
- `.failure(cb)` is mandatory (type-level) on `WorkflowCall`. `.compensate` and `.resolve` require `"failure" extends Called`.
- `StepCall.failure()` not present. Steps don't fail; they succeed or hit a `.timeout` boundary.
- `RequestCall` has no `.failure(cb)`.
- `.timeout(cb)` and `.failure(cb)` callbacks now receive `(ctx, info)` — they may invoke durable primitives.
    - `TimeoutInfo<TArgs>` — args, attempts accessor, deadline.
    - `StepFailureInfo<TArgs>` — internal use only (not on `StepCall`).
    - `ChildWorkflowFailureInfo<TArgs, TChildTerminalErrors>` — args, child workflow id, fully typed `error: ErrorValue<TChildTerminalErrors>`.

#### Structured concurrency

- `ctx.match(sel)` is a single overload returning `AsyncIterable<{ key, val }>`. The handler-map form is removed. `val` shape is determined by the source: branches → `T` (mode `"none"`) or `{ ok, res } | { ok, err }` (mode `"any"`/`"explicit"`); channels → `{ msg }`; sleep → `{ deadline }`.
- `ctx.join(handle)` returns the typed `val` directly (bare `T` for `"none"`, the wrapped variant for `"any"`/`"explicit"`). There is no separate "safe" form — branch mode controls whether `join` returns a switchable value or rethrows.
- `ctx.scope(name, entries, body)` — body accepts the same shorthand/object forms as branches with the same `errors:` modes. Outer `.resolve()` returns bare `T` in mode `"none"`, wrapped `{ ok, res } | { ok, err }` otherwise.
- Convenience scope methods updated:
    - `ctx.first(name, entries)` → `{ ok, res: { key, value } } | { ok, err: { errorCode: "NoBranchCompleted"; ... } }`
    - `ctx.all(name, entries)` → `{ ok, res: Record<K, ...> } | { ok, err: { errorCode: "SomeBranchesFailed"; ... } }`
    - `ctx.atLeast(name, n, entries)` → `{ ok, res } | { ok, err: { errorCode: "QuorumNotMet"; ... } }`
    - `ctx.atMost(name, n, entries)` → `Array<{ key, value }>` (no failure case)
    - `ctx.best(name, entries)` → `Array<{ key, value }>` (no failure case)

#### Attempts

- `StepErrorAccessor` renamed to `AttemptAccessor`.
- `Failure` — new base record for a single captured throw (used by `"any"`-mode branches). Fields: `startedAt`, `failedAt`, nullable `message`/`type`/`details`.
- `Attempt extends Failure` — adds `attempt: number` for retried operations (steps, queues, requests, topics).
- `StepExecutionError` removed (replaced by `Attempt`). `timestamp: number` (epoch ms) replaced by `startedAt: Date` and `failedAt: Date`. Error fields are now nullable.
- New `AttemptError` throwable class for structured error reporting from handler code.
- `StepCompensationResult.errors` renamed to `.attempts`. `status: "failed"` renamed to `status: "timed_out"` with `reason: "attempts_exhausted" | "deadline"`.
- `StepCompensationResult` gains `args` field (typed by step's `args` schema). Now generic over `<TArgs, T>`.
- `StepErrorAccessor.count` (sync) → `AttemptAccessor.count()` (async).

#### Naming and signatures

- `addCompensation()` renamed to `registerCompensation(name, cb)` (now named, now sync buffered).
- `ctx.first(entries)` → `ctx.first(name, entries)` (name required).
- `ctx.all(entries)` → `ctx.all(name, entries)` (name required).
- `StepDefinition.schema` renamed to `result`. New `args` field added (required `JsonSchemaConstraint`).
- Step call sites: positional arguments replaced by a single schema-validated object (`ctx.steps.X({ ... })`).
- Step `execute` callback: `({ signal }, ...args: TArgs)` → `({ signal }, args: InferOutput<TArgsSchema>)`.
- All handler registration callbacks (`queue`, `request`, `topic`) now receive `{ signal: AbortSignal }` as the first argument.
- `StepCall` gains `TArgs` type parameter for serializable step arguments. `WorkflowCall` gains `TArgs` and `TChildTerminalErrors`.
- `RequestCall` gains `.priority(value)` builder method. `requests` table gains `priority INT NOT NULL DEFAULT 0` column.
- `client.requests.<name>.resolve()`, `.cancel()`, `.list()` — manual resolution client API for requests.
- Request handler return type is now `TResponse | typeof MANUAL`. Returning `MANUAL` from the handler transitions the request to manual mode immediately without exhausting retries.
- Branch key path representation changed from `(string | Symbol)[]` to `BranchPathItem[]` (`{ scope, branch }` objects with `MAIN_BRANCH` unique symbol).
- `.timeout()` on `StepCall` and `WorkflowCall` now accepts `Date` (deadline) in addition to `number` (seconds).
- `channel.receive()` now accepts `Date` (deadline) in addition to `number` (seconds timeout).
- `idempotencyKey` is now required on all workflow start calls (client, child workflow, detached). Optional if `idempotencyKeyFactory` is defined on the workflow.
- `idempotencyKeyFactory` receives post-validation args (same as `execute`).
- `maxAttempts` removed from step-level `RetryPolicyOptions`.
- Handler retry policies use seconds (`intervalSeconds`, `maxIntervalSeconds`) instead of milliseconds. Runtime-level retry policies remain in milliseconds.
- Topic consumer: `registrationRetry` and `onRegisterError` restructured into `registration: { retryPolicy, onRegistered, onError }`. `onConsumeError` restructured into `onConsumeError: { callback, retryPolicy }` with defined throw/retry behavior.

#### Engine and runtime

- VEL execution strategy: branch interleaving order within a scope is an implementation detail. Workflow logic must not rely on it.
- Buffered operations (`stream.write`, `event.set`, `attribute.set`, `queue.enqueue`, `topic.publish`, `channel.send` (foreign), `registerCompensation`, `compensateEagerly`, `startDetached`) are now synchronous — they return `void` and are not `await`ed. `AtomicResult<void>` is removed for these operations.
- Step records are batched and committed in a single transaction when all branches are blocked. Side-effecting work (step execution, child workflow dispatch, request dispatch) starts only after the batch commit.
- `receiveNowait` and `patch` are awaitable reads — they trigger a buffer flush before reading from committed state.
- `topic_consumer_offsets` table removed — `last_id` merged into `topic_consumers`.
- Request workflow API: `timeout` removed from call options — use `.timeout()` builder instead.
- `registerQueueHandler` and `registerRequestHandler` gain `maxConcurrent` option for consumer concurrency control.
- `registerTopicConsumer` and `registerBatchTopicConsumer` gain `neverExpire` option — prevents retention from purging records not yet consumed. `onConsumeError` event type is narrowed at compile time: `neverExpire: true` excludes `"offsetExpired"`.
- `registerTopicConsumer` gains `filter` option for metadata and payload filtering.
- `registerBatchTopicConsumer` — new batch consumer with `maxRecords`, `intervalSeconds`, `minRecords`, `flushAfterSeconds` options. Entire batch is the unit of retry.
- `TopicRecord<TPayload, TMetadata>` — shared record type for both single-record and batch consumers.
- `topic_consumer_attempt.record_id` replaced by `from_record_id` and `to_record_id` (supports both single-record and batch ranges; single-record: both equal).
- Search query: range comparisons (`gt`/`gte`/`lt`/`lte`) and sorting restricted to homogeneously typed fields (purely `string` or purely `number`). Union types only get equality comparisons.
- `UnrecoverableError` — throwable for queue and topic handlers. Bypasses remaining retry attempts: dead-letters (queues) or triggers `onConsumeError("attemptsExhausted")` (topics) immediately.
- `CompensationFailureInfo` — type for observing compensation failure via `handle.compensation.wait()`. Mirrors `FailureInfo` but draws from `compensation.terminalErrors`.

### Connection and transaction model

Two opaque types:

```typescript
type IWorkflowConnection;
type IWorkflowTransaction;
```

Client and engine-level CRUD APIs accept optional `txOrConn?: IWorkflowTransaction | IWorkflowConnection`. Workflow logic (`ctx.*`) is entirely exempt — it runs inside the engine's own durable execution transaction. Blocking operations and subscriptions are also exempt.
