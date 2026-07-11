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
6. **Search query refactoring** — replace namespace builders with a row-scoped predicate DSL (`WhereScope<TRowTemplate> -> Predicate`)
7. **Scheduled delivery** — `delay`/`ttl` on queue enqueue; `delaySeconds`/`scheduledAt` on workflow starts

**Architectural changes** — corrections and redesigns to existing engine behavior:

1. **Execution model** — durable replay, batched commits, promise sequencing, and the buffered/dispatched operation distinction described as independent properties of a single sequential workflow body that orchestrates concurrent dispatched entries
2. **Compensation model redesign** — compensation belongs to the operation it undoes; each step-compensation invocation becomes an isolated, queryable compensation block instance scheduled alongside the workflow body
3. **Halt model** — execution halts remain patch-and-replay only; compensation block halts can be skipped per instance
4. **Error model** — schema-declared workflow business failures via a single local `errors` field on `defineWorkflow`, exposed as `ctx.errors`
5. **Call-time options** — builder chains disappear; operation calls accept options and return discriminated union outcomes where needed
6. **AttemptAccessor refactoring** — rename `StepErrorAccessor` → `AttemptAccessor`, introduce `Failure` base record + `Attempt extends Failure` for retried operations, introduce `AttemptError` throwable class, unify attempt record shape, make `count()` async
7. **Context isolation** — isolated units of work receive only their declared args, dependencies, primitives, and local `errors`
8. **Scopes and structured-concurrency consumption** — `ctx.scope` and the convenience helpers orchestrate steps, requests, and child workflows as scope entries; concurrency comes from dispatched entries, not from user-declared concurrent code paths
9. **Database schema** — a single durable execution tree per workflow body, parallel compensation block instances modelled as workflow-shaped subordinate execution trees, and parallel primitive tables
10. **Workflow identity** — mandatory `identity` block on every workflow; conditional `identity` at start; `.get(identity)` lookup (see Part 17)
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

The deeper issue is syntactic isolation. Inline compensation closures can read and mutate variables from their parent lexical scope, even though the engine treats them as independent units of work. The public API now makes that isolation visible:

- Compensation is declared on the step or request definition it undoes.
- Each step compensation invocation becomes a durable compensation block instance with its own primitive state.
- The workflow declares a single local `errors` map and receives a single local `ctx.errors` namespace.
- Operation configuration moves into call-time options; outcomes are handled as returned values in ordinary sequential code.

### Why concurrency lives in dispatched entries, not in user code

Earlier iterations of this design treated branches as user-facing concurrent execution paths within one workflow. That shape is wrong: a workflow's primitives (channels, streams, events, attributes) have semantics that race or aggregate poorly across multiple concurrent writers, and the only thing concurrent branches actually offered above sequential code was a shared durable batch — an operational property, not a semantic one.

The clean alternative is that a workflow body is a single sequential program. Concurrency comes from **dispatched entries** — steps, requests, and child workflows — that the engine starts as their own durable rows and that the body awaits via `ctx.join` / `ctx.match` or via the structured-concurrency helpers. There is no second sequential thread inside the body to interleave; the body and the entries it dispatches are clearly separated.

### Why the execution model needs formalization

Even with a single sequential body, the engine still needs guarantees: durable replay must reproduce the same sequence of dispatches and observe the same results in the same order, side effects must commit atomically in batches between suspension points, and `ctx.join` / `ctx.match` must observe simultaneously-completed entries in a deterministic order. These are independent properties — durability, batched commitment, and promise sequencing — and they survive without being unified under a single scheduler abstraction.

---

## Part 1: Execution Model

A workflow body is a single sequential program. Concurrency comes from **dispatched entries** — steps, requests, and child workflows — that the engine starts as their own durable rows and whose completions the body awaits. There is no second sequential execution path inside the body to interleave.

The execution model is described as a set of independent properties: durable replay, the buffered/awaitable operation distinction, batched commitment of side effects, promise sequencing for `join` / `match`, and the parallel scheduling lane for compensation.

### 1.1 Workflow body and dispatched entries

A `defineWorkflow.execute` callback is an ordinary `async` function. Each step / request / child workflow call inside it is recorded as a durable entry; the call returns an awaitable entry value that, when awaited, suspends the body until the engine observes the entry's completion.

- `ctx.steps.X(args, opts?)`, `ctx.requests.X(payload, opts?)`, and `ctx.children.attached.X(args, opts?)` create typed unstarted entries. Direct `await` dispatches and observes an entry. The structured-concurrency helpers (`ctx.scope`, `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, `ctx.some`) dispatch a top-level object of entries under structural ownership and let the body await results selectively.
- `ctx.children.detached.X(args, opts)` is a buffered start that returns a `ForeignWorkflowHandle<W>` and is not joinable from the parent.
- The body itself never forks. Whatever concurrency exists is between the dispatched entries the body has started but not yet awaited.

### 1.2 Buffered vs awaitable operations

Operations the body invokes fall into four categories:

| Category            | Operations                                                                                                                                                                                                  | Behavior                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Buffered**        | `stream.write`, `event.set`, `attribute.set`, `queue.enqueue`, `topic.publish`, external / detached `channels.X.send`, attached `channels.X.send` **only** on scope-local handles (`ctx.scope` body), `register_compensation_instance`, `promote_compensation_instance`, `children.detached.X(...)` | Synchronous, returns `void`. The engine records the operation in an in-memory buffer; nothing is dispatched or visible externally until the next batch commit. |
| **Dispatched**      | `steps.X(...)`, `requests.X(...)`, `children.attached.X(...)` (when awaited or passed to a scope helper)                                                                                                    | The engine records a "dispatch" entry plus a promise; commits the buffer; then starts the external work. The body suspends until the promise resolves. |
| **Awaitable wait**  | `channel.receive`, `sleep`, `sleepUntil`                                                                                                                                                                    | Suspends the body on existing primitive state. Records a wait entry and a promise; commits the buffer; resumes when the promise resolves. |
| **Awaitable read**  | `channel.receiveNowait`, `patch`                                                                                                                                                                            | Reads from committed state. Triggers a flush of any pending buffer first, then resolves immediately. No promise. |

Buffered operations and awaitable reads are the only operations whose direct effect on the body is `void` or an immediate value. Everything else suspends.

### 1.3 Durable replay

Every dispatched entry, awaitable wait, and buffered operation is recorded with an ordinal in the workflow body's execution log (Part 8). When the body is replayed — on worker restart, after a halt, or when fast-forwarding to a known position — the same code must reach the same recorded operations in the same order and observe their recorded results in the same order. This is the durability guarantee.

The engine does not depend on JavaScript promise scheduling for correctness. The body coroutine is driven step by step from recorded ordinals; on replay, the engine returns recorded results to each operation it sees and only blocks at operations that have no recorded result yet.

### 1.4 Batched commitment

Between two suspension points in the body, the body may have invoked any number of buffered operations and may have decided to dispatch zero or more entries. The engine accumulates all of these in memory. At the next suspension point, it commits the accumulated batch in a single database transaction. Only after that commit does it dispatch any new external work — step coroutines start, child workflow dispatches happen, request rows become claimable, queue messages become visible, topic records appear, attribute notifications fire.

This guarantees two properties:

1. **Atomicity.** Either the entire batch (every buffered op and every dispatch decision) commits or none of it does. There is no partial visible state.
2. **Replay safety.** A re-execution that reaches the same suspension point sees the same committed batch. Buffered operations are not re-issued externally; on replay the engine recognizes the existing rows and skips re-emission.

Awaitable reads (`receiveNowait`, `patch`) are the one place where the body needs current committed state mid-flow. They trigger a buffer flush — committing whatever has accumulated so far — before reading.

### 1.5 Promise sequencing for `join` and `match`

When the body is parked at `ctx.match(handles)` or has dispatched several entries that may complete simultaneously, the order in which the body observes their completions must be deterministic across replays. Each entry's promise records a `sequence_no` on resolution from a Postgres sequence (or equivalent) per workflow body. The body's resume loop fetches resolved promises ordered by `sequence_no`; `match` yields them in that order, and a body parked on `ctx.join` simply waits for that one promise to resolve.

This sequencing is local to the body. It is not the user-facing scheduling of concurrent execution paths — there is only one execution path. It exists solely so that two entries that resolved "at the same time" produce the same yield order on replay.

### 1.6 Compensation as a sibling workflow

Every execution workflow is paired at start time with a sibling **base compensation workflow**. Both are real `workflow` rows (Part 8). The execution workflow runs the user's `defineWorkflow.execute` body. The base compensation workflow runs an engine-internal sequencer that promotes registered compensation block instances eagerly (FIFO at settle decisions) or as LIFO unwind on execution-workflow failure.

A **compensation block instance** is a child workflow of the base compensation workflow. It has the same shape as any other workflow: its own body (the user's `undo` callback), its own step rows, its own primitives, its own halts. The engine starts it as a `start_child_workflow` step inside the base compensation workflow, exactly like any parent → child workflow dispatch.

This means the engine has no specialized "compensation execution model." The execution and compensation paths are both workflows. The execution workflow body is a sequential program with dispatched entries; the base compensation workflow body is a sequential program with dispatched entries (those entries happen to be compensation block instances). Compensation block instance bodies are sequential programs with dispatched entries. All three obey 1.1 through 1.5 identically.

The user-facing behaviour remains: when a compensable forward operation in the execution workflow reaches a settle decision that requires undo, the corresponding compensation block instance is dispatched and starts running. The execution workflow body and the compensation block instance body never share a coroutine, never share buffered state, and never observe each other's primitives — because they are different workflows. They communicate, when they need to, only through global primitives (queues, topics, requests, child workflows).

### 1.7 Nested scopes

Nested scopes do not introduce new execution paths — the body is still sequential. A scope is a structured-concurrency boundary that:

1. Dispatches the entries supplied as its top-level object input.
2. Hands the body a typed mirror of that object where each entry has been replaced with a handle (joinable, and where applicable also `channels.send`-capable for child workflow handles).
3. Lets the body await selectively via `ctx.join`, `ctx.match`, or the convenience helpers.
4. On scope exit, ensures any unconsumed entries are torn down or compensated according to scope rules.

A scope inside a scope is just another suspension point on the same sequential body, with its own typed handle bag.

### 1.8 What the durable record looks like

A workflow body is persisted as an ordered sequence of step rows under that workflow's row (Part 8). Step rows record dispatched-entry starts, dispatched-entry settles (`await_promise`), awaitable waits, awaitable reads, buffered ops, and scope structural markers (`execute_scope`). Scope nesting is encoded via `step.parent_step_id` self-references; there is no separate `branch` or `scope` table.

The same shape applies uniformly to execution workflow bodies, base compensation workflow bodies, and compensation block instance bodies — they are all just workflow bodies in the same `step` table. A precise breakdown of step row types and their persistence shape lives in Part 8. The execution model in this Part is independent of that table layout.

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
    ctx: { args: InferOutput<TArgs>; signal: AbortSignal },
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
  children?: { attached?: { [name: string]: WorkflowDefinition }; detached?: { [name: string]: WorkflowDefinition } };

  // Optional compensation outcome schema. Default: void.
  result?: TComp;

  undo: (
    ctx: CompensationContext<..., TArgs, TForwardResult>,
  ) => Promise<TComp extends undefined ? void : InferInput<TComp>>;
}
```

`undo` receives a single `ctx`: `ctx.args` is the original forward input; `ctx.info` is the engine-level forward settlement snapshot (`CompensationInfo`).

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
  execute: async (ctx) => {
    await hotelAPI.cancel(ctx.args.confirmationId, { signal: ctx.signal });
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
  execute: async (ctx) => {
    return {
      confirmationId: await hotelAPI.book(ctx.args, { signal: ctx.signal }),
    };
  },

  compensation: {
    steps: { cancelHotelStep },
    undo: async (ctx) => {
      if (ctx.info.status === "completed") {
        await ctx.steps.cancelHotelStep({
          confirmationId: ctx.info.result.confirmationId,
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
- its own sequential `undo` execution path (a workflow-shaped body with its own dispatched entries, buffered ops, batch commits, and promise sequencing — see Part 1);
- its own result value when a `result` schema is declared;
- its own external query handle.

Two invocations of the same compensable step do not share primitive state. If compensations need to coordinate, they must use global primitives such as queues, topics, requests, or child workflows.

### Query-grounding handle pattern

External callers address compensation block instances through a handle. A handle grounds identity for later queries; it does not eagerly fetch a row.

The opaque public id type is `CompensationId<TStep>` — branded with the step definition the compensation belongs to, so that ids from different compensable steps are not interchangeable at the type level. Internally a `CompensationId<TStep>` is a workflow id (the compensation block instance is itself a `workflow` row, see Part 8); externally that detail is not exposed.

```typescript
type CompensationId<TStep> = string & {
  readonly __brand: "CompensationId";
  readonly __step: TStep;
};
```

```typescript
type CompensationBlockStatus =
  | "pending"
  | "running"
  | "completed"
  | "halted"
  | "skipped";

type FindResult<T> = Promise<readonly T[]>;

// Single row-shaped predicate template.
type CompensationBlockWhereTemplate<TStep, TArgs, TResult> =
  CompensationBlockRow<TStep, TArgs, TResult>;

// The full row shape, including JSONB columns as opaque values for fetchRow / prefetch.
interface CompensationBlockRow<TStep, TArgs, TResult> {
  readonly id: CompensationId<TStep>;
  readonly definitionName: string;
  readonly status: CompensationBlockStatus;
  readonly args: TArgs;
  readonly result: TResult | null;
  readonly info: CompensationInfo<unknown> | null;
  readonly halt: HaltRecord | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly haltedAt: Date | null;
  readonly skippedAt: Date | null;
}

interface CompensationBlockNamespace<TStep, TArgs, TResult, TPrim> extends
  QueryableNamespace<
    CompensationBlockUniqueHandle<TStep, TArgs, TResult, TPrim>,
    CompensationBlockWhereTemplate<TStep, TArgs, TResult>,
    CompensationBlockRow<TStep, TArgs, TResult>,
    CompensationId<TStep>
  > {}
```

A unique handle exposes per-instance reads and operator actions. `find` returns `Promise<readonly Handle[]>`. Bulk operator actions are expressed by mapping over the array.

```typescript
interface CompensationBlockUniqueHandle<TStep, TArgs, TResult, TPrim>
  extends FetchableHandle<CompensationBlockRow<TStep, TArgs, TResult>> {
  readonly id: CompensationId<TStep>;

  // skip IS abandonment for compensation block instances. There is no
  // graceful alternative; no strategy choice; no separate sigkill verb.
  // The result argument is required when the compensation declared a result
  // schema; only when the schema was omitted (TResult = void) does skip()
  // accept zero arguments.
  skip<TRaw>(
    session: OperatorSession<TRaw>,
    ...args: TResult extends void
      ? []
      : [result: InferInput<TResult>]
  ): Promise<
    | SkipOutcome
    | {
        readonly status: "already_terminal";
        readonly current: "completed" | "skipped";
      }
  >;

  // Per-instance primitive accessors. Snapshot/command IO takes session first
  // (Part 19); watch IO (event wait) does not.
  attributes: {
    /* declared attributes; per-instance reads */
  };
  streams: {
    /* declared streams; per-instance reads */
  };
  events: {
    /* declared events; per-instance wait/isSet */
  };
  channels: {
    /* declared channels; send targets this instance, buffered op */
  };
}

// FindResult materialises the full matching set when awaited.
// Callers bound large scans with `limit`; pagination beyond that is caller-owned.
type FindResult<T> = Promise<readonly T[]>;

// FindOptions is parameterized by the same namespaces the predicate is built over,
// so sort paths get the same type-level safety as filter paths: only paths whose value
// resolves to purely `string` or purely `number` (no booleans, no unions, no arrays).
// See Part 9 for the generalization of SearchSort<TNamespaces>.
interface FindOptions<TNamespaces extends Record<string, SearchMetadataRecord>> {
  readonly sort?: readonly SearchSort<TNamespaces>[];
  readonly limit?: number;
}
```

### Failure semantics: return, do not throw

The compensation context has no workflow `ctx.errors`. Compensation reports its outcome through the optional `result` schema on its definition. Early `return` is the explicit short-circuit. Throws are reserved for halts.

Aggregate workflow-level compensation APIs such as `handle.compensation.wait()` and `CompensationFailureInfo` are removed. Per-instance reads through `find(...)` + `fetchRow(...)` and developer-declared events replace them.

### Type-level discrimination

A step with a `compensation` field is compensable. A request with `compensation: true` or `compensation: { result }` is compensable. These are properties on the existing definition types:

```typescript
type IsStepCompensable<S> = S extends { compensation: object } ? true : false;
type IsRequestCompensable<R> = R extends { compensation: true | object }
  ? true
  : false;
```

Compensation dependencies may not themselves be compensable. This prevents compensation from recursively spawning more compensation chains. Child workflows are exempt; each workflow owns its own internal compensation lifecycle.

### Compensation scheduling lifecycle

A compensation block instance is a child workflow of the execution workflow's sibling **base compensation workflow** (Part 1.6, Part 8). Registration creates the child workflow row in `pending`; promotion dispatches it. The "scheduling" is just the base compensation workflow's body promoting its children in the right order.

Step record evolution in the execution workflow body:

```
ordinal 1: { type: "start_step",                     definition_name: "bookHotel" }
ordinal 2: { type: "register_compensation_instance", definition_name: "bookHotel", compensation_workflow_id: "wf_cbi_..." }
ordinal 3: { type: "await_promise",                  promise_id: 42 }
-- timeout fires --
ordinal 4: { type: "promote_compensation_instance",  compensation_workflow_id: "wf_cbi_..." }
```

`compensation_workflow_id` is the workflow id of the compensation block instance. Externally, it is exposed to the operator as a branded `CompensationId<TStep>`; the fact that it is a workflow id underneath is an implementation detail.

The engine processes promotions in two modes. **Eager FIFO**: the moment a compensable forward operation reaches a settle decision that requires undo (e.g. a timed-out step that may have produced a side effect), the registered compensation block instance is promoted and starts running. **LIFO unwind**: when the execution workflow body fails, any registered-but-not-promoted compensation block instances are promoted in reverse registration order so that "outer" undo runs after "inner" undo.

A promoted compensation block instance executes its `undo` callback as its workflow body, dispatching its declared dependencies (non-compensable steps, requests, queues, topics, child workflows) and observing them with `ctx.join` / `ctx.match` exactly like an execution workflow body. If the `undo` callback throws, the instance halts (per-instance, skippable). If it returns, the instance completes with the returned value (or void).

---

## Part 3: Halt Model and Operator Actions

### Problem

Any unexpected exception (anything that the surrounding context's mode does not classify as a declared failure — see the per-context throw rules below) in workflow or compensation code puts the engine in an undefined state. The code between the last durable step and the exception is non-deterministic on replay. Retrying the code block is not safe — it may have already modified in-memory state.

### Halts

A halt is a soft failure that pauses execution of a workflow at the point of the unexpected exception. The workflow transitions to `status = 'halted'`. Multiple pending halts can coexist — each represents a point where replay encountered an exception.

Because compensation block instances are themselves workflows (Part 1.6, Part 8), there is one unified halt concept and one `halt` table covering every kind of workflow row in the system. The differences between an execution-workflow halt and a compensation-block-instance halt are not at the halt-table layer — they are at the operator-action layer (which actions are available against which workflow kinds; see below).

```sql
CREATE TABLE halt (
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

  CONSTRAINT chk_halt_status CHECK (status IN ('pending', 'resolved', 'skipped'))
);
```

A halt's `status` reaches `'resolved'` when a patch + replay produces a coroutine that proceeds past `after_step_id` without throwing, or `'skipped'` when an operator skips the owning workflow with a `skip(...)` action (see below).

### Operator actions

Workflows are the only operator-addressable execution entity. The same three terminal-action verbs apply to every operator-addressable workflow row, modulo a few capability differences:

| Verb                                    | Effect                                                                                                                                                            | Status outcome           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `sigkill()`                             | Abandon. No `AbortSignal` is raised on in-flight work — it is left as-is and never observed again. No compensation runs. No result is set.                        | `terminated`             |
| `sigterm()`                             | Cancel in-flight work via `AbortSignal`, then run the compensation stack. The workflow transitions to `completed` or `failed` based on the compensation outcome.  | `completed` or `failed`  |
| `skip(result, { strategy? })`           | Set `result` to an operator-supplied value AND terminate. `strategy: "sigterm"` runs compensation first; `strategy: "sigkill"` abandons. Default is `"sigterm"`.    | `skipped`                |

`skip` is the only result-setting verb. It composes "set the result" with "stop the work", and the stop-strategy is the operator's choice within the per-workflow allowed set.

#### Capability matrix

| Workflow kind                  | Globally searchable | `sigkill` | `sigterm` | `skip(result, opts?)`               |
| ------------------------------ | ------------------- | --------- | --------- | ----------------------------------- |
| Execution workflow (root)      | yes                 | yes       | yes       | yes; `strategy` defaults to `"sigterm"` |
| Detached child workflow (root) | yes                 | yes       | yes       | yes; `strategy` defaults to `"sigterm"` |
| Attached child workflow        | **no** (queryable only via parent) | no | no | no                                  |
| Compensation block instance    | no (queryable only via parent) | no | no | yes (no opts, no strategy choice) — see below |
| Base compensation workflow     | no — engine-managed; not exposed to operators. | | |       |

Attached children are subordinate to the parent's lifecycle. Operators do not terminate them directly — the parent's body decides what to do with their results, and the parent's terminal-action verbs cascade down to them. (See Part 12 for how operators read attached children through the parent.)

Compensation block instances cannot be `sigterm`-ed because they have no compensation stack of their own (Part 6 forbids recursive compensation). They also do not get a separate `sigkill()` verb: for compensation block instances, **`skip` IS abandonment**, just with an operator-supplied result. There is no graceful alternative for compensation, so no strategy choice is meaningful.

#### `skip` on workflows

For ordinary workflows (root + detached child), `skip` is meaningful when the workflow is halted and the operator can supply a valid result:

```typescript
const handle = client.workflows.processOrder.get("order-jan-2027");

await handle.skip({ orderId: "order-jan-2027", status: "manual-cancellation" });
// equivalent to: handle.skip(result, { strategy: "sigterm" })

await handle.skip(
  { orderId: "order-jan-2027", status: "force-cleared" },
  { strategy: "sigkill" },
);
```

The result must conform to the workflow's `defineWorkflow.result` schema. If the schema is `z.void()`, `skip()` takes no result argument.

#### `skip` on compensation block instances

For compensation block instances, `skip(result)` takes the result and nothing else — no `opts`, no strategy. The result argument is required when the compensation declared a `result` schema; only when the schema was omitted (effectively `TResult = void`) does `skip()` accept zero arguments. It abandons the running `undo`, sets the operator-supplied result, and transitions the block to `'skipped'`:

```typescript
const [halted] = await workflowInstance.compensations.steps.bookHotel.find(
  ({ args }) => eq(args.firstName, "Bob"),
  { limit: 1 },
);
if (!halted) throw new Error("missing");

await halted.skip({
  kind: "operator-resolved",
  action: "confirm-no-booking",
});
```

Bulk skipping is expressed inside `client.session` by iterating over `find(session, …)` with a `fields` prefetch and calling `skip(session, result)` on each yielded handle:

```typescript
await client.session(async (session) => {
  const blocks = await workflowInstance.compensations.steps.bookHotel.find(
    session,
    ({ status }) => eq(status, "halted"),
    { fields: { args: true } },
  );

  for (const block of blocks) {
    await block.skip(session, {
      kind: "operator-resolved",
      action: `confirm-no-booking-for-${block.row.args.firstName}`,
    });
  }
});
```

#### Halt resolution paths

A halt can transition to `'resolved'` or `'skipped'`:

1. **Patch + replay** → `'resolved'`. Deploy a code change that fixes the underlying issue. On worker restart, the engine replays the workflow. If the code now proceeds past `after_step_id` without throwing, all pending halts at or before that point are automatically marked `resolved` and the workflow continues.
2. **`skip(result, opts?)`** → `'skipped'` for halts on this workflow. The workflow transitions to `'skipped'`; all of its pending halts transition to `'skipped'`.
3. **`sigkill()` / `sigterm()`** → halts remain `'pending'` and the workflow row transitions to `'terminated'` / `'completed'` / `'failed'`. The halts are no longer actionable but kept for forensics. (Or: they may be moved to a terminal halt state. This is an implementation detail.)

### Per-context throw rules

Whether a thrown value fails or halts depends on the surrounding context. The error model in Part 4 introduces a single local `errors` namespace per definition level (workflow body and compensation `undo` only).

| Surrounding context                            | Throw recognized as failure                                | Anything else                     |
| ---------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| Workflow `execute` body                        | `ctx.errors.X(...)` from `defineWorkflow.errors`           | execution halt                    |
| Scope body                                     | same `ctx.errors` as the parent body (workflow body)       | parent-level halt if unrecognized |
| Step/request timeout or child workflow failure | return-value union from the awaited entry                  | no throw machinery involved       |
| Compensation `undo`                            | no `ctx.errors`; return typed outcomes                     | compensation block halt           |

A scope body is part of the workflow body's sequential execution path, so its `ctx.errors` is the workflow's. There is no separate scope-local error namespace, and there is no branch-level error namespace because branches no longer exist.

---

## Part 4: Error Model

### Problem

The current public API has no schema-declared business error surface on `defineWorkflow`. Workflow code fails by throwing ordinary JavaScript values or exported error classes such as `WorkflowError` / `StepTimeoutError`; the engine serializes those failures into `WorkflowExecutionError` (`message`, `type`, `timestamp`, optional `details`). That is useful for diagnostics, but it is not a typed contract between workflow author and external caller.

Structured-concurrency failure handling is similarly operational rather than domain-shaped. Scope and convenience-method failure callbacks receive `ScopeFailureInfo`, which is a union of step failures, child workflow failures, and `{ kind: "exception"; error: unknown }`. This gives the workflow a place to react, but the intended business failure vocabulary is not declared on the workflow definition, and external callers cannot distinguish deliberate domain failures from unexpected implementation exceptions by schema.

The refactor separates two concerns:

1. **Workflow business failure** — declared by the workflow and visible to the external caller.
2. **Engine events** — step/request timeouts and child workflow failure; these are returned from operation calls as local values, in ordinary sequential code.

### Solution: workflow-local `errors`

The workflow definition declares a local `errors` map and receives a local `ctx.errors` namespace inside its `execute` body and inside any scope body it creates.

| Level    | Declaration             | Effect of `ctx.errors.X(...)`                            |
| -------- | ----------------------- | -------------------------------------------------------- |
| Workflow | `defineWorkflow.errors` | Fails the workflow. Visible externally as `FailureInfo`. |

Compensation `undo` callbacks have no `ctx.errors` — they report outcomes through their declared `result` schema (Part 2). The workflow body's `errors` are not visible inside compensation, since each compensation block instance is its own isolated execution path.

### Workflow error definitions

```typescript
defineWorkflow({
  errors: {
    OrderInvalid: z.object({ orderId: z.string() }),
    InsufficientFunds: z.object({ amount: z.number(), balance: z.number() }),
    Cancelled: true,
  },
  execute: async (ctx) => {
    if (!valid) {
      throw ctx.errors.OrderInvalid("Order is invalid", {
        orderId: ctx.args.orderId,
      });
    }
  },
});
```

A workflow-level `ctx.errors.X(...)` throw fails the workflow and triggers compensation. External callers see only the workflow's declared error values.

### Failures from dispatched entries

A step or request that fails or times out is observed as a local return-value variant on the awaited entry, not as a thrown error. A child workflow that fails is observed as `{ ok: false; status: "failed"; error: ErrorValue<TChildErrors> }` on its awaited entry. These are ordinary values; whether to translate any of them into a workflow-level failure is the body's decision via `throw ctx.errors.X(...)`.

```typescript
const order = await ctx.children.attached.processOrder({ orderId: "o-1" });
if (!order.ok) {
  if (order.status === "failed") {
    throw ctx.errors.OrderProcessingFailed("Child workflow failed", {
      childError: order.error,
    });
  }
}
```

There is no branch-level error namespace, and no `Failure`-as-throwable: ordinary throws inside the workflow body that are not recognized `ctx.errors.X(...)` values become an execution halt (Part 3).

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

When the engine catches an `ExplicitError`, it resolves it against the current definition level only. Workflow-body throws fail the workflow. A throw of a code that is not declared at the current level halts, which catches stale throws after refactors.

### Failure

`Failure` is the base data record for a single captured throw recorded on a retried operation's attempt log. It is also the base shape that `Attempt` extends; `Attempt` adds a 1-indexed `attemptNumber`.

```typescript
interface Failure {
  readonly startedAt: Date;
  readonly failedAt: Date;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
}

interface Attempt extends Failure {
  readonly attemptNumber: number;
}
```

`Failure` itself is not a workflow-facing throw type — there is no longer any branch mode that converts arbitrary throws into `Failure` values. It surfaces in the system as the per-attempt failure record exposed by `AttemptAccessor` (Part 15) for steps, queue handlers, request handlers, and topic consumers.

### Per-context throw rules

| Context                 | Recognized failure throws                | Anything else           |
| ----------------------- | ---------------------------------------- | ----------------------- |
| Workflow `execute` body | `ctx.errors.X(...)` from workflow errors | execution halt          |
| Scope body              | parent body's `ctx.errors.X(...)`        | execution halt          |
| Compensation `undo`     | none; typed return values model outcomes | compensation block halt |

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

Compensation `undo` callbacks do not receive `ctx.errors`. They report intended outcomes by returning values through the optional `result` schema declared on the compensation definition. Unexpected throws halt the compensation block instance.

`CompensationFailureInfo` and `handle.compensation.wait()` are removed. Operators observe compensation block instances through `workflowInstance.compensations.steps.<step>.find(...)` + `fetchRow(...)`, declared events, and `skip()`.

### Rationale recap

1. **The external failure surface must stay business-level.** Developer-declared workflow errors reach the caller; engine events are local return values.
2. **Error scoping matches isolation.** The workflow body and each compensation block instance are independent execution paths; neither sees the other's errors.
3. **The throw site is local.** `ctx.errors.X(...)` always means "throw an error declared at this definition level."

---

## Part 5: Call-Time Options and Timeout Semantics

### Problem

After compensation closures and scope failure callbacks are removed, the builder chain has no remaining reason to exist. `.resolve(ctx)` existed as a type-level proof that a handle was being resolved in the right VEL, but context isolation makes that proof unnecessary. `.retry`, `.timeout`, `.failure`, `.priority`, and `.complete` can be expressed more simply as call-time options and ordinary sequential code.

### Solution

`StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`, `DurableHandle`, and `AtomicResult` are removed. Operation accessors return lightweight awaitable entries with no builder methods.

```typescript
await ctx.steps.bookFlight(args);
await ctx.steps.bookFlight(args, { timeout: 30 });
await ctx.children.attached.processOrder({ orderId: "o-1" }, { timeout: 120 });
await ctx.requests.humanReview(payload, { priority: 1, timeout: 3600 });
```

Calls are not eager native `Promise`s. They are entries that can be directly awaited or passed to named structured-ownership helpers: `ctx.scope`, `ctx.all`, `ctx.first`, `ctx.atMost`, `ctx.atLeast`, or `ctx.some`.

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

A workflow can start child workflows in three shapes; the resulting handle types differ because each shape exposes different capabilities.

#### Three start shapes

| Start shape                                                | Returns                                       | Awaitable for result | `channels.X.send` to child | Has `idempotencyKey` | Tied to parent lifecycle |
| ---------------------------------------------------------- | --------------------------------------------- | -------------------- | -------------------------- | -------------------- | ------------------------ |
| `ctx.children.attached.X(args, opts?)` (workflow body) | `AttachedChildWorkflowEntry<W>`               | yes (`await` entry) | **no** (await-only entry)  | **no** (not on args) | yes                      |
| `ctx.children.detached.X(args, opts)`                       | `ForeignWorkflowHandle<W>`                    | no                   | yes                        | yes                  | no                       |
| Inside a scope: `ctx.scope("S", { x: ctx.children.attached.X(...) }, async (ctx, { x }) => …)` | `AttachedChildWorkflowScopeHandle<W>` (the `x`) | observe via `ctx.join(x)` | yes (until scope exit) | **no**               | yes (until scope exit)   |

**Lifecycle.** Attached children complete within the parent's guarantees: the parent does not finish leaving attached children as independently managed roots. Detached children are buffered starts with their own global identity; the parent does not await them for completion.

**Channel send.** Detached and foreign handles always expose `channels.X.send`. For attached children, the **direct** call return value is **not** a long-lived messaging handle: settle with `await ctx.children.attached.X(...)` for the outcome, or pass the entry into `ctx.scope` and use `handles.x.channels.*.send` plus `ctx.join(handles.x)` while the child runs in the background for the scope.

Attached children deliberately do not have an `idempotencyKey`. They are not globally addressable — their identity is "the attached child of this parent at this dispatch site," not a key under the workflow definition. Detached children are real root workflows with a derived idempotency key, addressable via `client.workflows.<def>.get(identity)` like any other workflow (Part 17).

`ForeignWorkflowHandle<W>` is also what `ctx.externalWorkflows.<name>.get(identity)` returns inside workflow logic (Part 17). Detached starts and external lookups produce the same handle type. The client-level direct-access lookup (`client.workflows.<def>.get(identity)`) returns the richer `WorkflowHandleExternal<W>` because external callers need the full operator-action surface.

#### Attached child workflow entries (workflow body level)

Attached child workflows always return a discriminated union because child failure is structurally possible.

```typescript
const order = await ctx.children.attached.processOrder({ orderId: "o-1" });
// order:
//   { ok: true; result: OrderResult }
// | { ok: false; status: "failed"; error: ErrorValue<TChildErrors> }

const timed = await ctx.children.attached.processOrder({ orderId: "o-1" }, { timeout: 60 });
// timed additionally includes { ok: false; status: "timeout" }
```

The entry returned by `ctx.children.attached.X(args)` is **await-only** in the parent body — do not assign it and call `channels.*.send` before the prescribed completion path. To push messages while the child runs, pass the entry into `ctx.scope` and use the scope handle's `channels.*.send`, then observe the outcome with `ctx.join`.

```typescript
const outcome = await ctx.children.attached.processOrder({ orderId: "o-1" });
// outcome: { ok: true; result: ... } | { ok: false; status: "failed"; error: ... }

await ctx.scope(
  "cancelable",
  { order: ctx.children.attached.processOrder({ orderId: "o-1" }) },
  async (ctx, { order }) => {
    order.channels.cancel.send({ reason: "user-cancelled" }); // buffered; void
    return ctx.join(order);
  },
);
```

Attached children are not independently terminable business objects. If the parent workflow is externally terminated, the attached subtree is torn down as part of the parent lifecycle; the parent does not resume with a child-level `terminated` result. Termination remains visible at root boundaries: root workflow handles and detached child workflow handles.

#### Inside a scope

The scope body receives `AttachedChildWorkflowScopeHandle<W, …>` for each attached child entry passed in: **`channels.X.send`** is available here, and completion is observed with **`ctx.join(handle)`** (not `await handle` on this surface — see §`ctx.join` below).

```typescript
await ctx.scope(
  "process",
  { order: ctx.children.attached.processOrder({ orderId: "o-1" }) },
  async (ctx, { order }) => {
    order.channels.cancel.send({ reason: "timeout-soon" });
    return ctx.join(order);
  },
);
```

#### Detached starts

`ctx.children.detached.X(args, opts)` is a buffered start. It returns a `ForeignWorkflowHandle<W>` synchronously. The handle exposes `channels.X.send` and `idempotencyKey`; it is not awaitable from the parent.

#### Search and introspection — unified shape

Every queryable namespace in the system shares the same shape: a direct-access `.get(id)` that constructs a handle without fetching, plus predicate-based `find` and `count`.

```typescript
interface QueryableNamespace<
  THandle,
  TQueryNamespaces extends Record<string, SearchNamespaceRecord>,
  TRow extends RowNamespaceRecord,
  TId,
> {
  // Identity grounding — synchronous; no I/O. Row data via fetchRow or find+fields.
  get(id: TId): THandle;

  // Predicate-based query — zero or more handles. Omit predicate for full scoped set.
  find(
    query?: (q: SearchQuery<TQueryNamespaces>) => SearchQueryNode,
    opts?: FindOptions<TQueryNamespaces>,
  ): FindResult<THandle>;
  find<F extends FieldsMask<TRow>>(
    query: (q: SearchQuery<TQueryNamespaces>) => SearchQueryNode,
    opts: FindOptions<TQueryNamespaces> & { fields: F },
  ): FindResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>;

  count(
    query: (q: SearchQuery<TQueryNamespaces>) => SearchQueryNode,
    opts?: CountOptions,
  ): Promise<number>;
}
```

`.get(id)` constructs a handle synchronously; existence is surfaced lazily via `fetchRow() → TRow | undefined`. `find(query?, opts?)` returns every matching handle (use `limit` to bound scans). Cardinality checks (e.g. "exactly one") are caller-owned.

`FindResult<T>` is `Promise<readonly T[]>`. Predicate callbacks may return literal `true` for an unconditional match within namespace scope (`WHERE TRUE`), or omit the predicate entirely via the optional overloads on `find` / `count`.

There are no "subset handles" with curated bulk operations. The handle returned by `find` is the canonical handle for that entity; bulk operator actions are expressed by mapping over the array.

Globally addressable workflows are looked up by decoded **identity** (Part 17): `.get(identity: InferWorkflowIdentityOutput<W>)`. The `find` / `count` shape is unaffected.

##### Row prefetch and `fetchRow`

Every entity has a flat row of scalar columns (`status`, timestamps, ids, definition names, etc.). JSONB columns (`args`, `result`, `metadata`, `info`, `payload`) are also row columns from a fetch perspective — they are fetched as whole opaque values and projected client-side.

A queryable handle exposes:

```typescript
interface FetchableHandle<TRow> {
  fetchRow<TRaw>(session: OperatorSession<TRaw>, opts?: FetchRowOptions<TRow>): Promise<TRow | undefined>;
  fetchRow<TRaw, F extends FieldsMask<TRow>>(
    session: OperatorSession<TRaw>,
    opts: FetchRowOptions<TRow> & { readonly fields: F },
  ): Promise<Pick<TRow, ProjectedKeys<TRow, F>> | undefined>;
}

interface FetchRowOptions<TRow> {
  readonly fields?: FieldsMask<TRow>;
}
```

Omit `fields` to fetch the entire row. With `fields`, only the listed columns are projected (`Pick<Row, keys>`).

When a query method (`find`) is called with a `fields` option, the engine prefetches those columns into a `.row` field on each yielded handle:

```typescript
type HandleWithRow<H, TRow> = H & { readonly row: TRow };
```

A handle without a prefetched row has no `.row` field — operators must call `.fetchRow(...)` to read row data. A handle with a prefetched row has `.row: Pick<Row, ProjectedKeys<...>>` populated at query time.

`.fetchRow(...)` always re-fetches. It does not consult `.row`; it does not modify `.row`. The prefetched `.row` is the snapshot at query time; `.fetchRow` is a fresh read on demand.

##### Field mask and projection types

```typescript
// A mask of row columns to project.
type FieldsMask<TRow> = {
  readonly [K in keyof TRow]?: true;
};

// The keys explicitly set to true in the mask. Used by Pick<TRow, ProjectedKeys<TRow, F>>.
type ProjectedKeys<TRow, F extends FieldsMask<TRow>> =
  Extract<{
    [K in keyof F]: F[K] extends true ? K : never;
  }[keyof F], keyof TRow>;
```

The mask is type-validated: only keys of `TRow` are accepted. The engine additionally validates the mask at runtime, rejecting unknown keys with a clear error in case the type system was bypassed.

##### Common query/option types

```typescript
interface FindOptions<TNamespaces extends Record<string, SearchNamespaceRecord>> {
  readonly sort?: readonly SearchSort<TNamespaces>[];
  readonly limit?: number;
}

interface CountOptions {
  // reserved
}
```

Per the operator session model (Part 19), snapshot/command IO methods take `session` as the first argument. `find(session, query?, opts?)` and `count(session, query?)` follow the unified namespace shape; entity-specific options (`fields`, `sort`, `limit`, `strategy`) remain in trailing option bags where applicable.

#### External introspection of children

Operators inspect a parent workflow's children through two namespaces on the parent's external workflow handle, named after the property keys under which the child workflow definitions were registered in `defineWorkflow.children`:

```typescript
// Attached children — non-lifecycle operator handle, parent-scoped only.
workflowInstance.children.attached.<name>:
  QueryableNamespace<
    AttachedChildWorkflowExternalHandle<W>,
    { args: InferWorkflowArgs<W>; metadata: WorkflowMetadata },
    AttachedChildWorkflowId<W>
  >;

// Detached children — full external handle, parent-scoped (also visible globally).
// Identity-based lookup uses decoded identity (Part 17).
workflowInstance.children.detached.<name>:
  Omit<QueryableNamespace<WorkflowHandleExternal<W>, …, never>, "get"> & {
    get(identity: InferWorkflowIdentityOutput<W>): WorkflowHandleExternal<W>;
  };
```

The two namespaces return **different handle types** because attached and detached children have different operator-action surfaces.

##### Detached children

`workflowInstance.children.detached.<name>.find(...)` returns a regular `WorkflowHandleExternal<W>` — the same handle type that `client.workflows.<name>.find(...)` returns. The detachedness is metadata: `parent_step_id` is set, but the child is otherwise globally addressable, has its own `idempotencyKey`, and supports the full operator action surface (`sigkill()`, `sigterm()`, `skip(result, opts?)`).

Detached children also appear in the global `client.workflows.<def>.find(...)` query. The parent-scoped namespace is a convenience: it pre-filters to detached children of this parent. `.get(identity)` is available there too, though its semantics narrow correspondingly: "this detached child must be an immediate child of this parent AND match this identity."

##### Attached children

`workflowInstance.children.attached.<name>.find(...)` returns an `AttachedChildWorkflowExternalHandle<W>` — **non-lifecycle** (not "read-only" in the blanket sense): no terminal-action verbs and no `idempotencyKey`, while `channels` / streams / events / `fetchRow` remain on the type where declared.

```typescript
interface AttachedChildWorkflowExternalHandle<W extends AnyWorkflowHeader>
  extends FetchableHandle<WorkflowRow<InferWorkflowArgs<W>, InferWorkflowResult<W>>> {
  readonly id: AttachedChildWorkflowId<W>;

  attributes: { /* declared attributes; per-instance reads */ };
  streams:    { /* declared streams; per-instance reads */ };
  events:     { /* declared events; per-instance wait/isSet */ };
  channels:   { /* declared channels; send fan-in to this instance */ };
}
```

The handle exposes `.fetchRow(...)` for reading row fields (status, args, result, halt, timestamps, etc.) — see the unified shape above.

**Allowed on this surface:** introspection and child-declared primitives (`channels`, streams, events, attributes as typed), `fetchRow`, branded `id`.

**Not on this surface:** `idempotencyKey`; `sigkill()`, `sigterm()`, `skip(...)` — attached children are parent-coupled; operators do not drive independent lifecycle termination on this handle.

The `id` is `AttachedChildWorkflowId<W>` — branded with the child's workflow header so attached child ids are not interchangeable with regular workflow ids or compensation block ids:

```typescript
type AttachedChildWorkflowId<W extends AnyWorkflowHeader> = string & {
  readonly __brand: "AttachedChildWorkflowId";
  readonly __workflow: W;
};
```

Internally an `AttachedChildWorkflowId<W>` is a workflow id; externally that is not exposed.

##### Global queries filter out attached children

`client.workflows.<def>.find(...)` returns only globally addressable workflows. Workflow rows where `attached = TRUE` are filtered out at query time. To inspect attached children, operators must go through the parent's `children.attached.<name>` namespace.

This matches the actor-model framing: attached children are subordinate to a parent workflow's lifecycle and not independently addressable in the system.

#### Workflow row, query namespaces, and `WorkflowHandleExternal`

Workflows have one row shape and a fixed set of query namespaces:

```typescript
// Flat scalar columns of a workflow row.
interface WorkflowRow<TArgs, TResult, TMetadata> {
  readonly id: string;
  readonly definitionName: string;
  readonly idempotencyKey: string | null;
  readonly status: WorkflowStatus;
  readonly args: TArgs;
  readonly result: TResult | null;
  readonly metadata: TMetadata;
  readonly error: WorkflowErrorEnvelope | null;
  readonly attached: boolean;
  readonly isCompensation: boolean;
  readonly compensationStepName: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly failedAt: Date | null;
  readonly terminatedAt: Date | null;
  readonly scheduledAt: Date | null;
  readonly deadlineAt: Date | null;
}

// Single query template. Predicates see one row-shaped scope where scalar
// columns and JSONB-backed fields are siblings.
type WorkflowWhereTemplate<TArgs, TResult, TMetadata> =
  WorkflowRow<TArgs, TResult, TMetadata>;
```

`WorkflowHandleExternal<W>` extends the fetchable handle with operator-action verbs and the full primitive plane:

```typescript
interface WorkflowHandleExternal<W extends AnyWorkflowHeader>
  extends FetchableHandle<WorkflowRow<InferWorkflowArgs<W>, InferWorkflowResult<W>, InferWorkflowMetadata<W>>> {
  readonly id: string;

  // Operator-action verbs. Per Part 19, snapshot/command IO takes session first.
  sigkill<TRaw>(session: OperatorSession<TRaw>): Promise<{ /* terminal outcome */ }>;
  sigterm<TRaw>(session: OperatorSession<TRaw>): Promise<{ /* terminal outcome */ }>;
  skip<TRaw>(
    session: OperatorSession<TRaw>,
    ...args: InferWorkflowResult<W> extends void
      ? [opts?: SkipOptions]
      : [result: InferInput<InferWorkflowResult<W>>, opts?: SkipOptions]
  ): Promise<{ /* skip outcome */ }>;

  // Primitive plane. Snapshot/command IO takes session first (Part 19).
  attributes: { /* declared attributes; reads */ };
  streams:    { /* declared streams; reads */ };
  events:     { /* declared events; wait/isSet */ };
  channels:   { /* declared channels; send (write) only */ };

  halts: {
    list<TRaw>(session: OperatorSession<TRaw>): Promise<readonly HaltRecord[]>;
  };

  // Per-parent-scoped namespaces.
  children: {
    attached: { /* see "External introspection of children" */ };
    detached: { /* see "External introspection of children" */ };
  };
  compensations: {
    steps:    { /* see Part 2 */ };
    requests: { /* see docs/primitives/requests.md */ };
  };
}
```

#### `client.workflows.<def>` surface

The root client namespace gains the same `find` / `count` surface, alongside `.start` and the identity-based `.get` direct-access methods:

```typescript
client.workflows.<def>:
  & {
      start<TRaw>(
        session: OperatorSession<TRaw>,
        opts: WorkflowStartOptions<W>,
      ): Promise<WorkflowHandleExternal<W>>;

      // Identity-based lookup. Synchronous, query-grounding, no I/O.
      get(identity: InferWorkflowIdentityOutput<W>): WorkflowHandleExternal<W>;
    }
  & Omit<
      QueryableNamespace<
        WorkflowHandleExternal<W>,
        WorkflowWhereTemplate<InferWorkflowArgs<W>, InferWorkflowResult<W>, InferWorkflowMetadata<W>>,
        WorkflowRow<InferWorkflowArgs<W>, InferWorkflowResult<W>, InferWorkflowMetadata<W>>,
        never
      >,
      "get"
    >;
```

`.get(identity)` is the fast path when the operator already knows the instance identity (Part 17). `find(session, query?, opts?)` returns every matching handle; singleton checks are caller-owned (e.g. `find(session, …, { limit: 2 })` and inspect `length`).

`find` excludes attached children automatically (`row.attached = TRUE` rows are filtered out). Detached children appear in `find` results because they are globally addressable workflows.

#### `client.compensations` — global compensation search

Compensation block instances are searchable at three levels:

| Level | Path | Keyed by |
|---|---|---|
| Client global (L1) | `client.compensations.{requests\|steps}.<definitionName>` | `defineRequest.name` / `defineStep.name` |
| Workflow bulk (L2) | `workflowHandle.compensations.{requests\|steps}.<slot>` | workflow slot |
| Instance link (L3) | `requestHandle.compensation` / step dispatch handle (future) | parent forward invocation |

L1 namespaces aggregate compensable definitions across all workflows registered on the client (same machinery as `client.requests`). Only compensable definitions appear; non-compensable slots are absent at the type level.

```typescript
client.compensations.requests.<requestDefinitionName>:
  RequestCompensationNamespaceExternal<...>;  // same shape as L2

client.compensations.steps.<stepDefinitionName>:
  CompensationBlockNamespaceExternal<...>;    // same shape as L2
```

##### Worked example: query, prefetch, and act in one session

```typescript
await client.session(async (session) => {
  const halted = await client.workflows.processOrder.find(
    session,
    ({ status, createdAt }) => and(eq(status, "halted"), lt(createdAt, sevenDaysAgo)),
    { fields: { id: true, args: true, idempotencyKey: true } },
  );

  for (const wf of halted) {
    await wf.skip(
      session,
      { orderId: wf.row.args.orderId, status: "expired-cleanup" },
      { strategy: "sigkill" },
    );
  }
});
```

Predicate uses direct row fields (`status`, `createdAt`) from one scope template; prefetch hoists `id`, `args`, `idempotencyKey` into `wf.row` so no extra reads happen during the loop; the entire scan + N skips run in one session scope.

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

// Channel-send surface for handles that may fan in to a running workflow's channels.
// In workflow execution, sends are buffered until batch commit.
interface ChannelSendSurface<W extends AnyWorkflowHeader> {
  readonly channels: {
    [K in keyof InferWorkflowChannels<W> & string]: {
      send(payload: InferInput<InferWorkflowChannels<W>[K]>): void;
    };
  };
}

// Direct `ctx.children.attached.X(...)`: await-only entry for the result union.
// Args are the first call argument; invocation options omit `idempotencyKey`.
type AttachedChildWorkflowEntry<W extends AnyWorkflowHeader, TAwaited> =
  AwaitableEntry<TAwaited>;

// `ctx.scope` body mirror for an attached child: awaitable entry + channels; use `ctx.join`.
type AttachedChildWorkflowScopeHandle<W extends AnyWorkflowHeader, TAwaited> =
  AttachedChildWorkflowEntry<W, TAwaited> & ChannelSendSurface<W>;

// `children.detached.X(...)` and `external.X.get(...)`: channel-send + idempotencyKey; not awaitable.
interface ForeignWorkflowHandle<W extends AnyWorkflowHeader>
  extends ChannelSendSurface<W> {
  readonly idempotencyKey: string;
}

interface ChildWorkflowAccessor<W extends AnyWorkflowHeader> {
  (
    args: InferInput<InferWorkflowArgsSchema<W>>,
  ): AttachedChildWorkflowEntry<
    W,
    | { ok: true; result: InferWorkflowResult<W> }
    | { ok: false; status: "failed"; error: ErrorValue<InferWorkflowErrors<W>> }
  >;
  (
    args: InferInput<InferWorkflowArgsSchema<W>>,
    opts: AttachedChildWorkflowInvocationOptions<W> & { timeout: StepBoundary },
  ): AttachedChildWorkflowEntry<
    W,
    | { ok: true; result: InferWorkflowResult<W> }
    | { ok: false; status: "failed"; error: ErrorValue<InferWorkflowErrors<W>> }
    | { ok: false; status: "timeout" }
  >;
}

type DetachedChildWorkflowAccessor<W extends AnyWorkflowHeader> = (
  args: InferInput<InferWorkflowArgsSchema<W>>,
  opts: DetachedChildWorkflowInvocationOptions<W>,
) => ForeignWorkflowHandle<W>;

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

- Workflow `execute` sees workflow primitives, workflow steps/requests/children, and workflow `errors`.
- Compensation `undo` sees only primitives and dependencies declared on the step's `compensation` field; it has no workflow `ctx.errors`.

### No shared compensation namespace

Compensation block primitive state is declared on the compensable step and materialized per invocation. The current workflow-wide compensation hooks and ad hoc `addCompensation` registration do not survive as public API surfaces.

| Primitive        | Workflow body              | Step compensation block instance         |
| ---------------- | -------------------------- | ---------------------------------------- |
| `ctx.channels`   | workflow instance channels | compensation block instance channels     |
| `ctx.streams`    | workflow instance streams  | compensation block instance streams      |
| `ctx.events`     | workflow instance events   | compensation block instance events       |
| `ctx.attributes` | workflow instance attrs    | compensation block instance attributes   |
| `ctx.errors`     | workflow-declared errors   | absent (use the `result` schema instead) |

The workflow body cannot read or write compensation block primitives, and a compensation block cannot read or write workflow body primitives unless coordination is exposed through an explicit global primitive such as a request, topic, queue, or child workflow.

### Definition-time dependency filtering

Compensation can depend on non-compensable steps and requests; queues, topics, and child workflows. It cannot depend on compensable steps or compensable requests, preventing recursive compensation chains. Child workflows are exempt from the non-compensable filter — each child owns its own internal compensation lifecycle.

---

## Part 7: Scopes and Structured-Concurrency Consumption

> **Extracted → [docs/scopes.md](docs/scopes.md)** (canonical). This section now lives in its own document; the design there is authoritative.


---

## Part 8: Database Schema

The execution model is unified. There is no separate hierarchy for compensation: a compensation block instance **is a child workflow** of a special sibling workflow (the base compensation workflow) that the engine creates alongside every execution workflow. The same `workflow`, `step`, and `promise` tables represent every execution path in the system.

### The two-workflow pairing

When a caller starts a workflow, the engine creates **two** `workflow` rows:

1. **Execution workflow.** `is_compensation = FALSE`. Carries the user-facing `idempotency_key`, `args`, `result`, etc. Its body is the user's `defineWorkflow.execute` callback. Its `compensation_workflow_id` points at the sibling base compensation workflow.
2. **Base compensation workflow.** `is_compensation = TRUE`. No `idempotency_key`. Its body is engine-internal: a sequencer that promotes registered compensation block instances eagerly (FIFO at settle decisions) or as LIFO unwind on execution-workflow failure. Each compensation block instance is dispatched from its body as a `start_child_workflow` step.

A compensation block instance is then a regular child workflow of the base compensation workflow. It has the same shape as any other workflow — a `workflow` row, step rows, primitive rows, halts, and so on. The "compensation block" abstraction dissolves at the storage layer; the compensation step name and the origin step in the execution workflow are recorded on the child workflow row itself.

This means the schema needs:

- A single `workflow` table (carrying enough columns to discriminate execution vs base-compensation vs compensation-block-instance).
- A single `step` table (including step rows for the base compensation workflow's sequencing body and for each compensation block instance's `undo` body).
- A single `promise` table.
- A single set of primitive tables (`workflow_attributes`, `channel_message`, `stream_record`, `workflow_event`) — each row is owned by its `workflow_id`. Per-compensation-block primitives are simply primitives of that compensation block's workflow row.

There is no `branch` table, no `scope` table, no `child_workflow` join table, no parallel `compensation_block_*` hierarchy. Scope nesting is encoded by `step.parent_step_id` self-references. The parent → child workflow relationship is encoded by `workflow.parent_step_id`.

### `workflow`

```sql
CREATE TABLE workflow (
  id                            TEXT PRIMARY KEY,
  definition_name               TEXT NOT NULL,
  idempotency_key               TEXT,
  seed                          TEXT,
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

  -- Parent workflow linkage. Root workflows (started by the client) have NULL.
  -- Child workflows have parent_step_id pointing at the parent's start_child_workflow
  -- or start_detached step.
  parent_step_id                BIGINT REFERENCES step(id),
  attached                      BOOLEAN NOT NULL DEFAULT FALSE,

  -- Compensation pairing. Set on every execution workflow at creation time.
  compensation_workflow_id      TEXT REFERENCES workflow(id),

  -- Compensation discrimination.
  is_compensation               BOOLEAN NOT NULL DEFAULT FALSE,

  -- Compensation block instance metadata. Populated when this workflow is a
  -- compensation block instance (i.e., a child workflow of a base compensation
  -- workflow). NULL on execution workflows and on the base compensation workflow.
  compensation_step_name        TEXT,
  compensation_origin_step_id   BIGINT REFERENCES step(id),
  compensation_info             JSONB,

  CONSTRAINT chk_workflow_status CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'terminated', 'halted', 'skipped')
  ),
  CONSTRAINT chk_workflow_idempotency CHECK (
    -- Globally addressable workflows (root execution workflows + detached children)
    -- require an idempotency_key. Attached children, base compensation workflows,
    -- and compensation block instances must have NULL.
    CASE
      WHEN is_compensation = FALSE AND attached = FALSE THEN idempotency_key IS NOT NULL
      ELSE idempotency_key IS NULL
    END
  ),
  CONSTRAINT chk_workflow_compensation_pairing CHECK (
    -- Execution workflows must point at a compensation workflow.
    -- Compensation workflows do not have a compensation_workflow_id of their own.
    (is_compensation = FALSE AND compensation_workflow_id IS NOT NULL)
    OR (is_compensation = TRUE AND compensation_workflow_id IS NULL)
  ),
  CONSTRAINT chk_workflow_compensation_metadata CHECK (
    -- Compensation block instances populate compensation_step_name + origin_step_id.
    -- Base compensation workflows and execution workflows do not.
    (compensation_step_name IS NULL AND compensation_origin_step_id IS NULL)
    OR (compensation_step_name IS NOT NULL AND compensation_origin_step_id IS NOT NULL
        AND is_compensation = TRUE AND parent_step_id IS NOT NULL)
  ),
  UNIQUE (definition_name, idempotency_key)
);
```

The status enum gains `'skipped'` for compensation block instances that were operator-skipped (Part 3, Part 12). Execution workflows never reach `'skipped'`; the CHECK constraint can be tightened with a partial index if desired.

### `step`

```sql
CREATE TABLE step (
  id                BIGSERIAL PRIMARY KEY,
  workflow_id       TEXT NOT NULL REFERENCES workflow(id),
  parent_step_id    BIGINT REFERENCES step(id),         -- enclosing execute_scope step; NULL = body top-level
  ordinal           INT NOT NULL,
  type              TEXT NOT NULL,
  definition_name   TEXT,                               -- step / request / scope / channel / etc. name as appropriate
  args              JSONB,
  promise_id        BIGINT,
  result            JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Top-level body and scope-nested step ordinals are independent unique sequences.
CREATE UNIQUE INDEX step_top_level_ordinal_uniq
  ON step (workflow_id, ordinal) WHERE parent_step_id IS NULL;
CREATE UNIQUE INDEX step_scoped_ordinal_uniq
  ON step (parent_step_id, ordinal) WHERE parent_step_id IS NOT NULL;
```

A scope is a step with `type = 'execute_scope'`. Steps that "live inside" that scope reference it via `parent_step_id`. There is no separate `scope` row — the structural marker and the scope's identity are the same row. `step.definition_name` carries the scope's name when `type = 'execute_scope'`.

Steps belonging to the workflow body have `workflow_id = <execution workflow id>` and `parent_step_id = NULL` (or pointing at an `execute_scope` step in the same workflow). Steps belonging to a compensation block instance's `undo` body have `workflow_id = <compensation block instance id>` — i.e., they are owned by that workflow row exactly like any other workflow's steps. There is no `compensation_block_id` on `step`; `step.workflow_id` already identifies which workflow the step belongs to, and `workflow.compensation_step_name` (when set) identifies that workflow as a compensation block instance.

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

Promises are owned by a step. The step's `workflow_id` transitively determines which workflow's body sequence the promise participates in. Promise sequence numbers (Part 1.5) are scoped per workflow body, not globally — two different workflows (execution and compensation, sibling compensation block instances, etc.) have independent `sequence_no` spaces.

### Foreign-key cycles

`workflow.parent_step_id → step.id`, `workflow.compensation_origin_step_id → step.id`, and `step.workflow_id → workflow.id` form a cycle resolvable with `ALTER TABLE` constraints after table creation, as in the original design. `step.parent_step_id → step.id` is a self-reference (no cycle, just nullable).

### Primitive tables

Workflow primitive tables are unchanged in shape. Each row is owned by `workflow_id`. Per-compensation-block primitives are just primitives of that compensation block's workflow row.

```sql
CREATE TABLE workflow_attributes (
  workflow_id    TEXT NOT NULL REFERENCES workflow(id),
  attribute_name TEXT NOT NULL,
  value          JSONB NOT NULL,
  version        BIGINT NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, attribute_name)
);
```

`channel_message`, `stream_record`, and `workflow_event` follow the same pattern. There is no `compensation_block_id` discriminator on these tables: when an operator queries `(await workflowInstance.compensations.steps.bookHotel.find(..., { limit: 1 }))[0]?.attributes.progress.get()`, the engine resolves that to a `workflow_id` (the compensation block instance) and reads from `workflow_attributes` directly.

### Request compensation tables

Request compensation invocations are observable but lightweight. They have no per-instance primitives and no durable subordinate execution tree.

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

### Halt table

Halts are uniform across all workflow kinds (Part 3). One table covers them all:

```sql
CREATE TABLE halt (
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

  CONSTRAINT chk_halt_status CHECK (status IN ('pending', 'resolved', 'skipped'))
);
```

There is no `branch_halt` table because there are no branches. There is no separate `compensation_block_halt` table because compensation block instances are themselves workflows — their halts are halts on a workflow row, indistinguishable at the table layer.

The differences between operator-facing halt resolution surfaces (`workflowInstance.halts.find(...)` for execution-workflow halts, `workflowInstance.compensations.steps.X.find(...)` for compensation-block-instance halts) are implemented as views/queries over this single table, joined against the `workflow` row's kind columns (`is_compensation`, `compensation_step_name`) when needed.

Implementation details below this level — indexes, retention, and exact FK choices — should be finalized with the public API implementation.

### Step type catalog

The persisted `step.type` values, with their model categories from Part 1.2, are:

| Type                             | Category         | Creates promise | Has `promise_id` | Suspends body |
| -------------------------------- | ---------------- | --------------- | ---------------- | ------------- |
| `start_step`                     | dispatched       | yes             | no               | yes           |
| `start_child_workflow`           | dispatched       | yes             | no               | yes           |
| `send_request`                   | dispatched       | yes             | no               | yes           |
| `await_promise`                  | dispatched-await | no              | **yes**          | yes           |
| `execute_scope`                  | structural       | no              | no               | no            |
| `sleep`                          | awaitable wait   | yes             | yes              | yes           |
| `sleep_until`                    | awaitable wait   | yes             | yes              | yes           |
| `channel_receive`                | awaitable wait   | yes             | yes              | yes           |
| `channel_receive_nowait`         | awaitable read   | no              | no               | no (flush)    |
| `patch_check`                    | awaitable read   | no              | no               | no (flush)    |
| `stream_write`                   | buffered         | no              | no               | no            |
| `event_set`                      | buffered         | no              | no               | no            |
| `attribute_set`                  | buffered         | no              | no               | no            |
| `register_compensation_instance` | buffered         | no              | no               | no            |
| `promote_compensation_instance`  | buffered         | no              | no               | no            |
| `queue_enqueue`                  | buffered         | no              | no               | no            |
| `topic_publish`                  | buffered         | no              | no               | no            |
| `channel_send`                   | buffered         | no              | no               | no            |
| `start_detached`                 | buffered         | no              | no               | no            |

Every awaitable wait or dispatch produces a promise, and the `await_promise` step references it via `promise_id`. The promise already knows its origin (`promise.step_id` → the `start_*` step). The await step just says "I'm parked here until this promise resolves." Buffered operations are synchronous calls in the public API — they buffer step records that are committed in the next batch transaction. Awaitable reads (`receiveNowait`, `patch`) trigger a flush of the buffer before reading from committed state.

The same catalog applies to every workflow body: execution workflows, the base compensation workflow's engine-internal sequencer body, and compensation block instance `undo` bodies. Definition-time filtering (Part 6) constrains which step types can appear in a compensation block instance's body — for example, dispatching a compensable step or request is rejected at compile time.

`register_compensation_instance` and `promote_compensation_instance` rows record `compensation_workflow_id` (the child workflow id of the compensation block instance) on the step. `register_compensation_instance` corresponds to the engine creating the child workflow row inside the base compensation workflow; `promote_compensation_instance` corresponds to the engine dispatching that child workflow's body.

---

## Part 9: Search Query Refactoring

### Goal

The existing `src/types/search-query.ts` implements a typed query AST parameterized over two hardcoded namespaces: `engine` and `meta`. Generalizing it enables reuse for topic consumer metadata filters, dead-letter payload filters, and any future query surfaces.

### Task

```typescript
type Predicate = /* opaque */
type WhereScope<TRowTemplate> = /* recursive row-shaped mirror */
type QueryPredicate<TRowTemplate> = (scope: WhereScope<TRowTemplate>) => Predicate

type SearchSort<TTemplate> = {
  path: ComparablePath<TTemplate>;
  direction: "asc" | "desc";
}
```

Public predicate authoring is function-based and row-scoped:

```typescript
import { and, eq, gt, every, some } from "natalia/search";

find(({ args, metadata, createdAt }) =>
  and(
    eq(args.provider, "metamask"),
    eq(metadata.tenant.id, "acme"),
    gt(createdAt, yesterday),
    every(args.providers, (provider) => eq(provider, "metamask")),
    some(args.providers, (provider) => eq(provider, "bybit")),
  ),
);
```

No author-facing namespace split (`row`, `args`, `metadata`, etc.) and no
public builder object.

### Type model

```typescript
type WorkflowWhereTemplate<TArgs, TResult, TMetadata> =
  WorkflowRow<TArgs, TResult, TMetadata>;
```

Field capability is decided only by each declared property type:

| Field type | Equality | Range | Sort | Quantifiers |
| ---------- | -------- | ----- | ---- | ----------- |
| `string` / `number` / `bigint` / `Date` | yes | yes (homogeneous only) | yes (homogeneous only) | n/a |
| `boolean` | yes | no | no | n/a |
| heterogeneous union (e.g. `string \| number`) | yes | no | no | n/a |
| arrays | membership via `contains` | no | no | `every` / `some` |

Legacy public builder/node aliases are removed.

---

## Part 10: Queues

> **Extracted → [docs/primitives/queues.md](docs/primitives/queues.md)** (canonical). This section now lives in its own document; the design there is authoritative.

---

## Part 11: Requests

> **Extracted → [docs/primitives/requests.md](docs/primitives/requests.md)** (canonical). This section now lives in its own document; the design there is authoritative.

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
  async (record, { signal }) => {
    await ingestToWarehouse(record, { signal });
  },
  {
    neverExpire: true,
    filter: (q) =>
      q.and(q.metadata.tenantId.eq("acme"), q.payload.type.eq("booking.confirmed")),
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
      callback: async (event, { signal }) => {
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

The consumer callback receives the decoded record and opts `{ signal: AbortSignal }`. The signal fires after `retryPolicy.timeoutSeconds` per attempt. Failed attempts are written to a `topic_consumer_attempt` table (FK on consumer + record) — only failures are recorded, successful processing advances the offset. All retry policy fields are in seconds (durable, persisted to DB).

**Metadata filter (`filter`):**

Optional. A predicate builder callback that receives a `SearchQuery<{ meta: TMetadata; payload: TPayload }>` builder with namespaces for both the topic's metadata and payload schemas. Only records matching the filter are delivered to the handler — non-matching records are skipped (offset advances past them without invoking the handler).

```typescript
filter: (q) => q.metadata.tenantId.eq("acme");
filter: (q) =>
  q.and(q.metadata.type.eq("booking.confirmed"), q.payload.amount.gte(100));
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

- `onConsumeError.callback` — receives the event and opts `{ signal: AbortSignal }` (fires on consumer shutdown). Returns `"skip"` or `"halt"`.
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
  async (records, { signal }) => {
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
    filter: (q) => q.metadata.tenantId.eq("acme"),
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
      callback: async (event, { signal }) => {
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

**Introduce `Failure` (base) and `Attempt extends Failure` (with `attemptNumber: number`).** The previous single `StepExecutionError` type leaked the step origin into a type shared across all attempt-bearing contexts. Splitting into `Failure` (the base shape — a single captured throw with no attempt context) and `Attempt extends Failure` (a retried-operation record with a 1-indexed `attemptNumber`) keeps the field set reusable across contexts: `Attempt` is what `AttemptAccessor` exposes for steps, queue handlers, request handlers, and topic consumers; `Failure` is the bare data shape underneath.

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

The same rules apply when producing `Attempt` records (for steps, queue handlers, request handlers, topic consumers — one row per attempt). `Attempt` is `Failure` plus a 1-indexed `attempt: number`.

| Thrown value             | `type`                                                                                           | `message`        | `details`           |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------- | ------------------- |
| `AttemptError` instance  | `.type`                                                                                          | `.message`       | `.details`          |
| `ExplicitError` instance | `"ExplicitError"` (or `null` for non-`AttemptError` `Error` subclasses, depending on serializer) | `.message`       | `{ code, details }` |
| `Error` instance         | `.constructor.name`                                                                              | `.message`       | `null`              |
| `string`                 | `null`                                                                                           | the string       | `null`              |
| anything else            | `null`                                                                                           | `String(thrown)` | `null`              |

### `Failure` (base record — captured single throw)

A plain data record representing a single captured throw. Used as the base shape that `Attempt` extends; not exposed as a workflow-facing throw type in the new error model.

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
  readonly attemptNumber: number;
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

### Request handlers

See **[docs/primitives/requests.md](./docs/primitives/requests.md)**. Forward and compensation handlers `return` to report outcome; `throw ctx.errors.X(..., { manual })` chooses manual escalation vs retry. Retry exhaustion moves the invocation or compensation block to `manual`.

### Queue handlers

See **[docs/primitives/queues.md](./docs/primitives/queues.md)**. Queue handlers return `void` and use `throw ctx.errors.X(..., { deadLetter })` for intentional outcomes (`handler_reject` vs retry).

### `UnrecoverableError` for topic handlers

A throwable `Error` subclass that signals the engine to skip retries and proceed directly to the exhaustion path. Used when a **topic** consumer determines that retrying will not produce a different outcome.

```typescript
class UnrecoverableError extends Error {
  constructor(message?: string);
}
```

**Topic consumers (single-record and batch):** throwing `UnrecoverableError` triggers `onConsumeError` with `event.type === "attemptsExhausted"` immediately, bypassing remaining retry attempts. The attempt is recorded normally in `topic_consumer_attempt`. The `onConsumeError` callback then decides: `"skip"` or `"halt"`.

```typescript
// Topic consumer — skip an unprocessable record immediately
client.registerTopicConsumer(auditTopic, "analyticsConsumer", async (record, { signal }) => {
  if (!isSupportedEventType(record.payload.type)) {
    throw new UnrecoverableError(`Unsupported event type: ${record.payload.type}`);
  }
  await ingestToWarehouse(record, { signal });
}, { retryPolicy: { ... } });
```

**Distinction from regular exceptions (topics):**

| Thrown value         | Topic behavior                                         |
| -------------------- | ------------------------------------------------------ |
| Regular `Error`      | Retry per `retryPolicy`                                |
| `UnrecoverableError` | `onConsumeError("attemptsExhausted")` immediately      |
| `AttemptError`       | Retry per `retryPolicy` (structured details persisted) |

`UnrecoverableError` is NOT applicable to request handlers — see [docs/primitives/requests.md](./docs/primitives/requests.md). It is NOT applicable to queue handlers — use `throw ctx.errors.X(..., { deadLetter: true })` instead (see [docs/primitives/queues.md](./docs/primitives/queues.md)).

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

Described in [docs/primitives/queues.md](./docs/primitives/queues.md). `enqueue` opts accept `delay` (`number | Date | 0`) and `ttl` (`number | Date | null`).

### Workflow starts

`ScheduledDeliveryOptions` is intersected into root workflow start options, attached child workflow entry options, and detached child workflow start options. Compensation block child-workflow dependencies use the same child workflow option shapes as workflow execution.

```typescript
const handle = await client.workflows.order.start({
  idempotencyKey: "order-jan-2027",
  scheduledAt: new Date("2027-01-10T08:00:00Z"),
  args: { destination: "Paris", customerId: "cust-123" },
});

ctx.children.detached.followUp(
  { parentId: ctx.instanceId },
  { idempotencyKey: "follow-up-next-day", delaySeconds: 86400 },
);
```

The deadline clock starts from creation time, not scheduled start. If `delaySeconds >= deadlineSeconds`, the engine raises an error.

---

## Part 17: Workflow identity

> User-facing guide: [`docs/primitives/workflow-identity.md`](docs/primitives/workflow-identity.md)

### Problem

Globally addressable workflow instances need a stable external identifier for deduplication, lookup, and operator tracing. Letting callers pass an optional opaque `idempotencyKey` string at start conflates **domain identity** (what the instance means) with **storage key** (how the row is indexed), and makes derived-from-args workflows awkward.

### Solution

Every `defineWorkflow` / `defineWorkflowHeader` declares a mandatory **`identity`** block:

```typescript
defineWorkflow({
  name: "orderWorkflow",
  args: z.object({ orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  identity: {
    schema: z.object({ tenantId: z.string(), orderId: z.string() }),
    deriveIdentity: ({ args, metadata }) => ({
      tenantId: metadata.tenantId,
      orderId: args.orderId,
    }),
    deriveIdempotencyKey: (id) => `${id.tenantId}:order:${id.orderId}`,
  },
  async execute(ctx) {
    return { ok: true };
  },
});
```

| Field | Required | Role |
| --- | --- | --- |
| `schema` | yes | JSON object schema for the identity value used at `.get(...)` and inside `deriveIdempotencyKey`. |
| `deriveIdempotencyKey` | yes | Maps decoded identity → persisted `idempotency_key` column. |
| `deriveIdentity` | no | When present, engine builds identity from start `args` + `metadata`; callers must not pass `identity` at start. |

`identity` is **header-locked**: it cannot be overridden in `defineWorkflowHeader(...).extend({ … })`.

### Start options

Start / execute never accept `idempotencyKey`. The conditional start shape:

```typescript
type IdentityStartField<W> =
  HasDeriveIdentity<W> extends true
    ? { readonly identity?: never }
    : { readonly identity: InferWorkflowIdentityInput<W> };

type WorkflowStartOptions<W> =
  StartWorkflowOptions<InferWorkflowArgsInput<W>, InferWorkflowMetadataInput<W>>
  & IdentityStartField<W>;
// idempotencyKey omitted from StartWorkflowOptions
```

**With `deriveIdentity`:**

```typescript
await client.workflows.order.start(session, {
  args: { orderId: "o-123" },
  metadata: { tenantId: "acme" },
});
```

**Without `deriveIdentity`:**

```typescript
await client.workflows.audit.start(session, {
  args: undefined,
  metadata: undefined,
  identity: { key: "nightly-2026-06-29" },
});
```

The same rules apply to `client.workflows.<def>.execute(...)`, `ctx.externalWorkflows.<name>.start(...)`, and compensation `undo` bodies calling external workflows.

### Lookup (`.get`)

Identity-based lookup always uses the **decoded identity object** (`InferWorkflowIdentityOutput<W>`), never a raw idempotency key string:

```typescript
client.workflows.order.get({ tenantId: "acme", orderId: "o-123" });
ctx.externalWorkflows.partner.get({ token: "partner-1" });
```

Handles and row reads still expose **`idempotencyKey: string`** as the derived persistence field (output of `deriveIdempotencyKey`). `find` / `count` predicates may filter on that column.

### Attached children

Attached child starts are unchanged: args as the first call argument, options bag with explicit `metadata` (and optional `seed`, retention, deadlines). **No `identity` field** — attached children are not globally addressable. Independent roots use `externalWorkflows` or client `.start` / `.get`.

```typescript
type AttachedChildWorkflowStartOptions<W> = {
  metadata: InferWorkflowMetadataInput<W>;
  seed?: string;
  // no identity, no idempotencyKey
} & ScheduledDeliveryOptions;
```

### Client accessor shape (identity era)

```typescript
client.workflows.<def>:
  & {
      start<TRaw>(
        session: OperatorSession<TRaw>,
        opts: WorkflowStartOptions<W>,
      ): Promise<WorkflowHandleExternal<W>>;

      execute<TRaw>(
        session: OperatorSession<TRaw>,
        opts: WorkflowStartOptions<W>,
      ): Promise<WorkflowResult<...>>;

      // Identity-based lookup. Synchronous, query-grounding, no I/O.
      get(identity: InferWorkflowIdentityOutput<W>): WorkflowHandleExternal<W>;
    }
  & Omit<QueryableNamespace<...>, "get">;
```

The same `.get(identity)` shape applies to `ctx.externalWorkflows.<name>.get(...)` inside workflow logic.

`HasDeriveIdentity<W>` replaces the former `HasIdempotencyKeyFactory<W>` discriminator for start-option typing.

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
  execute: async (ctx) => {
    const booking = await flightAPI.book(
      ctx.args.destination,
      ctx.args.passengerId,
      { signal: ctx.signal },
    );
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

- **Call sites** (write side) accept `InferInput`: `ctx.steps.X(args)`, `ctx.children.attached.X(args)`, `ctx.errors.X(message, details)`, `channel.send(data)`, `stream.write(data)`. The developer provides the serializable form.
- **Callbacks** (read side) receive `InferOutput`: step `execute(ctx)` with `ctx.args`, queue/request handlers with domain fields on `ctx`, step `undo(ctx)` with `ctx.args` and `ctx.info`, request compensation handlers with `ctx.payload` and `ctx.forward`, `deriveIdentity({ args, metadata })` and `deriveIdempotencyKey(identity)`. The engine deserializes from the database and validates through the schema, producing the decoded form.
- **External results** (read side) are typed as `InferOutput`: step results, workflow results, error details, operation results and compensation info. The external caller receives the decoded form.

For most schemas (no transforms), `InferInput` and `InferOutput` are identical and the distinction is invisible. The distinction only matters for schemas with transforms (e.g., `z.string().datetime()` where input is `string` and output is `Date`).

---

## Part 19: Operator Session Model

### Goal

Every read or write operation against the engine's durable state from **operator/client code** must run inside an explicit **session** so callers can compose snapshot reads, queries, and mutations into one unit of work. Sessions are provided by a **storage driver** attached to the client; the driver defines what `session.raw` is and what `session.capabilities` mean on that backend.

### Core types

```typescript
interface SessionCapabilities {
  readonly atomic: boolean;
  readonly isolated: boolean;
}

type SessionOrigin = "engine" | "adopted";

interface OperatorSession<TRaw, TOrigin extends SessionOrigin = SessionOrigin> {
  readonly capabilities: SessionCapabilities;
  readonly origin: TOrigin;
  readonly raw: TRaw;
}

interface StorageDriver<TRaw> {
  session<R>(fn: (session: OperatorSession<TRaw, "engine">) => Promise<R>): Promise<R>;
  adoptSession(raw: TRaw): OperatorSession<TRaw, "adopted">;
}

interface WorkflowClient<TWfs, TDriver extends StorageDriver<any>> {
  readonly driver: TDriver;
  session<R>(fn: (session: OperatorSession<InferSessionRaw<TDriver>, "engine">) => Promise<R>): Promise<R>;
  adoptSession(raw: InferSessionRaw<TDriver>): OperatorSession<InferSessionRaw<TDriver>, "adopted">;
  // … workflows, requests, queues, compensations
}
```

`TRaw` is the driver-specific handle for an **already-open transaction** (or equivalent). For engine-managed sessions, the driver opens `raw` before invoking the callback. For adopted sessions, `session.raw === raw` passed to `adoptSession`; the caller owns finalize.

Postgres is the **reference semantics** (`atomic: true`, `isolated: true`). Other backends implement the same interface with honest capabilities.

User-facing documentation: [`docs/operator-sessions.md`](./docs/operator-sessions.md).

### Two session entry points

**Engine-managed** — `client.session(fn)`. The driver acquires a session, runs the callback, and finalizes on success or throw.

**Adopted** — `client.adoptSession(foreignRaw)` when operator scripts run inside a foreign transaction. Natalia does not commit or roll back adopted sessions.

Adopt accepts only an **already-started transaction** (or driver equivalent), not a bare pool connection.

### Two classes of operator IO

**Snapshot / command** — session is the **first argument** (required):

- `find(session, query?, opts?)`, `count(session, query?)`
- `fetchRow(session, opts?)`
- `start(session, opts)`, operator verbs (`skip(session, …)`, `sigkill(session)`, …)
- `readNowait(session, offset, default?)`, `isSet(session)`, `channels.X.send(session, data)`, dead-letter actions, request `resolve(session, …)`, etc.

**Watch** — **no session**; `{ signal? }` only:

- stream blocking `read(offset, { signal? })`
- `events.X.wait({ signal? })`
- `handle.wait({ signal? })`

Watch IO must not hold a transactional scope while blocking. Implementation pattern: short snapshot → release → wait → short snapshot to deliver.

### Scope rules

- Workflow body `ctx.*` does **not** take a session — engine-owned batch commit (Part 1.4).
- Handler-runtime read namespaces (`CompensationInfo.attempts`, queue/request retention `ctx.attempts`, …) do **not** take a session.
- Sync `.get(id)` is identity grounding only — no I/O, no session.

### Worked example: read-decide-act

```typescript
await client.session(async (session) => {
  const halted = await client.workflows.processOrder.find(
    session,
    ({ status, createdAt }) =>
      and(eq(status, "halted"), lt(createdAt, sevenDaysAgo)),
    { fields: { id: true, args: true } },
  );

  for (const wf of halted) {
    await wf.skip(
      session,
      { orderId: wf.row.args.orderId, status: "expired-cleanup" },
      { strategy: "sigkill" },
    );
  }
});
```

### Composing across multiple entities

```typescript
await client.session(async (session) => {
  const order = client.workflows.processOrder.get("order-jan-2027");
  const orderRow = await order.fetchRow(session, {
    fields: { status: true, args: true },
  });

  if (orderRow?.status === "halted") {
    const blocks = await order.compensations.bookHotel.find(
      session,
      ({ status }) => eq(status, "halted"),
    );
    for (const block of blocks) {
      await block.skip(session, { kind: "abandoned" });
    }
    await order.skip(
      session,
      { orderId: orderRow.args.orderId, status: "force-cleared" },
      { strategy: "sigkill" },
    );
  }
});
```

### Foreign transaction interop

```typescript
await foreignDb.transaction(async (foreignTx) => {
  const session = client.adoptSession(foreignTx);
  await nataliaHandle.skip(session, result);
  await foreignDb.insert(auditTable).values({ ... });
});
```

### Driver validation

The engine rejects `adoptSession` handles from a different driver instance or incompatible type at runtime.

---

## Summary of Public API Changes

### New `defineWorkflow` options

```typescript
defineWorkflow({
  channels:              { [name: string]: JsonSchemaConstraint },
  streams:               { [name: string]: JsonSchemaConstraint },
  events:                { [name: string]: true },
  attributes:            { [name: string]: JsonSchemaConstraint },
  queues:                { [name: string]: QueueDefinition<M> },
  requests:              { [name: string]: RequestDefinition<Req, Res> },
  topics:                { [name: string]: TopicDefinition<R, Meta> },
  errors:                { [name: string]: JsonSchemaConstraint | true },
  steps:                 { [name: string]: StepDefinition },
  children: {
    attached:            { [name: string]: WorkflowDefinition },
    detached:            { [name: string]: WorkflowDefinition },
  },
  identity: {
    schema: JsonObjectSchemaConstraint,
    deriveIdempotencyKey: (identity: InferOutput<schema>) => string,
    deriveIdentity?: (input: { args: InferOutput<TArgs>; metadata: InferOutput<TMetadata> }) => InferOutput<schema>,
  },
});
```

Removed or replaced from current workflow definitions:

- `state` as a workflow-level mutable state factory.
- `beforeCompensate` / `afterCompensate` hooks.
- inline branch closures inside `ctx.scope`.
- `defineWorkflow.branches` and `ctx.branches.X(...)` — concurrent isolated work is expressed via child workflows orchestrated under `ctx.scope` / `ctx.all` / etc.

New workflow-definition surface:

- `errors` declares typed workflow business failures.

### `defineStep` changes

```typescript
defineStep({
  name: string,
  args: JsonSchemaConstraint,
  result: JsonSchemaConstraint,
  execute: (ctx: StepExecuteContext) => Promise<Result>,
  retryPolicy?: RetryPolicyOptions,
  compensation?: {
    channels?:       { [name: string]: JsonSchemaConstraint },
    streams?:        { [name: string]: JsonSchemaConstraint },
    events?:         { [name: string]: true },
    attributes?:     { [name: string]: JsonSchemaConstraint },
    steps?:          { [name: string]: NonCompensableStepDefinition },
    requests?:       { [name: string]: NonCompensableRequestDefinition },
    queues?:         { [name: string]: QueueDefinition },
    topics?:         { [name: string]: TopicDefinition },
    children?: {
      attached?: { [name: string]: WorkflowDefinition },
      detached?: { [name: string]: WorkflowDefinition },
    },
    result?:         JsonSchemaConstraint,
    undo: (ctx: CompensationContext) => Promise<Result>,
  },
});
```

### Context changes

| Change                                                                                                                                                       | Details                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.steps.X(args, opts?)`                                                                                                                                   | Returns an awaitable entry. No builder chain. Timeout via `{ timeout }`.                                                                                     |
| `ctx.requests.X(payload, opts?)`                                                                                                                             | Returns an awaitable entry. Priority and timeout via options.                                                                                                |
| `ctx.children.attached.X(args, opts?)`                                                                                                                  | Attached child entry: **await-only** for the success/failure union (timeout adds a variant). `channels.X.send` only on `AttachedChildWorkflowScopeHandle` inside `ctx.scope`. |
| `ctx.children.detached.X(args, opts)`                                                                                                                        | Buffered start. Returns `ForeignWorkflowHandle<W>` (`channels.X.send`, `idempotencyKey`; not awaitable from the parent).                                      |
| `ctx.errors.X(message, details?)`                                                                                                                            | Factory functions for the current definition level's declared errors.                                                                                        |
| `ctx.queues.X.enqueue(payload, opts?)`                                                                                                                       | Sync buffered operation.                                                                                                                                     |
| `ctx.topics.X.publish(payload, opts?)`                                                                                                                       | Sync buffered operation.                                                                                                                                     |
| `ctx.attributes.X.set(value)`                                                                                                                                | Sync buffered operation.                                                                                                                                     |
| `ctx.scope(name, entries, body)`                                                                                                                             | Directly awaitable. Input is a top-level object whose properties can be entries, arrays/tuples, or maps.                                                     |
| `ctx.match(handles)`                                                                                                                                         | Async iterable keyed by top-level object properties; arrays add `index`, maps add `mapKey`. No handler form.                                                 |
| `ctx.join(handle, opts?)`                                                                                                                                    | Observes one handle; optional timeout only times out observation.                                                                                            |
| `ctx.all(name, entries)` / `ctx.first(name, entries)` / `ctx.atLeast(name, count, entries)` / `ctx.atMost(name, count, entries)` / `ctx.some(name, entries)` | Directly awaitable named structured-concurrency helpers over generalized entries. Success-oriented; helpers that can fail return helper-level `code` errors. |

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
- `Predicate`, `WhereScope`, `SearchQuery`, `SearchSort`.
- `DeadLetterId`, `DeadLetterRow`, `DeadLetterWhereTemplate`, `DeadLetterHandleExternal`, `DeadLetterNamespaceExternal`, `QueueNamespaceExternal`.
- `AttemptAccessor`, `Failure`, `Attempt`, `AttemptError`.
- `ExplicitError`, `ErrorValue`, `FailureInfo`.
- `CompensationInfo`, `CompensationBlockStatus`, `CompensationId`, `FindResult`, `FindOptions`, `CountOptions`.
- `FieldsMask`, `ProjectedKeys`, `HandleWithRow`, `FetchableHandle`.
- `WorkflowRow`, `WorkflowWhereTemplate`, `CompensationBlockRow`, `CompensationBlockWhereTemplate`, `RequestCompensationRow`, `RequestCompensationWhereTemplate`.
- `RequestCompensationInfo`, `RequestCompensationStatus`, `RequestCompensationInstanceId`.
- `StepBoundary`, `QueueHandlerDeclaredError`, `RequestHandlerDeclaredError`, `UnrecoverableError`.
- `ForeignWorkflowHandle`, `AttachedChildWorkflowEntry`, `AttachedChildWorkflowScopeHandle`, `AttachedChildWorkflowExternalHandle`, `AttachedChildWorkflowId`.
- `Unsubscribe`.
- `TopicRecord`.
- `RegisterTopicConsumerError`, `RegisterTopicConsumerErrorEvent`, `TopicConsumerAlreadyActiveError`, `TopicConsumerConsumeErrorEvent`.
- `ScheduledDeliveryOptions`.
- `OperatorSession`, `SessionCapabilities`, `StorageDriver`, `InferSessionRaw`.
- `SkipOptions`.
- `RetentionSetter`.

### Removed exports

- `WorkflowError`.
- `StepTimeoutError`.
- `StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`.
- `DurableHandle`, `AtomicResult`.
- `TimeoutInfo`, `StepFailureInfo`, `ChildWorkflowFailureInfo` callback-info types.
- `StepCompensationResult`, `RequestCompensationResult` closure-info types.
- `CompensationFailureInfo`.
- `FindUniqueResult`, `FindManyResult`, `FindManyOptions`, `FindUniqueOptions`.

### Breaking changes

#### Compensation

- Compensation moves from call sites to `defineStep.compensation` and `defineRequest.compensation`.
- Step compensation invocations become queryable compensation block instances. At the storage layer they are workflow rows; at the public API layer they remain addressable via `workflowInstance.compensations.steps.<step>` with their own per-instance primitives.
- Request compensation invocations are lightweight observable entities with manual-mode support.
- Compensation reports typed results by return value, not by throwing declared compensation errors.
- Compensation block halts are skippable per instance via `skip(result)` (no opts, no strategy choice).
- Workflow-level compensation hooks and ad hoc `ctx.addCompensation` cleanup registration are removed.

#### Operator actions on workflows

- Three terminal-action verbs are exposed on globally addressable workflows (root execution + detached children): `sigkill()` (abandon), `sigterm()` (cancel + run compensation), and `skip(result, { strategy? })` (set result + terminate via the chosen strategy; default `"sigterm"`).
- `skip` is the only result-setting verb; `sigkill` and `sigterm` do not set a result.
- Compensation block instances expose only `skip(result)` — single verb, no opts. The result is required (or zero-arg only when the compensation has no `result` schema, i.e. `TResult = void`). There is no separate `sigkill`; for compensation, `skip` IS abandonment with an operator-supplied result. They cannot be `sigterm`-ed.
- Attached child workflows expose **no** terminal-action verbs. Operators inspect them but do not terminate them. Their lifecycle is owned by the parent workflow body.
- The base compensation workflow is engine-managed and not exposed to operators.

#### Attached vs detached child workflows

- Attached children have no `idempotencyKey` on starts or on the operator handle and are not globally addressable. They appear only via `workflowInstance.children.attached.<name>.find`. The returned handle is `AttachedChildWorkflowExternalHandle<W>`: **non-lifecycle** (no `sigkill` / `sigterm` / `skip`), with introspection and typed `channels` / streams / events / `fetchRow` where declared.
- Detached children are real root workflows with an `idempotencyKey`, addressable both globally (`client.workflows.<def>.find`) and through `workflowInstance.children.detached.<name>` as a parent-scoped convenience. The returned handle is the standard `WorkflowHandleExternal<W>`.
- Global `client.workflows.<def>.find(...)` queries filter out workflow rows where `attached = TRUE`. Attached children never appear in the global view.

#### Search and introspection unified

- Every queryable namespace shares the same surface: `.get(id)` → handle (sync identity grounding); `find(query?, opts?)` → `Promise<readonly Handle[]>`; `count(query?, opts?)` → `Promise<number>`.
- `.get(id)` does no I/O. Row existence on a grounded handle is `fetchRow() → TRow | undefined`.
- `FindResult<T>` is `Promise<readonly T[]>`. Use `limit` to bound large scans; singleton checks are caller-owned (`find(..., { limit: 2 })`).
- `FindOptions<TWhereTemplate>` is parameterized by the same row-shaped predicate template, so sort paths and predicates are checked against one type (`SearchSort<TWhereTemplate>` from Part 9 — only homogeneous comparable paths are sortable).
- Subset handles (`CompensationBlockSubsetHandle`, `RequestCompensationSubsetHandle`) are removed. Bulk operator actions are expressed by mapping over `find` results.
- `client.workflows.<def>` adds `find(query, opts?)`, `count(query, opts?)` alongside `.start(...)` and `.get(identity)` (Part 17). Global `find` excludes attached children automatically.
- `client.compensations.{requests,steps}` adds global L1 compensation search keyed by definition `name`, aggregated across registered workflows. Workflow-scoped L2 remains on `workflowHandle.compensations.{requests,steps}` keyed by slot.
- `workflowInstance.compensations.steps.<step>`, `workflowInstance.compensations.requests.<request>`, and `workflowInstance.children.attached.<name>` expose `.get(id)` plus `find` / `count`.
- `client.workflows.<def>.get(identity)` and `ctx.externalWorkflows.<name>.get(identity)` look up by decoded identity. `HasDeriveIdentity<W>` controls whether start options require an explicit `identity` field. The same shape applies to `workflowInstance.children.detached.<name>.get(identity)`.

#### Row prefetch and `fetchRow`

- Per-field accessor methods on unique handles (`status()`, `args()`, `result()`, `info()`, `payload()`, `halt()`) are removed. They caused N+1 round trips and were ergonomically bad.
- Every fetchable handle exposes `fetchRow(session, opts?)` which returns `TRow | undefined`. Set `opts.fields` to project columns (`Pick<Row, keys>`); omit `fields` for the whole row.
- `find(session, query?, opts?)` accepts a `fields` option that prefetches listed columns into `.row` on each returned handle. Handles from sync `.get(id)` have no `.row`; use `fetchRow(session, { fields })` or `find(session, …, { fields })`.
- `.fetchRow` always re-fetches; it does not consult or modify `.row`. The prefetched `.row` is a snapshot at query time; `.fetchRow` is a fresh read on demand.
- JSONB columns (`args`, `result`, `metadata`, `info`, `payload`) are first-class row fields for `fetchRow` / prefetch — they are returned as whole opaque values.
- `RequestCompensationUniqueHandle.attempts` is a parent-scoped query namespace (not a row column).

#### Query predicates

- Predicate callbacks now receive one row-scoped `WhereScope<TRowTemplate>` object.
- Authoring uses functional combinators from `natalia/search` (`and`, `or`, `eq`, `gt`, `every`, `some`, ...).
- There is no public namespace split (`q.row`, `q.args`, `q.metadata`, etc.) and no public builder object.
- Scalar columns and JSON-backed fields are siblings on the same template; operator availability follows each field's declared type.

#### Operator session model

- `WorkflowClient<TWfs, TDriver extends StorageDriver<any>>` is constructed with a storage driver. `InferSessionRaw<TDriver>` is the adoptable/raw handle type.
- `client.session(fn)` and `client.adoptSession(raw)` are the only session entry points. Snapshot/command operator IO takes `session` as the **first argument**; watch IO (`streams.read`, `events.wait`, `handle.wait`) takes `{ signal? }` only.
- Workflow-internal `ctx.*` calls do not take a session — they run inside the engine's batch-commit transaction (Part 1.4).
- See Part 19 and [`docs/operator-sessions.md`](./docs/operator-sessions.md).

#### Halts

- A single `halt` table covers all workflow kinds. `compensation_block_halt` is removed.
- Halt status is `'pending' | 'resolved' | 'skipped'`.
- Halt resolution paths: patch + replay (auto-resolves), or `skip(...)` on the owning workflow (transitions halts to `'skipped'`). `sigkill` / `sigterm` leave halts as `'pending'` (or terminal-archived) but transition the workflow row to its terminal status. Attached children halt normally but do not have operator-driven resolution; the parent body's behaviour resolves them.

#### Branches removed

- The `branches` field on `defineWorkflow` and `defineStep.compensation` is removed.
- `ctx.branches.X(...)` is removed. Concurrent isolated work is modelled with child workflows orchestrated through `ctx.scope` / `ctx.all` / etc.
- `MAIN_BRANCH`, `BranchPathItem`, `BranchEntry`, `BranchHandle`, `BranchAccessor`, `BranchInstanceStatus`, `BranchHaltStatus`, `BranchErrors`, and the `start_branch` step type are removed.
- The `branch` database table is removed; the workflow body's sequential execution is implicit in step rows under `workflow.id`.
- Branch-instance external query handles (`workflowInstance.branches.X.find(...)`) are removed; the equivalent introspection for child workflows reuses existing handle types.

#### Errors

- `errors` is a new schema-declared failure surface for workflow definitions only (declared on `defineWorkflow`).
- `ctx.errors` exists on the workflow body context and on scope-body contexts (which share the workflow's errors).
- Compensation `undo` callbacks have no `ctx.errors`; they report typed outcomes through the optional `result` schema.

#### Call sites

- Public `.resolve(ctx)` is removed. Direct `await` is the terminal operation.
- Retry, timeout, and priority are call-time options.
- Timeout/failure recovery happens in sequential code by inspecting returned unions.
- Attached child workflows no longer expose a `terminated` in-workflow result.
- Detached child workflows remain separately terminable root workflow instances.

#### Structured concurrency

- `ctx.scope`, `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, and `ctx.some` are named scopes and accept a top-level object input.
- Scope input properties support single entries, arrays/tuples of entries, and maps of entries.
- `ctx.join(handle, { timeout })` is a non-cancelling observation timeout.
- `ctx.match` yields top-level object keys, with `index` for array/tuple properties and `mapKey` for map properties.

#### Attempts and serializable args

- `StepErrorAccessor` is renamed to `AttemptAccessor`.
- `Failure` is the base captured-throw record; `Attempt extends Failure` adds `attempt`.
- `AttemptAccessor.count` becomes async `count()`.
- Step `schema` is renamed to `result` and `args` is required.
- Step call sites use a single schema-validated object arg.
- Step records persist args for observability and compensation.

#### Engine and runtime

- The workflow body is a single sequential execution path; concurrency comes only from dispatched entries (steps, requests, child workflows). There is no user-facing concurrent execution path within a workflow body.
- Compensation is unified with execution at the storage layer: a compensation block instance is a regular workflow row (a child of the execution workflow's sibling base compensation workflow). The schema collapses to `workflow / step / promise / halt` plus the workflow primitive tables. There are no parallel `compensation_block_*` tables.
- Buffered operations remain synchronous and are committed in batch transactions.
- `receiveNowait` and `patch` trigger buffer flushes before reading committed state.
- Request handler manual escalation uses `throw ctx.errors.X(..., { manual: true })`; forward and compensation retry exhaustion and `manual: true` throws move to manual (see [docs/primitives/requests.md](./docs/primitives/requests.md)).
- Handler retry policies use seconds for durable persisted retry configuration; runtime retry policies use milliseconds.
- Search range comparisons and sorting are restricted to homogeneous comparable fields.


