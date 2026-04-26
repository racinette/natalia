# New Primitives — Refactored Implementation Plan

> **This document is the semantic merge of `BUFFER.MD` into `NEW_PRIMITIVES.MD`.** It keeps the stable primitive work from `NEW_PRIMITIVES.MD` and replaces the superseded closure, compensation, error, and builder-chain designs with the newer isolation-first public API.

## Overview

This document describes primitives, architectural changes, and corrections to the public API of the durable workflow engine. It is written as a task description for an implementing agent.

The changes are organized into two categories:

**New primitives** — additions to the engine's capability:

1. **Queues** — global competing-consumer work queues
2. **Requests** — global typed request-response with external handler or manual resolution
3. **Topics** — global ordered per-topic append logs with named consumers
4. **Attributes** — workflow-instance-bound observable single current value
5. **Streams extension** — non-blocking read variant on the external handle
6. **Search query refactoring** — generalize `WorkflowSearchQueryBuilder` into `SearchQuery<TNamespaces>`
7. **Scheduled delivery** — `delay`/`scheduledAt` option on queue message enqueue and workflow starts

**Architectural changes** — corrections and redesigns to existing engine behavior:

1. **Virtual Event Loop (VEL)** — deterministic concurrent execution model
2. **Compensation model redesign** — compensation belongs to the operation it undoes; each step-compensation invocation becomes an isolated, queryable compensation block instance
3. **Halt model** — execution halts remain patch-and-replay only; compensation block halts and branch halts can be skipped per instance
4. **Error model** — schema-declared business and branch failures via a single local `errors` field at each definition level, exposed as `ctx.errors`
5. **Call-time options** — builder chains disappear; operation calls accept options and return discriminated union outcomes where needed
6. **AttemptAccessor refactoring** — rename `StepErrorAccessor` → `AttemptAccessor`, introduce `Failure` base record + `Attempt extends Failure` for retried operations, introduce `AttemptError` throwable class, unify attempt record shape, make `count()` async
7. **Context isolation** — isolated units of work receive only their declared args, dependencies, primitives, and local `errors`
8. **Predefined branches and structured-concurrency consumption** — branches move from inline closures to definition-scoped entries with serializable args and queryable instances
9. **Database schema** — workflow execution tree plus queryable branch invocations, compensation block instance trees, and parallel primitive tables
10. `**idempotencyKeyFactory`\*\* — derive idempotency keys from workflow args, make `idempotencyKey` required
11. **Serializable step arguments** — `args` schema on `defineStep`, single object arg pattern, full observability

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

### Why isolation drives the redesign

The current compensation model defers callbacks to the LIFO unwind that happens during workflow failure or termination. A successfully completing workflow never triggers compensation.

This is incorrect for one important class of case: a step or request that reached an external side-effect boundary, but whose completion was never observed by the engine. Consider a POST endpoint that records a reservation, then fails to serialize the response. The workflow sees a timeout and continues, but the external reservation may exist. If compensation only runs on workflow failure, the side effect is never cleaned up.

The deeper issue is syntactic isolation. Inline compensation closures and inline branch closures can read and mutate variables from their parent lexical scope, even though the engine treats them as independent units of work. The public API now makes that isolation visible:

- Compensation is declared on the step or request definition it undoes.
- Each step compensation invocation becomes a durable compensation block instance with its own primitive state.
- Branches are predefined on `defineWorkflow.branches` or `defineStep.compensation.branches` and receive serializable args.
- Every level has a single local `errors` declaration and a single local `ctx.errors` namespace.
- Operation configuration moves into call-time options; outcomes are handled as returned values in ordinary sequential code.

### Why the execution model needs formalization

Concurrent execution within a workflow requires a deterministic scheduling model to guarantee replayability. The Virtual Event Loop (VEL) formalizes how branches are ordered, when context switches occur, and how promise resolution is sequenced. Without this formalization, concurrent compensation, scope exit behavior, and the interaction between execution and compensation phases cannot be specified precisely.

---

## Part 1: Virtual Event Loop (VEL)

The Virtual Event Loop is the core mechanism for deterministic, replayable concurrent execution within a workflow instance.

### Database representation

The execution tree is built from four primitives:

- `**branch`\*\* — a sequential execution path. Root branches have no parent scope (`scope_id IS NULL`) and serve as VEL entry points.
- `**scope**` — a structured concurrency boundary. Created by an `execute_scope` step.
- `**step**` — an engine-level operation within a branch. The replayable durable execution action.
- `**promise**` — a resolution token for blocking steps. Until resolved (successfully or with failure), the step does not complete.

A scope has branches. A branch has sequential steps. A step may have a promise. Multiple branches may reference the same promise (via `await_promise` steps), enabling shared-result semantics where different branches block on the same underlying resolution.

A workflow has one execution tree. Step compensation does not share that tree as a polymorphic phase; each compensation invocation materializes a separate compensation block instance with its own tree and per-instance primitive state.

### Execution algorithm

The VEL executes all branches within a scope until every branch is blocked, then **batches** all accumulated step records into a single transaction before dispatching any side-effecting work. The order in which concurrent branches are interleaved within a batch round is an implementation detail — workflow logic must never rely on it.

1. **Non-concurrent code** executes as-is. Sequential operations within a single branch need no scheduling.
2. **Creating an entry** through `ctx.steps.X(args, opts?)`, `ctx.requests.X(payload, opts?)`, `ctx.childWorkflows.X(startOpts, opts?)`, or `ctx.branches.X(args)` creates a typed, unstarted entry. It does not by itself start independent work.
3. **Direct `await`** starts and observes an entry immediately in the current branch.
4. **Entering a scope** starts the provided entries under structured-concurrency ownership. The scope body is treated as a parent-context orchestration body with a synthetic key (`MAIN_BRANCH`). Concurrent branches are the named entries passed to the scope.
5. **Branch identity** is encoded as a `readonly BranchPathItem[]` key path representing the full nested scope lineage. Each item is `{ scope: string; branch: string | typeof MAIN_BRANCH }`, where `MAIN_BRANCH` is a module-level `unique symbol` export. For a scope `"A"` with branches `"foo"` and `"bar"`:

```typescript
declare const MAIN_BRANCH: unique symbol;

[{ scope: "A", branch: MAIN_BRANCH }][{ scope: "A", branch: "bar" }][ // ← scope body
  { scope: "A", branch: "foo" }
];
```

6. **Branch execution.** Each branch executes until it reaches a blocking point (Tier 1 entry observation or Tier 2 await). The order in which the engine interleaves concurrent branches is an **implementation detail** and must not be relied upon. The only guarantee is that the interleaving is deterministic across replays — the same code produces the same step ordinals within each branch.
7. **Buffered operations** are synchronous calls that do not trigger context switches. They buffer step records in memory without writing to the database. Stream writes, event sets, attribute sets, queue enqueues, topic publishes, foreign channel sends, compensation instance registration/promotion, and detached workflow starts execute inline within the current branch and do not yield.
8. **Tier 2 operations** (`channel.receive`, `sleep`) block on external resolution. The engine buffers a step and promise record, then context-switches to the next branch.
9. **Tier 1 operations** (steps, child workflows, requests) internally still require two-phase execution:

- **Start phase**: buffer a `start_step` / `start_child_workflow` / `send_request` step record and a promise. Context-switch. The actual work is NOT started yet.
- **Await phase**: buffer an `await_promise` step referencing the created promise. Context-switch.
  The public API no longer exposes this as `.resolve(ctx)`. The awaited entry is the terminal surface.

10. **Awaitable reads** (`channel.receiveNowait`, `patch`) require database state to make a decision. These trigger a **flush**: the accumulated buffer is committed in a batch transaction, then the read is executed against the committed state. The branch continues with the result.
11. **Batch commit.** When all branches are blocked, the engine commits the entire accumulated buffer of step records in a **single transaction**. Only after the commit does the engine start the actual side-effecting work: step coroutines, child workflow dispatches, request dispatches. This batching ensures atomicity (the batch fully commits or doesn't) and efficiency (fewer DB round-trips).
12. **Promise resolution fetch.** All branches are blocked and all work has been dispatched. Fetch resolved promises from the database. Each promise records a `sequence_no` on resolution, assigned from a Postgres sequence protected by a per-VEL advisory lock. This ensures deterministic ordering: no two promises from the same VEL can resolve with the same or out-of-order sequence numbers.
13. **Resume.** Take the first resolved promise by sequence number. Resume the branch that was blocked on it. Execute until the next blocking point. Continue with the next resolved promise if available.
14. **Continue.** If no more resolved promises are available, fetch again. The cycle continues until the scope body returns or all branches complete.

### Important: no reliance on branch execution order

**Workflow logic must never depend on the order in which concurrent branches execute within a scope.** Branches in a scope are logically concurrent — they share no mutable state, and the order in which they reach their blocking points does not affect the outcome. Any workflow that behaves differently depending on branch interleaving order is incorrectly designed. The engine guarantees deterministic replay, but the specific interleaving is an implementation detail subject to change.

### Buffered vs awaitable operations

| Category                  | Operations                                                                                                                                                                                   | Behavior                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Buffered**              | `stream.write`, `event.set`, `attribute.set`, `queue.enqueue`, `topic.publish`, `channel.send` (foreign), `register_compensation_instance`, `promote_compensation_instance`, `startDetached` | Synchronous. Buffers step record in memory. No context switch.                                                |
| **Tier 2 await**          | `channel.receive`, `sleep`, `sleepUntil`                                                                                                                                                     | Buffers step + promise. Context-switches. Blocks until resolution.                                            |
| **Tier 1 entry**          | `steps.X(...)`, `childWorkflows.X(...)`, `requests.X(...)`, `branches.X(...)`                                                                                                                | Creates a typed entry. Direct `await` starts and observes it; scopes can start it under structural ownership. |
| **Internal Tier 1 await** | observing a Tier 1 entry                                                                                                                                                                     | Buffers `await_promise`. Context-switches. Public `.resolve(ctx)` is removed.                                 |
| **Awaitable read**        | `channel.receiveNowait`, `patch`                                                                                                                                                             | Triggers buffer flush. Reads from committed state. No context switch.                                         |

### Nested scopes

Nested scopes exist on the same VEL — they do not create separate VELs. When a nested scope is entered, its branches are added to the set of active branches. Each branch is identified by its full key path:

```typescript
await ctx.scope(
  "A",
  {
    foo: ctx.branches.foo({ id: "foo" }),
    bar: ctx.branches.bar({ id: "bar" }),
  },
  async (ctx, { foo, bar }) => {
    return await ctx.scope(
      "B",
      {
        baz: ctx.branches.baz({ id: "baz" }),
        fuz: ctx.branches.fuz({ id: "fuz" }),
      },
      async (ctx, { baz, fuz }) => {
        return { baz: await ctx.join(baz), fuz: await ctx.join(fuz) };
      },
    );
  },
);
```

When scope `"A"` is entered, three branches exist:

```typescript
[{ scope: "A", branch: MAIN_BRANCH }][{ scope: "A", branch: "bar" }][
  { scope: "A", branch: "foo" }
];
```

When scope `"A"`'s main branch enters scope `"B"`, the branch set expands:

```typescript
[{ scope: "A", branch: MAIN_BRANCH }][ // blocked (entered scope B)
  ({ scope: "A", branch: MAIN_BRANCH }, { scope: "B", branch: MAIN_BRANCH })
][({ scope: "A", branch: MAIN_BRANCH }, { scope: "B", branch: "baz" })][
  ({ scope: "A", branch: MAIN_BRANCH }, { scope: "B", branch: "fuz" })
][{ scope: "A", branch: "bar" }][{ scope: "A", branch: "foo" }];
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
2. **Compensation VEL** — schedules compensation block instances and request-compensation invocations. Rooted at `workflow.compensation_branch_id`.

Both VELs are created at workflow start time. The compensation VEL may remain empty. Each VEL has its own advisory lock namespace for promise resolution sequencing, ensuring complete independence.

### Step types

| Type                             | Category       | Creates promise | Has `promise_id` | Context switch |
| -------------------------------- | -------------- | --------------- | ---------------- | -------------- |
| `start_step`                     | Tier 1 (start) | yes             | no               | yes            |
| `start_child_workflow`           | Tier 1 (start) | yes             | no               | yes            |
| `send_request`                   | Tier 1 (start) | yes             | no               | yes            |
| `start_branch`                   | structural     | yes             | no               | yes            |
| `await_promise`                  | Tier 1 (await) | no              | **yes**          | yes            |
| `execute_scope`                  | structural     | no              | no               | no             |
| `sleep`                          | Tier 2         | yes             | yes              | yes            |
| `sleep_until`                    | Tier 2         | yes             | yes              | yes            |
| `channel_receive`                | Tier 2         | yes             | yes              | yes            |
| `channel_receive_nowait`         | awaitable read | no              | no               | no (flush)     |
| `patch_check`                    | awaitable read | no              | no               | no (flush)     |
| `stream_write`                   | buffered       | no              | no               | no             |
| `event_set`                      | buffered       | no              | no               | no             |
| `attribute_set`                  | buffered       | no              | no               | no             |
| `register_compensation_instance` | buffered       | no              | no               | no             |
| `promote_compensation_instance`  | buffered       | no              | no               | no             |
| `queue_enqueue`                  | buffered       | no              | no               | no             |
| `topic_publish`                  | buffered       | no              | no               | no             |
| `start_detached`                 | buffered       | no              | no               | no             |

Every real await point produces a promise, and the `await_promise` step references it via `promise_id`. The promise already knows its origin (via `promise.step_id` → the `start_`\* step). The await step just says "I'm parked here until this promise resolves." This correctly models multi-branch sharing: two branches awaiting the same step's result both record `await_promise` pointing to the same `promise_id`.

Buffered operations are synchronous calls in the public API — they do not return promises and are not `await`ed. They buffer step records in memory, which are committed in the next batch transaction. Awaitable reads (`receiveNowait`, `patch`) trigger a flush of the buffer before reading from committed state.

Public Tier 1 operation calls return awaitable entries. Direct `await` is the simple path; structured-concurrency primitives can receive the same entries and start them under scope ownership.

---

## Part 2: Compensation Model Redesign

### Problem

The previous compensation model had three deficiencies:

1. **Ghost side effects** — compensation only ran on workflow failure. Caught timeouts left remote side effects uncompensated.
2. **Closure capture** — per-call `.compensate(cb)` closures could read mutable parent-scope values despite running in a separate semantic phase.
3. **Shared compensation state** — workflow-level compensation primitives were shared by every compensation closure that ran.

### Solution: compensation belongs to the operation

A step is either compensable or non-compensable. A request is either compensable or non-compensable. Compensation is no longer attached at the call site.

Removed surfaces:

- `.compensate(cb)` and `.compensate(name, cb)` on call builders.
- `ctx.addCompensation(cb)` as a general-purpose LIFO cleanup registration API.
- `beforeCompensate` / `afterCompensate` hooks.

A single action has a single way to undo itself. Tying undo logic to the operation definition prevents forgotten undo and inconsistent undo across call sites.

### Step compensation definition

```typescript
interface StepDefinition<TArgs, TResult, TComp = undefined> {
  name: string;
  args: TArgs;
  result: TResult;
  execute: (
    ctx: { signal: AbortSignal },
    args: InferOutput<TArgs>,
  ) => Promise<InferInput<TResult>>;
  retryPolicy?: RetryPolicyOptions;
  compensation?: StepCompensation<TArgs, TResult, TComp>;
}

interface StepCompensation<TArgs, TResult, TComp> {
  // Per-instance primitives. Each invocation gets a private set.
  channels?: { [name: string]: JsonSchemaConstraint };
  streams?: { [name: string]: JsonSchemaConstraint };
  events?: { [name: string]: true };
  attributes?: { [name: string]: JsonSchemaConstraint };

  // Declared dependencies. Steps and requests are definition-time filtered
  // to reject compensable definitions and avoid recursive compensation chains.
  steps?: { [name: string]: NonCompensableStepDefinition };
  requests?: { [name: string]: NonCompensableRequestDefinition };
  queues?: { [name: string]: QueueDefinition };
  topics?: { [name: string]: TopicDefinition };
  childWorkflows?: { [name: string]: WorkflowDefinition };
  branches?: { [name: string]: BranchDefinition };

  // Optional compensation outcome schema. Default: void.
  result?: TComp;

  undo: (
    ctx: CompensationContext,
    args: InferOutput<TArgs>,
    info: CompensationInfo<InferOutput<TResult>>,
  ) => Promise<TComp extends undefined ? void : InferInput<TComp>>;
}
```

The signature `undo(ctx, args, info)` separates the original input (`args`) from the engine-level outcome of the forward step (`info`).

### Compensation outcome doctrine

```typescript
type CompensationInfo<TResult> =
  | {
      readonly status: "completed";
      readonly result: TResult;
      readonly attempts: AttemptAccessor;
    }
  | {
      readonly status: "timed_out";
      readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: AttemptAccessor;
    }
  | { readonly status: "terminated"; readonly attempts: AttemptAccessor };
```

`timed_out` and `terminated` do not mean "no work was done." They mean the engine never observed successful completion. If an external POST reached the remote service before the response failed, the remote side effect may exist. Compensation must treat every attempt that reached the I/O boundary as a candidate for success and inspect attempts when needed.

If a step was never attempted at all, its compensation does not run.

### Minimal example

```typescript
const cancelHotelStep = defineStep({
  name: "cancelHotelStep",
  args: z.object({ confirmationId: z.string() }),
  result: z.void(),
  execute: async ({ signal }, args) => {
    await hotelAPI.cancel(args.confirmationId, { signal });
  },
});

const bookHotel = defineStep({
  name: "bookHotel",
  args: z.object({
    firstName: z.string(),
    lastName: z.string(),
    checkIn: z.string(),
    checkOut: z.string(),
  }),
  result: z.object({ confirmationId: z.string() }),
  execute: async ({ signal }, args) => {
    return { confirmationId: await hotelAPI.book(args, { signal }) };
  },

  compensation: {
    steps: { cancelHotelStep },
    undo: async (ctx, args, info) => {
      if (info.status === "completed") {
        await ctx.steps.cancelHotelStep({
          confirmationId: info.result.confirmationId,
        });
      }
    },
  },
});

await ctx.steps.bookHotel({ firstName, lastName, checkIn, checkOut });
```

### Compensation block instances

Compensation is defined on the step, but each invocation produces a distinct durable **compensation block instance**. The instance has:

- status: `pending | running | completed | halted | skipped`;
- its own declared channels, streams, events, and attributes;
- its own branch tree;
- its own result value when a `result` schema is declared;
- its own external query handle.

Two invocations of the same compensable step do not share primitive state. If compensations need to coordinate, they must use global primitives such as queues, topics, requests, or child workflows.

### Query-grounding handle pattern

External callers address compensation block instances through a handle. A handle grounds identity for later queries; it does not eagerly fetch a row.

```typescript
type CompensationBlockStatus =
  | "pending"
  | "running"
  | "completed"
  | "halted"
  | "skipped";

type FindUniqueResult<T> =
  | { readonly status: "unique"; readonly value: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly count: number };

interface CompensationBlockNamespace<TArgs, TResult, TPrim> {
  findUnique(
    query: (
      q: SearchQuery<{ args: TArgs; metadata: BlockMetadata }>,
    ) => SearchQueryNode,
  ): CompensationBlockUniqueHandle<TArgs, TResult, TPrim>;
  findUnique(
    id: CompensationBlockInstanceId,
  ): CompensationBlockUniqueHandle<TArgs, TResult, TPrim>;
  findMany(
    query: (
      q: SearchQuery<{ args: TArgs; metadata: BlockMetadata }>,
    ) => SearchQueryNode,
  ): CompensationBlockSubsetHandle<TArgs, TResult, TPrim>;
}
```

A unique handle exposes per-instance reads and single-instance writes. A subset handle exposes only operations meaningful over many rows:

```typescript
interface CompensationBlockUniqueHandle<TArgs, TResult, TPrim> {
  status(): Promise<FindUniqueResult<CompensationBlockStatus>>;
  result(): Promise<FindUniqueResult<TResult | null>>;
  args(): Promise<FindUniqueResult<TArgs>>;
  skip(
    ...args: TResult extends void ? [] : [result: InferInput<TResult>]
  ): Promise<
    | FindUniqueResult<{ skipped: true }>
    | {
        readonly status: "already_terminal";
        readonly current: "completed" | "skipped";
      }
  >;

  attributes: {
    /* declared attributes wrapped in FindUniqueResult */
  };
  streams: {
    /* declared streams wrapped in FindUniqueResult */
  };
  events: {
    /* declared events wrapped in FindUniqueResult */
  };
  channels: {
    /* declared channels; send targets one instance */
  };
}

interface CompensationBlockSubsetHandle<TArgs, TResult, TPrim> {
  count(): Promise<number>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{
    items: readonly {
      id: CompensationBlockInstanceId;
      status: CompensationBlockStatus;
      args: TArgs;
    }[];
    cursor: string | null;
  }>;
  skip(
    ...args: TResult extends void ? [] : [result: InferInput<TResult>]
  ): Promise<{ affected: number }>;
  channels: {
    /* fan-out send */
  };
}
```

### Failure semantics: return, do not throw

The compensation context has no workflow `ctx.errors`. Compensation reports its outcome through the optional `result` schema on its definition. Early `return` is the explicit short-circuit. Throws are reserved for halts.

Aggregate workflow-level compensation APIs such as `handle.compensation.wait()` and `CompensationFailureInfo` are removed. Per-instance reads through `findUnique(...).result()` and developer-declared events replace them.

### Type-level discrimination

A step with a `compensation` field is compensable. A request with `compensation: true` or `compensation: { result }` is compensable. These are properties on the existing definition types:

```typescript
type IsStepCompensable<S> = S extends { compensation: object } ? true : false;
type IsRequestCompensable<R> = R extends { compensation: true | object }
  ? true
  : false;
```

Compensation dependencies may not themselves be compensable. This prevents compensation from recursively spawning more compensation chains. Child workflows are exempt; each workflow owns its own internal compensation lifecycle.

### Compensation VEL lifecycle

The two-VEL structure remains: one execution VEL and one compensation VEL per workflow. The unit scheduled on the compensation VEL is no longer an anonymous closure; it is a durable compensation block instance.

Step record evolution:

```
ordinal 1: { type: "start_step",                     definition_name: "bookHotel" }
ordinal 2: { type: "register_compensation_instance", definition_name: "bookHotel", instance_id: "cbi_..." }
ordinal 3: { type: "await_promise",                  promise_id: 42 }
-- timeout fires --
ordinal 4: { type: "promote_compensation_instance",  instance_id: "cbi_..." }
```

The compensation VEL processes eager FIFO entries first, then LIFO unwind entries if the workflow fails. Mirror scopes for unconsumed branch work still exist, but each mirror branch maps to a distinct compensation block instance with isolated state.

---

## Part 3: Halt Model

### Problem

Any unexpected exception (anything that the surrounding context's mode does not classify as a declared failure — see the per-context throw rules below) in workflow or compensation code puts the engine in an undefined state. The code between the last durable step and the exception is non-deterministic on replay. Retrying the code block is not safe — it may have already modified in-memory state.

### Execution halts

An execution halt is a soft failure that pauses workflow execution at the point of the unexpected exception. The workflow transitions to `status = 'halted'`. Multiple pending workflow halts can coexist — each represents a point where replay encountered an exception.

```sql
CREATE TABLE workflow_halt (
  id                BIGSERIAL PRIMARY KEY,
  workflow_id       TEXT NOT NULL REFERENCES workflow(id),
  after_step_id     BIGINT REFERENCES step(id),
  status            TEXT NOT NULL DEFAULT 'pending',
  error_type        TEXT,
  error_message     TEXT,
  error_stacktrace  TEXT,
  error_details     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_workflow_halt_status CHECK (status IN ('pending', 'resolved'))
);
```

**Resolution paths:**

1. **Patch + replay**: deploy a code change that fixes the issue. On worker restart, the engine replays the workflow. If the code now proceeds past `after_step_id` without throwing, all pending halts at or before that point are automatically marked `resolved`.
2. **SIGKILL**: abandon the workflow entirely. Immediate termination, no further processing.

There is no skip mechanism for execution halts. Skipping workflow code would leave parent in-memory state inconsistent.

### Compensation halts

A compensation block instance is isolated. If its `undo` callback or one of its branches throws unexpectedly, that block instance transitions to `halted`, but the halt is per instance and can be skipped externally.

```typescript
const halted = workflowInstance.compensations.bookHotel.findUnique((q) =>
  q.args.firstName.eq("Bob"),
);

await halted.skip({
  kind: "operator-resolved",
  action: "confirm-no-booking",
});
```

If the compensation has a `result` schema, `skip()` requires a result value. If the result is `void`, `skip()` takes no argument. Bulk skip is available through `findMany(...).skip(...)`.

### Branch halts

Branches are also isolated invocations with serializable args and results. A halted branch may be skipped through the external branch handle if the operator can supply a valid result. The parent scope observes the skipped result as the branch's result when replay reaches that consumption point.

### Per-context throw rules

Whether a thrown value fails or halts depends on the local definition's error mode. The error model in Part 4 introduces a single local `errors` namespace and three branch modes (`"none"`, `"any"`, `"explicit"`).

| Surrounding context                            | Throw recognized as failure                                                  | Anything else                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| Workflow `execute` body                        | `ctx.errors.X(...)` from `defineWorkflow.errors`                             | execution halt                    |
| Scope body                                     | same `ctx.errors` as the parent body                                         | parent-level halt if unrecognized |
| Branch with `errors` omitted or `"none"`       | no recognized local failures                                                 | branch halt                       |
| Branch with `errors: "any"`                    | any ordinary throw becomes a `Failure` value at the parent consumption point | engine-internal exceptions halt   |
| Branch with explicit `errors` map              | `ctx.errors.X(...)` for the branch's declared keys                           | branch halt                       |
| Step/request timeout or child workflow failure | return-value union from the awaited entry                                    | no throw machinery involved       |
| Compensation `undo`                            | no `ctx.errors`; return typed outcomes                                       | compensation block halt           |

There is no cross-level error access. A branch cannot throw the workflow's declared errors because those factories are not present on its context.

---

## Part 4: Error Model

### Problem

The current public API has no schema-declared business error surface on `defineWorkflow`. Workflow code fails by throwing ordinary JavaScript values or exported error classes such as `WorkflowError` / `StepTimeoutError`; the engine serializes those failures into `WorkflowExecutionError` (`message`, `type`, `timestamp`, optional `details`). That is useful for diagnostics, but it is not a typed contract between workflow author and external caller.

Structured-concurrency failure handling is similarly operational rather than domain-shaped. Scope and convenience-method failure callbacks receive `ScopeFailureInfo`, which is a union of step failures, child workflow failures, and `{ kind: "exception"; error: unknown }`. This gives the workflow a place to react, but the branch's intended business failure vocabulary is not declared where the branch is authored, and external callers cannot distinguish deliberate domain failures from unexpected implementation exceptions by schema.

The refactor separates three concerns:

1. **Workflow business failure** — declared by the workflow and visible to the external caller.
2. **Recoverable branch failure** — declared by a branch and observed at the parent consumption point.
3. **Engine events** — step/request timeouts and child workflow failure; these are returned from operation calls as local values.

### Solution: single local `errors`

Every definition level that can intentionally fail declares a local `errors` map and receives a local `ctx.errors` namespace.

| Level    | Declaration                                                                           | Effect of `ctx.errors.X(...)`                                |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Workflow | `defineWorkflow.errors`                                                               | Fails the workflow. Visible externally as `FailureInfo`.     |
| Branch   | `defineWorkflow.branches.foo.errors` or `defineStep.compensation.branches.foo.errors` | Fails that branch. Captured at the parent consumption point. |

There is no cross-level access. A branch cannot see the workflow's errors. A workflow body cannot see branch errors. If the same error name appears at both levels, they are independent declarations. This is a new typed failure surface; it is not a rename of an existing current API field.

### Workflow error definitions

```typescript
defineWorkflow({
  errors: {
    OrderInvalid: z.object({ orderId: z.string() }),
    InsufficientFunds: z.object({ amount: z.number(), balance: z.number() }),
    Cancelled: true,
  },
  execute: async (ctx, args) => {
    if (!valid) {
      throw ctx.errors.OrderInvalid("Order is invalid", {
        orderId: args.orderId,
      });
    }
  },
});
```

A workflow-level `ctx.errors.X(...)` throw fails the workflow and triggers compensation. External callers see only the workflow's declared error values.

### Branch error definitions

Branches declare their failure mode at definition time:

```typescript
type BranchErrors =
  | "none"
  | "any"
  | { [name: string]: JsonSchemaConstraint | true };
```

| `errors` field      | Mode     | `ctx.errors` inside branch  | Consumption point                                  |
| ------------------- | -------- | --------------------------- | -------------------------------------------------- |
| omitted or `"none"` | none     | empty                       | unexpected throws halt the branch                  |
| `"any"`             | any      | empty                       | any ordinary throw becomes `Failure`               |
| explicit map        | explicit | factories for declared keys | declared throws become `ErrorValue<TBranchErrors>` |

```typescript
branches: {
  hotelBooking: {
    args: z.object({ city: z.string(), guestName: z.string() }),
    result: z.object({ confirmationId: z.string() }),
    errors: {
      Sold: true,
      Unavailable: z.object({ until: z.string() }),
    },
    execute: async (ctx, args) => {
      const result = await ctx.steps.bookHotel({
        city: args.city,
        guestName: args.guestName,
      }, { timeout: 30 });

      if (!result.ok) {
        throw ctx.errors.Unavailable("Timed out", { until: "unknown" });
      }
      if (result.result.status === "sold") {
        throw ctx.errors.Sold("No rooms available");
      }
      return { confirmationId: result.result.confirmationId };
    },
  },
}
```

The workflow decides whether a branch failure should fail the whole workflow by observing the branch result and throwing its own workflow-level error from parent code.

### ExplicitError and ErrorValue

`ExplicitError` is the internal throwable created by `ctx.errors.X(...)`. Users do not subclass it or construct it directly.

```typescript
class ExplicitError extends Error {
  readonly code: string;
  readonly details: unknown;
}

type ErrorValue<TErrors> = {
  [K in keyof TErrors & string]: {
    readonly type: "ExplicitError";
    readonly code: K;
    readonly message: string;
    readonly details: TErrors[K] extends true
      ? undefined
      : StandardSchemaV1.InferOutput<TErrors[K]>;
  };
}[keyof TErrors & string];

type FailureInfo<TWorkflowErrors> = ErrorValue<TWorkflowErrors>;
```

When the engine catches an `ExplicitError`, it resolves it against the current definition level only. Workflow-level throws fail the workflow. Branch-level throws fail the branch. A mismatch halts, which catches stale throws after refactors.

### Failure

When a branch is in mode `"any"`, ordinary throws are captured into a `Failure` record. `Failure` is also the base shape that `Attempt` extends; `Attempt` adds an `attempt` number for retried operations.

```typescript
interface Failure {
  readonly startedAt: Date;
  readonly failedAt: Date;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
}

interface Attempt extends Failure {
  readonly attempt: number;
}
```

### Per-context throw rules

| Context                     | Recognized failure throws                                   | Anything else                   |
| --------------------------- | ----------------------------------------------------------- | ------------------------------- |
| Workflow `execute` body     | `ctx.errors.X(...)` from workflow errors                    | execution halt                  |
| Scope body                  | parent context's `ctx.errors.X(...)`                        | parent-level halt               |
| Branch in mode `"none"`     | none                                                        | branch halt                     |
| Branch in mode `"any"`      | any ordinary throw -> `Failure` at parent consumption point | engine-internal exceptions halt |
| Branch in mode `"explicit"` | `ctx.errors.X(...)` from branch errors                      | branch halt                     |
| Compensation `undo`         | none; typed return values model outcomes                    | compensation block halt         |
| Compensation branch         | same branch modes as execution branches                     | compensation block branch halt  |

### External caller usage

```typescript
const result = await client.workflows.order.execute({ ... });
if (!result.ok && result.status === "failed") {
  switch (result.error.code) {
    case "OrderInvalid":
      result.error.details.orderId;
      break;
    case "InsufficientFunds":
      result.error.details.balance;
      break;
    case "Cancelled":
      result.error.details;
      break;
  }
}
```

There is no outer discriminant for error categories. The external caller discriminates on `code` directly.

### Compensation error model

Compensation `undo` callbacks do not receive `ctx.errors`. They report intended outcomes by returning values through the optional `result` schema declared on the compensation definition. Unexpected throws halt the compensation block instance. Compensation branches may still declare local branch `errors`, and those are consumed inside the compensation block just like execution branches.

`CompensationFailureInfo` and `handle.compensation.wait()` are removed. Operators observe compensation block instances through `workflowInstance.compensations.<step>.findUnique(...).status()`, `.result()`, declared events, and `skip()`.

### Rationale recap

1. **The external failure surface must stay business-level.** Developer-declared workflow errors reach the caller; engine events are local return values.
2. **Error scoping must match isolation.** Branch errors are declared on branch definitions and cannot escape to the workflow unless parent code deliberately converts them.
3. **The throw site should be local.** `ctx.errors.X(...)` always means "throw an error declared by this definition level."

---

## Part 5: Call-Time Options and Timeout Semantics

### Problem

After compensation closures and scope failure callbacks are removed, the builder chain has no remaining reason to exist. `.resolve(ctx)` existed as a type-level proof that a handle was being resolved in the right VEL, but context isolation makes that proof unnecessary. `.retry`, `.timeout`, `.failure`, `.priority`, and `.complete` can be expressed more simply as call-time options and ordinary sequential code.

### Solution

`StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`, `DurableHandle`, and `AtomicResult` are removed. Operation accessors return lightweight awaitable entries with no builder methods.

```typescript
await ctx.steps.bookFlight(args);
await ctx.steps.bookFlight(args, { timeout: 30 });
await ctx.childWorkflows.processOrder(startOpts, { timeout: 120 });
await ctx.requests.humanReview(payload, { priority: 1, timeout: 3600 });
```

Calls are not eager native `Promise`s. They are entries that can be directly awaited or passed to `ctx.scope`, `ctx.all`, `ctx.first`, `ctx.atMost`, `ctx.atLeast`, or `ctx.best` for structured ownership.

### RetryPolicyOptions

`RetryPolicyOptions` is purely retry behavior. Stop conditions live in the `timeout` option.

```typescript
interface RetryPolicyOptions {
  intervalSeconds?: number;
  backoffRate?: number;
  maxIntervalSeconds?: number;
  timeoutSeconds?: number; // per-attempt execution timeout
}
```

### StepBoundary

```typescript
type StepBoundary =
  | number
  | Date
  | { maxAttempts: number; seconds?: number }
  | { seconds: number; maxAttempts?: number }
  | { deadline: Date; maxAttempts?: number };
```

`number` means relative seconds. `Date` means absolute deadline. `maxAttempts` can coexist with wall-clock boundaries.

### Steps

```typescript
// No timeout: retries according to policy until success. Returns T directly.
const booking = await ctx.steps.bookFlight(args);
// booking: FlightBooking

// Timeout: returns a discriminated union.
const maybeBooking = await ctx.steps.bookFlight(args, {
  retry: { intervalSeconds: 5, backoffRate: 1.5 },
  timeout: { maxAttempts: 10 },
});
// maybeBooking:
//   { ok: true; result: FlightBooking }
// | { ok: false; status: "timeout" }
```

No timeout means no workflow-side timeout branch; the operation retries forever unless the workflow is terminated. With timeout, recovery happens in ordinary code:

```typescript
const booking = await ctx.steps.bookFlight(args, { timeout: 30 });
if (!booking.ok) {
  await ctx.queues.ops.enqueue({ type: "flight-timeout", args });
  throw ctx.errors.BookingFailed("Flight booking timed out", {
    reason: "flight",
  });
}
```

When a timed-out step is compensable and had an attempted side effect, the engine promotes the already-registered compensation block instance. The trigger is the operation result `{ ok: false; status: "timeout" }`, not a timeout callback.

### Child workflows

Attached child workflows always return a discriminated union because child failure is structurally possible.

```typescript
const order = await ctx.childWorkflows.processOrder(startOpts);
// order:
//   { ok: true; result: OrderResult }
// | { ok: false; status: "failed"; error: ErrorValue<TChildErrors> }

const timed = await ctx.childWorkflows.processOrder(startOpts, { timeout: 60 });
// timed additionally includes { ok: false; status: "timeout" }
```

Attached children are not independently terminable business objects. If the parent workflow is externally terminated, the attached subtree is torn down as part of the parent lifecycle; the parent does not resume with a child-level `terminated` result. Termination remains visible at root boundaries: root workflow handles and detached child workflow handles.

### Requests

```typescript
const decision = await ctx.requests.humanReview(payload);
// decision: ReviewDecision

const maybeDecision = await ctx.requests.humanReview(payload, {
  priority: 1,
  timeout: 3600,
});
// maybeDecision:
//   { ok: true; result: ReviewDecision }
// | { ok: false; status: "timeout" }
```

Request retry behavior belongs to handler registration. Workflow code controls payload, priority, and observation timeout.

### Awaitable entry type sketches

```typescript
type AwaitableEntry<TAwaited> = PromiseLike<TAwaited> & {
  readonly __nataliaEntry?: unique symbol;
};

interface StepAccessor<TArgs, TResult> {
  (args: InferInput<TArgs>): StepEntry<InferOutput<TResult>>;
  (
    args: InferInput<TArgs>,
    opts: { retry?: RetryPolicyOptions },
  ): StepEntry<InferOutput<TResult>>;
  (
    args: InferInput<TArgs>,
    opts: { retry?: RetryPolicyOptions; timeout: StepBoundary },
  ): StepEntry<
    | { ok: true; result: InferOutput<TResult> }
    | { ok: false; status: "timeout" }
  >;
}

type StepEntry<TAwaited> = AwaitableEntry<TAwaited>;

interface ChildWorkflowAccessor<W extends AnyWorkflowHeader> {
  (
    startOpts: AttachedChildWorkflowStartOptions<W>,
  ): AttachedChildWorkflowEntry<
    | { ok: true; result: InferWorkflowResult<W> }
    | { ok: false; status: "failed"; error: ErrorValue<InferWorkflowErrors<W>> }
  >;
  (
    startOpts: AttachedChildWorkflowStartOptions<W>,
    opts: { retry?: RetryPolicyOptions; timeout: StepBoundary },
  ): AttachedChildWorkflowEntry<
    | { ok: true; result: InferWorkflowResult<W> }
    | { ok: false; status: "failed"; error: ErrorValue<InferWorkflowErrors<W>> }
    | { ok: false; status: "timeout" }
  >;
  startDetached(
    opts: DetachedStartOptions<W>,
  ): PromiseLike<ForeignWorkflowHandle<W>>;
}

interface RequestAccessor<TPayload, TResponse> {
  (payload: InferInput<TPayload>): RequestEntry<InferOutput<TResponse>>;
  (
    payload: InferInput<TPayload>,
    opts: { priority?: number; timeout: StepBoundary },
  ): RequestEntry<
    | { ok: true; result: InferOutput<TResponse> }
    | { ok: false; status: "timeout" }
  >;
}
```

### What disappears

| Surface                                         | Replacement                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `.resolve(ctx)`                                 | direct `await` or structured-concurrency consumption                               |
| `.retry(policy)`                                | `{ retry: policy }` call option                                                    |
| `.timeout(boundary, cb)`                        | `{ timeout: boundary }` call option plus sequential handling of the returned union |
| `.failure(cb)`                                  | child workflow returned union                                                      |
| `.priority(n)`                                  | `{ priority: n }` request option                                                   |
| `.complete(cb)`                                 | destructuring or mapping after `await`                                             |
| `.compensate(cb)`                               | `defineStep.compensation` or `defineRequest.compensation`                          |
| `DurableHandle` / `AtomicResult`                | small opaque awaitable entries                                                     |
| `Called`, `TFail`, `TTimeout` chain bookkeeping | overloads based on options                                                         |

---

## Part 6: Context Isolation

### Principle

Each isolated unit of work gets a context whose syntax reflects what the unit is allowed to see.

- Workflow `execute` sees workflow primitives, workflow branches, workflow steps, and workflow `errors`.
- Branch `execute` sees only the primitives and dependencies declared on that branch definition; its `ctx.errors` comes from that branch definition.
- Compensation `undo` sees only primitives and dependencies declared on the step's `compensation` field; it has no workflow `ctx.errors`.
- Compensation branches see compensation-block primitives/dependencies and their own local branch `ctx.errors`.

### No shared compensation namespace

Compensation block primitive state is declared on the compensable step and materialized per invocation. The current workflow-wide compensation hooks and ad hoc `addCompensation` registration do not survive as public API surfaces.

| Primitive        | Workflow execution              | Step compensation block                    |
| ---------------- | ------------------------------- | ------------------------------------------ |
| `ctx.channels`   | workflow instance channels      | compensation block instance channels       |
| `ctx.streams`    | workflow instance streams       | compensation block instance streams        |
| `ctx.events`     | workflow instance events        | compensation block instance events         |
| `ctx.attributes` | workflow instance attributes    | compensation block instance attributes     |
| `ctx.branches`   | `defineWorkflow.branches`       | `defineStep.compensation.branches`         |
| `ctx.errors`     | workflow or branch-local errors | branch-local errors only; absent in `undo` |

The execution VEL cannot read or write compensation block primitives, and a compensation block cannot read or write workflow primitives unless coordination is exposed through an explicit global primitive such as a request, topic, queue, or child workflow.

### Definition-time dependency filtering

Compensation can depend on non-compensable steps and requests; queues, topics, and child workflows. It cannot depend on compensable steps or compensable requests, preventing recursive compensation chains.

---

## Part 7: Branches, Scopes, and Structured-Concurrency Consumption

All scopes must be named. Branches are no longer inline async closures passed to `ctx.scope`; they are predefined isolated units with serializable args and results.

### Branch definitions

Branches are predefined on `defineWorkflow.branches` and on `defineStep.compensation.branches`. Each branch has `args`, `result`, optional local dependencies such as `steps` and `requests`, optional local `errors`, and `execute`.

```typescript
defineWorkflow({
  name: "tripBooking",
  args: z.object({ destination: z.string(), customerId: z.string() }),
  errors: {
    BookingFailed: z.object({ reason: z.string() }),
  },
  steps: { bookFlight, bookHotel },

  branches: {
    flightBooking: {
      args: z.object({ destination: z.string(), customerId: z.string() }),
      result: z.object({ confirmationId: z.string() }),
      steps: { bookFlight },
      errors: "any",
      execute: async (ctx, args) => {
        const booking = await ctx.steps.bookFlight(
          { destination: args.destination, passengerId: args.customerId },
          { timeout: 30 },
        );
        if (!booking.ok) throw new Error("Flight booking timed out");
        return { confirmationId: booking.result.confirmationId };
      },
    },
  },

  execute: async (ctx, args) => {
    return await ctx.scope(
      "booking",
      {
        flight: ctx.branches.flightBooking({
          destination: args.destination,
          customerId: args.customerId,
        }),
      },
      async (ctx, { flight }) => {
        const flightResult = await ctx.join(flight);
        if (!flightResult.ok) {
          throw ctx.errors.BookingFailed("Booking failed", {
            reason: "flight",
          });
        }
        return flightResult.res;
      },
    );
  },
});
```

### Entry family

Branches, steps, requests, and attached child workflows all produce typed unstarted entries:

```typescript
type BranchEntry<T, TErrors> = /* opaque branch entry */;
type StepEntry<T> = /* opaque step entry */;
type RequestEntry<T> = /* opaque request entry */;
type AttachedChildWorkflowEntry<T, TErrors> = /* opaque child-workflow entry */;

type ConcurrentEntry =
  | BranchEntry<any, any>
  | StepEntry<any>
  | RequestEntry<any>
  | AttachedChildWorkflowEntry<any, any>;
```

Direct `await` starts and observes an entry. A scope starts entries under structural ownership and passes handles to the body.

### Scope input structure

Scope input is an object whose leaves may be entries, arrays/tuples of entries, or maps of entries. The body receives the same structure with leaves replaced by handles.

```typescript
await ctx.scope(
  "parallel-lookups",
  {
    quotes: [
      ctx.steps.quoteHotel({ city: "Paris" }),
      ctx.steps.quoteHotel({ city: "Rome" }),
    ],
    children: new Map([
      ["bar1", ctx.childWorkflows.bar({ args: { n: 1 } })],
      ["bar2", ctx.childWorkflows.bar({ args: { n: 2 } })],
    ]),
    branch: ctx.branches.lookup({ n: 1 }),
  },
  async (ctx, { quotes, children, branch }) => {
    const paris = await ctx.join(quotes[0]);
    const bar1 = children.get("bar1");
    const b = await ctx.join(branch);
    return { paris, bar1: bar1 && (await ctx.join(bar1)), b };
  },
);
```

### Scope body

The scope body remains an inline callback because it is orchestration code in the parent context. It receives a narrowed context with `join`, `match`, and `select`, and its `ctx.errors` is the parent's local `errors`. There is no scope-local error mode and no `ScopeCall.failure(cb)`.

### `ctx.join`

`ctx.join(handle)` observes one leaf handle and returns the handle's typed value. For branches:

- mode `"none"` returns bare `T` or halts if the branch threw unexpectedly;
- mode `"any"` returns `{ ok: true; res: T } | { ok: false; err: Failure }`;
- explicit mode returns `{ ok: true; res: T } | { ok: false; err: ErrorValue<TBranchErrors> }`.

`ctx.join(handle, { timeout })` is an observation timeout. It races this wait only; it does not cancel, terminate, fail, or compensate the underlying work. The same handle can be joined again later.

### `ctx.match`

`ctx.match` streams completions from object, array, and map structures. For arrays, events carry the array index. For maps, events carry the map key. For top-level objects, events carry the top-level object key.

```typescript
for await (const event of ctx.match(handles)) {
  if (event.key === "quotes") {
    event.index;
    event.val;
  }
  if (event.key === "children") {
    event.mapKey;
    event.val;
  }
}
```

**There is no handler-form `match`.**

### Convenience scope methods

`ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, and `ctx.best` accept the same generalized input structure as `ctx.scope`. They return directly awaitable results and have no `.failure(cb)` builder.

`ctx.first` eagerly promotes compensation for entries it leaves unconsumed according to each entry's semantics. `ctx.atMost` and `ctx.best` return whatever completed and do not have failure cases. `ctx.atLeast` and `ctx.all` return discriminated union failures when their quorum/all requirements cannot be met.

### Branch query surface

Every branch invocation is persisted with serializable args and result. Workflow handles expose a query surface parallel to compensation blocks:

```typescript
const branchInfo = await workflowInstance.branches.hotelBooking
  .findUnique((q) => q.args.city.eq("Paris"))
  .status();

await workflowInstance.branches.hotelBooking
  .findUnique((q) => q.args.city.eq("Paris"))
  .skip({ confirmationId: "manual-resolution" });
```

```typescript
type BranchStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "halted"
  | "skipped";
```

---

## Part 8: Database Schema

The storage model is no longer a single unified tree for execution and compensation. A workflow has one execution tree. Each compensation block instance has its own compensation tree and its own primitive tables. Branch invocations and compensation block instances are queryable entities with serialized args, metadata, status, result, and attempts.

### Core workflow tables

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

  CONSTRAINT chk_workflow_status CHECK (
    status IN ('pending', 'running', 'complete', 'failed', 'terminated', 'halted')
  ),
  UNIQUE (definition_name, idempotency_key)
);
```

### Branch, scope, step, promise

```sql
CREATE TABLE branch (
  id               BIGSERIAL PRIMARY KEY,
  workflow_id      TEXT REFERENCES workflow(id),
  scope_id         BIGINT,
  definition_name  TEXT,
  key              TEXT NOT NULL,
  key_path         TEXT[] NOT NULL,
  args             JSONB,
  result           JSONB,
  error            JSONB,
  status           TEXT NOT NULL DEFAULT 'pending',
  consumed         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  halted_at        TIMESTAMPTZ,

  CONSTRAINT chk_branch_status CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'halted', 'skipped')
  )
);

CREATE TABLE scope (
  id              BIGSERIAL PRIMARY KEY,
  parent_step_id  BIGINT NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_scope_status CHECK (status IN ('active', 'complete', 'failed'))
);

CREATE TABLE step (
  id               BIGSERIAL PRIMARY KEY,
  branch_id        BIGINT NOT NULL,
  ordinal          INT NOT NULL,
  type             TEXT NOT NULL,
  definition_name  TEXT,
  args             JSONB,
  promise_id       BIGINT,
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (branch_id, ordinal)
);

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

The precise foreign key cycle between `branch`, `scope`, and `step` is resolved with `ALTER TABLE` constraints after table creation, as in the original design.

### Compensation block instance tables

Compensation block instances are separate durable entities and use parallel tables rather than polymorphic owner columns.

```text
workflow                             compensation_block_instance
workflow_attributes                  compensation_block_attributes
channel_message                      compensation_block_channel_message
stream_record                        compensation_block_stream_record
workflow_event                       compensation_block_event
workflow_halt                        compensation_block_halt
step                                 compensation_block_step
```

```sql
CREATE TABLE compensation_block_instance (
  id                 TEXT PRIMARY KEY,
  workflow_id        TEXT NOT NULL REFERENCES workflow(id),
  step_id            BIGINT NOT NULL REFERENCES step(id),
  definition_name    TEXT NOT NULL,
  args               JSONB NOT NULL,
  info               JSONB,
  result             JSONB,
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  halted_at          TIMESTAMPTZ,
  skipped_at         TIMESTAMPTZ,

  CONSTRAINT chk_compensation_block_status CHECK (
    status IN ('pending', 'running', 'completed', 'halted', 'skipped')
  )
);
```

All compensation block instances share the same physical tables, discriminated by `definition_name` and instance id. Schema enforcement happens at the engine layer using each step's declared compensation primitive schemas.

### Request compensation tables

Request compensation invocations are observable but lightweight. They have no per-instance primitives and no durable branch tree.

```sql
CREATE TABLE request_compensation_instance (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL REFERENCES workflow(id),
  request_id       BIGINT NOT NULL REFERENCES requests(id),
  request_name     TEXT NOT NULL,
  payload          JSONB NOT NULL,
  info             JSONB,
  result           JSONB,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  manual_at        TIMESTAMPTZ,
  skipped_at       TIMESTAMPTZ,

  CONSTRAINT chk_request_comp_status CHECK (
    status IN ('pending', 'running', 'completed', 'manual', 'skipped')
  )
);
```

### Halt tables

Execution halts and compensation block halts have different resolution semantics, so they use distinct tables.

```sql
CREATE TABLE workflow_halt (
  id                BIGSERIAL PRIMARY KEY,
  workflow_id       TEXT NOT NULL REFERENCES workflow(id),
  after_step_id     BIGINT REFERENCES step(id),
  status            TEXT NOT NULL DEFAULT 'pending',
  error_type        TEXT,
  error_message     TEXT,
  error_stacktrace  TEXT,
  error_details     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_workflow_halt_status CHECK (status IN ('pending', 'resolved'))
);

CREATE TABLE compensation_block_halt (
  id                          BIGSERIAL PRIMARY KEY,
  compensation_block_id        TEXT NOT NULL REFERENCES compensation_block_instance(id),
  after_compensation_step_id   BIGINT,
  status                      TEXT NOT NULL DEFAULT 'pending',
  error_type                  TEXT,
  error_message               TEXT,
  error_stacktrace            TEXT,
  error_details               JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_compensation_block_halt_status CHECK (
    status IN ('pending', 'resolved', 'skipped')
  )
);
```

Implementation details below this level — indexes, retention, and exact FK choices — should be finalized with the public API implementation.

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

| Field type          | Equality (`eq`/`ne`/`in`/`notIn`)      | Range (`gt`/`gte`/`lt`/`lte`) | Sort |
| ------------------- | -------------------------------------- | ----------------------------- | ---- | --- |
| `string`            | yes                                    | yes                           | yes  |
| `number`            | yes                                    | yes                           | yes  |
| `boolean`           | yes                                    | no                            | no   |
| `null`              | yes                                    | no                            | no   |
| `string             | null`                                  | yes                           | no   | no  |
| `string             | number`                                | yes                           | no   | no  |
| `string             | object`                                | yes                           | no   | no  |
| `readonly string[]` | `contains`/`containsAny`/`containsAll` | no                            | no   |

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
  { priority: 10 }, // lower urgency than default (0)
);
```

- Synchronous buffered operation — returns `void`, not awaited.
- Workflow can only enqueue, never read.
- Available in workflow contexts and compensation block contexts.
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

`**DeadLetterHandle<TMessage>` methods:\*\* `list`, `count`, `redrive`, `redriveAll`, `discard`, `discardAll`, `listen`.

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

A global typed request-response primitive. A workflow posts a typed request and blocks until a registered handler, manual resolver, webhook, or operator returns a typed response. The workflow does not know who handles the request.

### Use cases

Requests remain distinct from steps: steps execute workflow-owned logic; requests delegate resolution to external workers or actors.

1. **Handler is the sole resolver** — a registered handler always returns a response.
2. **Handler with manual fallback** — the handler tries programmatic resolution; exhaustion moves the request to manual mode.
3. **Check-or-wait** — the handler checks an external condition and returns `MANUAL` when resolution must come from outside.
4. **Full external resolution** — no handler is registered; an external actor resolves the request through the client API.

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

A request that should be compensable declares that fact in its definition:

```typescript
const refundCharge = defineRequest({
  name: "refundCharge",
  request: z.object({ chargeId: z.string() }),
  response: z.object({ refundId: z.string() }),
  compensation: true,
});

const refundChargeWithOutcome = defineRequest({
  name: "refundChargeWithOutcome",
  request: z.object({ chargeId: z.string() }),
  response: z.object({ refundId: z.string() }),
  compensation: {
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("refunded"), refundId: z.string() }),
      z.object({ kind: z.literal("charge-not-found") }),
      z.object({ kind: z.literal("operator-resolved"), note: z.string() }),
    ]),
  },
});
```

### Workflow-internal API

```typescript
const result = await ctx.requests.humanReview({
  context: "...",
  data: signals,
});
// result: ReviewDecision

const maybe = await ctx.requests.humanReview(
  { context: "...", data: signals },
  { priority: 1, timeout: 300 },
);
// maybe:
//   { ok: true; result: ReviewDecision }
// | { ok: false; status: "timeout" }
```

Requests are Tier 1 entries. They are not `StepCall` instances and expose no builder methods. Priority and timeout are call options.

### Request accessor type

```typescript
interface RequestAccessor<TPayload, TResponse> {
  (payload: InferInput<TPayload>): RequestEntry<InferOutput<TResponse>>;
  (
    payload: InferInput<TPayload>,
    opts: {
      priority?: number;
      timeout: StepBoundary;
    },
  ): RequestEntry<
    | { ok: true; result: InferOutput<TResponse> }
    | { ok: false; status: "timeout" }
  >;
}
```

### Retry policy and exhaustion

The workflow caller controls payload, priority, and timeout. Handler retry behavior is configured at handler registration.

The handler registration supports an eager attempt -> exhaustion fallback pattern. If all attempts are exhausted or total timeout is reached, `onExhausted` runs. It can return a typed response or `MANUAL`. If omitted, the default is `MANUAL`.

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

Failed handler attempts are written to `request_attempt`. Only failures are recorded; successful resolution writes the response directly.

### `MANUAL` sentinel

```typescript
declare const MANUAL: unique symbol;
```

`MANUAL` can be returned by a handler or by `onExhausted`. In both cases the request transitions to manual mode and waits for `client.requests.<name>.resolve()`.

### Request compensation

Request compensation is intentionally asymmetric with step compensation. A request definition declares only that compensation exists. The actual compensation handler is registered separately, just like the request handler itself.

```typescript
type RequestCompensationInfo<TResponse> =
  | {
      readonly status: "completed";
      readonly response: TResponse;
      readonly attempts: AttemptAccessor;
    }
  | {
      readonly status: "timed_out";
      readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: AttemptAccessor;
    }
  | { readonly status: "terminated"; readonly attempts: AttemptAccessor };

declare function registerRequestCompensationHandler<TReq, TRes, TCompResult>(
  definition: RequestDefinition<TReq, TRes> & {
    compensation: true | { result?: TCompResult };
  },
  handler: (
    ctx: { signal: AbortSignal },
    payload: InferOutput<TReq>,
    info: RequestCompensationInfo<InferOutput<TRes>>,
  ) => Promise<
    | (TCompResult extends undefined ? void : InferInput<TCompResult>)
    | typeof MANUAL
  >,
  options: {
    maxConcurrent?: number;
    retryPolicy: {
      timeoutSeconds: number;
      maxAttempts?: number;
      totalTimeoutSeconds?: number;
      intervalSeconds?: number;
      backoffRate?: number;
      maxIntervalSeconds?: number;
    };
    onExhausted?: {
      callback: (
        ctx: { signal: AbortSignal },
        payload: InferOutput<TReq>,
        info: RequestCompensationInfo<InferOutput<TRes>>,
      ) => Promise<
        | (TCompResult extends undefined ? void : InferInput<TCompResult>)
        | typeof MANUAL
      >;
      retryPolicy: {
        intervalMs: number;
        backoffRate?: number;
        maxIntervalMs?: number;
      };
    };
  },
): Unsubscribe;
```

It is acceptable for no compensation handler to exist. The invocation enters manual mode and is resolved externally.

Request compensation invocations are lightweight: no per-instance primitives, no durable branch tree, and no halt semantics. They are still observable and skippable.

```typescript
type RequestCompensationStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "manual";
```

### Request compensation query surface

```typescript
interface RequestCompensationNamespace<TPayload, TCompResult> {
  findUnique(
    query: (
      q: SearchQuery<{ payload: TPayload; metadata: RequestCompBlockMetadata }>,
    ) => SearchQueryNode,
  ): RequestCompensationUniqueHandle<TPayload, TCompResult>;
  findUnique(
    id: RequestCompensationInstanceId,
  ): RequestCompensationUniqueHandle<TPayload, TCompResult>;
  findMany(
    query: (
      q: SearchQuery<{ payload: TPayload; metadata: RequestCompBlockMetadata }>,
    ) => SearchQueryNode,
  ): RequestCompensationSubsetHandle<TPayload, TCompResult>;
}

interface RequestCompensationUniqueHandle<TPayload, TCompResult> {
  status(): Promise<FindUniqueResult<RequestCompensationStatus>>;
  result(): Promise<FindUniqueResult<TCompResult | null>>;
  payload(): Promise<FindUniqueResult<TPayload>>;
  info(): Promise<FindUniqueResult<RequestCompensationInfo<unknown>>>;
  attempts(): Promise<FindUniqueResult<AttemptAccessor>>;
  skip(
    ...args: TCompResult extends void ? [] : [result: InferInput<TCompResult>]
  ): Promise<
    | FindUniqueResult<{ skipped: true }>
    | {
        readonly status: "already_terminal";
        readonly current: "completed" | "skipped";
      }
  >;
}

interface RequestCompensationSubsetHandle<TPayload, TCompResult> {
  count(): Promise<number>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{
    items: readonly {
      id: RequestCompensationInstanceId;
      status: RequestCompensationStatus;
      payload: TPayload;
    }[];
    cursor: string | null;
  }>;
  skip(
    ...args: TCompResult extends void ? [] : [result: InferInput<TCompResult>]
  ): Promise<{ affected: number }>;
}
```

Usage:

```typescript
await workflowInstance.requestCompensations.refundCharge
  .findUnique((q) => q.payload.chargeId.eq("ch_123"))
  .skip({
    kind: "operator-resolved",
    note: "Refund processed via partner portal",
  });
```

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

Handlers claim requests ordered by `priority ASC, created_at ASC, id ASC`.

### Manual resolution client API

```typescript
const result = await client.requests.humanReview.resolve(requestId, {
  decision: "approve",
  note: "Approved by admin",
});

const pending = await client.requests.humanReview.list({
  status: "manual",
  limit: 50,
  cursor: prevCursor,
});

const cancelResult = await client.requests.humanReview.cancel(requestId);
```

`resolve()` validates the response against the request's response schema. `resolve()` on a claimed request interrupts the handler via its `AbortSignal`. `cancel()` transitions the request to `cancelled`; workflow-side request entries with timeout observe `{ ok: false; status: "timeout" }`.

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

Synchronous buffered operation — returns `void`, not awaited. Publish only, never consume. Available in workflow contexts and compensation block contexts.

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
    filter: (q) =>
      q.and(q.meta.tenantId.eq("acme"), q.payload.type.eq("booking.confirmed")),
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
filter: (q) => q.meta.tenantId.eq("acme");
filter: (q) =>
  q.and(q.meta.type.eq("booking.confirmed"), q.payload.amount.gte(100));
filter: (q) =>
  q.or(
    q.payload.type.eq("booking.confirmed"),
    q.payload.type.eq("booking.cancelled"),
  );
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

`**neverExpire` option:\*\*

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

| Event type          | Default behavior |
| ------------------- | ---------------- |
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
      maxRecords: 500, // required — upper bound per handler invocation (SQL LIMIT)
      intervalSeconds: 10, // required — polling frequency
      minRecords: 50, // optional — skip tick if fewer available; default 1
      flushAfterSeconds: 60, // optional — force-invoke below minRecords after this duration
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
    registration: {
      /* same as single-record consumer */
    },
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

`**TopicRecord` type:\*\*

```typescript
interface TopicRecord<TPayload, TMetadata> {
  readonly id: string;
  readonly payload: TPayload; // InferOutput<TPayloadSchema>
  readonly metadata: TMetadata; // InferOutput<TMetadataSchema>
}
```

Both the single-record consumer and the batch consumer receive records of this shape. The single-record handler gets one `TopicRecord`; the batch handler gets `readonly TopicRecord[]`.

**Batch options:**

| Setting             | Required | Default     | Purpose                                                                                                                                                                                              |
| ------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRecords`        | yes      | —           | Upper bound on batch size. Maps to SQL `LIMIT`. Controls memory and handler timeout budget.                                                                                                          |
| `intervalSeconds`   | yes      | —           | Polling frequency. Every N seconds, query for available records.                                                                                                                                     |
| `minRecords`        | no       | `1`         | Minimum records to trigger the handler. If fewer are available, skip this tick.                                                                                                                      |
| `flushAfterSeconds` | no       | `undefined` | Force-invoke even below `minRecords` if this duration has elapsed since the last successful handler invocation. Prevents indefinite stalling on low-throughput topics with a `minRecords` threshold. |

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

Synchronous buffered operation — returns `void`, not awaited. Set only, never read. Available in workflow contexts and compensation block contexts.

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

**Introduce `Failure` (base) and `Attempt extends Failure` (with `attempt: number`).** The previous single `StepExecutionError` type leaked the step origin into a type shared across all attempt-bearing contexts and conflated _captured throws with no retry context_ (what a mode-`"any"` branch surfaces — a single throw, no attempt number) with _captured throws inside a retried operation_ (what a step / queue handler / request handler / topic consumer surfaces — one record per attempt with a 1-indexed number). Splitting into `Failure` (the base) and `Attempt extends Failure` (the retried-operation extension) makes both contexts type-correct without losing field reuse.

**Introduce `AttemptError` class:** a throwable `Error` subclass that handlers can use to attach structured, JSON-serializable details to failures. When the engine catches an `AttemptError`, it persists `type`, `message`, and `details` directly. When it catches a plain `Error`, it extracts `message` and `constructor.name`. When it catches any other thrown value, it best-efforts `String(thrown)` for the message. This means all error fields on `Failure` (and therefore `Attempt`) are nullable — JavaScript's `throw` can throw anything, including values with no message, no type, and no details.

**Unify attempt record shape:** all attempt-bearing subsystems (steps, queue handlers, topic consumers, request handlers) share the same DB column pattern: `attempt`, `error_message`, `error_type`, `error_details`, `started_at`, `failed_at`. Error columns are nullable (a thrown `undefined` or an abruptly terminated attempt has no error info). The public type reflects this with `startedAt` and `failedAt` (both `Date`), replacing the old single `timestamp` field. This captures duration — useful for diagnosing slow failures vs immediate crashes.

`**count` property → `count()` async method:\*\* consistent with the fully lazy interface.

**Compensation attempt access:** `CompensationInfo` exposes `.attempts` on observed forward outcomes so undo logic can inspect retry history when a timeout or termination leaves side effects uncertain.

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

| Thrown value             | `type`                                                                                           | `message`        | `details`           |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------- | ------------------- |
| `AttemptError` instance  | `.type`                                                                                          | `.message`       | `.details`          |
| `ExplicitError` instance | `"ExplicitError"` (or `null` for non-`AttemptError` `Error` subclasses, depending on serializer) | `.message`       | `{ code, details }` |
| `Error` instance         | `.constructor.name`                                                                              | `.message`       | `null`              |
| `string`                 | `null`                                                                                           | the string       | `null`              |
| anything else            | `null`                                                                                           | `String(thrown)` | `null`              |

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

| Thrown value         | Queue behavior                                         | Topic behavior                                         |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Regular `Error`      | Retry per `retryPolicy`                                | Retry per `retryPolicy`                                |
| `UnrecoverableError` | Dead-letter immediately                                | `onConsumeError("attemptsExhausted")` immediately      |
| `AttemptError`       | Retry per `retryPolicy` (structured details persisted) | Retry per `retryPolicy` (structured details persisted) |

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

`ScheduledDeliveryOptions` is intersected into root workflow start options, attached child workflow entry options, and detached child workflow start options. Compensation block child-workflow dependencies use the same child workflow option shapes as workflow execution.

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
type StartWorkflowOptions<
  TArgs,
  HasFactory extends boolean,
> = HasFactory extends true
  ? { args: TArgs; idempotencyKey?: string } & ScheduledDeliveryOptions
  : { args: TArgs; idempotencyKey: string } & ScheduledDeliveryOptions;
```

The same conditionality applies to `ctx.childWorkflows.X(startOpts, opts?)` for attached children and `ctx.childWorkflows.X.startDetached(...)` for detached children.

---

## Part 18: Serializable Step Arguments

### Problem

Step arguments are currently regular TypeScript function parameters — positional, untyped at the persistence level, and invisible in the database. Every other input in the system (workflow args, request payloads, queue messages, channel messages, error details) is schema-constrained and serialized to JSONB. Step args are the sole outlier. This means:

- Timeout handling, attempt inspection, and compensation cannot inspect typed step args.
- Compensation `undo` callbacks need the original typed args.
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
    const booking = await flightAPI.book(args.destination, args.passengerId, {
      signal,
    });
    return { confirmationId: booking.id };
  },
});
```

The call site changes from positional args to a single object:

**Before:** `ctx.steps.bookFlight("Paris", "p-123")`

**After:** `ctx.steps.bookFlight({ destination: "Paris", passengerId: "p-123" })`

The `args` field is a `JsonSchemaConstraint` — the same constraint as everything else that goes into JSONB. Arguments are serialized into the step record alongside the result, enabling full observability: the database records what was attempted, failed attempts carry the input, and compensation info can provide typed args.

### Input/Output convention

The codebase follows a strict encode-on-write, decode-on-read discipline using `StandardSchemaV1`'s two type parameters. Standard Schema does not support bidirectional transforms (there is no `encode(Output) → Input`), so the write side must always accept `InferInput` (the JSON-serializable form):

- **Call sites** (write side) accept `InferInput`: `ctx.steps.X(args)`, `ctx.childWorkflows.X({ args })`, `ctx.errors.X(message, details)`, `channel.send(data)`, `stream.write(data)`. The developer provides the serializable form.
- **Callbacks** (read side) receive `InferOutput`: `execute({ signal }, args)`, `beforeSettle`, compensation `undo` callbacks, `idempotencyKeyFactory(args)`. The engine deserializes from the database and validates through the schema, producing the decoded form.
- **External results** (read side) are typed as `InferOutput`: step results, workflow results, error details, operation results and compensation info. The external caller receives the decoded form.

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
  branches:              { [name: string]: BranchDefinition },
  steps:                 { [name: string]: StepDefinition },
  idempotencyKeyFactory: (args: InferOutput<TArgs>) => string,
});
```

Removed or replaced from current workflow definitions:

- `state` as a workflow-level mutable state factory.
- `beforeCompensate` / `afterCompensate` hooks.
- inline branch declarations inside `ctx.scope`.

New workflow-definition surface:

- `errors` declares typed workflow business failures.
- `branches` declares reusable isolated branch definitions.

### `defineStep` changes

```typescript
defineStep({
  name: string,
  args: JsonSchemaConstraint,
  result: JsonSchemaConstraint,
  execute: ({ signal }, args) => Promise<Result>,
  retryPolicy?: RetryPolicyOptions,
  compensation?: {
    channels?:   { [name: string]: JsonSchemaConstraint },
    streams?:    { [name: string]: JsonSchemaConstraint },
    events?:     { [name: string]: true },
    attributes?: { [name: string]: JsonSchemaConstraint },
    steps?:      { [name: string]: NonCompensableStepDefinition },
    requests?:   { [name: string]: NonCompensableRequestDefinition },
    branches?:   { [name: string]: BranchDefinition },
    result?:     JsonSchemaConstraint,
    undo: (ctx, args, info) => Promise<Result>,
  },
});
```

### Context changes

| Change                                                              | Details                                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ctx.steps.X(args, opts?)`                                          | Returns an awaitable entry. No builder chain. Timeout via `{ timeout }`.                           |
| `ctx.requests.X(payload, opts?)`                                    | Returns an awaitable entry. Priority and timeout via options.                                      |
| `ctx.childWorkflows.X(startOpts, opts?)`                            | Attached child workflow entry; always returns success/failure union, timeout adds timeout variant. |
| `ctx.branches.X(args)`                                              | Creates an unstarted branch entry from a predefined branch.                                        |
| `ctx.errors.X(message, details?)`                                   | Factory functions for the current definition level's declared errors.                              |
| `ctx.queues.X.enqueue(payload, opts?)`                              | Sync buffered operation.                                                                           |
| `ctx.topics.X.publish(payload, opts?)`                              | Sync buffered operation.                                                                           |
| `ctx.attributes.X.set(value)`                                       | Sync buffered operation.                                                                           |
| `ctx.scope(name, entries, body)`                                    | Directly awaitable. Entries can be objects, arrays/tuples, and maps.                               |
| `ctx.match(handles)`                                                | Async iterable of keyed/indexed/map-keyed completions. No handler form.                            |
| `ctx.join(handle, opts?)`                                           | Observes one handle; optional timeout only times out observation.                                  |
| `ctx.all` / `ctx.first` / `ctx.atLeast` / `ctx.atMost` / `ctx.best` | Directly awaitable structured-concurrency helpers over generalized entries.                        |

Removed context APIs:

- `ctx.addCompensation`.
- `ctx.state`.

### Removed call types and methods

- `StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`.
- `DurableHandle`, `AtomicResult`.
- `.resolve(ctx)`.
- `.retry(policy)`.
- `.timeout(boundary, cb)`.
- `.failure(cb)`.
- `.priority(n)`.
- `.complete(cb)`.
- `.compensate(cb)` / `.compensate(name, cb)`.
- `Called`, `TFail`, `TTimeout` chain bookkeeping.

### New exports

- `defineQueue`, `defineRequest`, `defineTopic`.
- `SearchQueryNode`, `SearchQuery`.
- `DeadLetterRecordFields`, `DeadLetterSort`, `DeadLetterCursor`, `DeadLetteredMessage`, `DeadLetterHandle`.
- `AttemptAccessor`, `Failure`, `Attempt`, `AttemptError`.
- `ExplicitError`, `ErrorValue`, `FailureInfo`.
- `CompensationInfo`, `CompensationBlockStatus`, `CompensationBlockInstanceId`, `FindUniqueResult`.
- `RequestCompensationInfo`, `RequestCompensationStatus`, `RequestCompensationInstanceId`.
- `StepBoundary`, `MAIN_BRANCH`, `BranchPathItem`, `MANUAL`, `UnrecoverableError`.
- `Unsubscribe`.
- `TopicRecord`.
- `RegisterTopicConsumerError`, `RegisterTopicConsumerErrorEvent`, `TopicConsumerAlreadyActiveError`, `TopicConsumerConsumeErrorEvent`.
- `ScheduledDeliveryOptions`.
- `IWorkflowConnection`, `IWorkflowTransaction`.
- `RetentionSetter`.

### Removed exports

- `WorkflowError`.
- `StepTimeoutError`.
- `StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`.
- `DurableHandle`, `AtomicResult`.
- `TimeoutInfo`, `StepFailureInfo`, `ChildWorkflowFailureInfo` callback-info types.
- `StepCompensationResult`, `RequestCompensationResult` closure-info types.
- `CompensationFailureInfo`.

### Breaking changes

#### Compensation

- Compensation moves from call sites to `defineStep.compensation` and `defineRequest.compensation`.
- Step compensation invocations become queryable compensation block instances with per-instance primitive state.
- Request compensation invocations are lightweight observable entities with manual-mode support.
- Compensation reports typed results by return value, not by throwing declared compensation errors.
- Compensation block halts are skippable per instance.
- Workflow-level compensation hooks and ad hoc `ctx.addCompensation` cleanup registration are removed.

#### Branches and errors

- Branches are predefined with serializable args and results.
- Inline scope branch closures are removed.
- `errors` is a new schema-declared failure surface for workflow and branch definitions.
- Branches declare local `errors` and receive local `ctx.errors`.
- Branches cannot access workflow-level errors.
- Branch invocations are externally queryable and skippable.

#### Call sites

- Public `.resolve(ctx)` is removed. Direct `await` is the terminal operation.
- Retry, timeout, and priority are call-time options.
- Timeout/failure recovery happens in sequential code by inspecting returned unions.
- Attached child workflows no longer expose a `terminated` in-workflow result.
- Detached child workflows remain separately terminable root workflow instances.

#### Structured concurrency

- `ctx.scope`, `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, and `ctx.best` accept generalized entries.
- Scope input supports entries, arrays/tuples, and maps.
- `ctx.join(handle, { timeout })` is a non-cancelling observation timeout.
- `ctx.match` understands object, array, and map structure.

#### Attempts and serializable args

- `StepErrorAccessor` is renamed to `AttemptAccessor`.
- `Failure` is the base captured-throw record; `Attempt extends Failure` adds `attempt`.
- `AttemptAccessor.count` becomes async `count()`.
- Step `schema` is renamed to `result` and `args` is required.
- Step call sites use a single schema-validated object arg.
- Step records persist args for observability and compensation.

#### Engine and runtime

- Branch interleaving order is implementation-defined and must not affect workflow logic.
- Buffered operations remain synchronous and are committed in batch transactions.
- `receiveNowait` and `patch` trigger buffer flushes before reading committed state.
- Request handler `MANUAL` return transitions directly to manual mode.
- Handler retry policies use seconds for durable persisted retry configuration; runtime retry policies use milliseconds.
- Search range comparisons and sorting are restricted to homogeneous comparable fields.

### Connection and transaction model

Two opaque types:

```typescript
type IWorkflowConnection;
type IWorkflowTransaction;
```

Client and engine-level CRUD APIs accept optional `txOrConn?: IWorkflowTransaction | IWorkflowConnection`. Workflow logic (`ctx.*`) runs inside the engine's durable execution transaction; blocking operations and subscriptions are exempt.
