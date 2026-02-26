# Durable Workflow Engine

A type-safe, Postgres-backed durable execution engine for TypeScript.

## What makes it special

- **A library, not a bible.** Gradual adoption, lightweight in-process durable execution without additional infrastructure.
- **Postgres backed.** No additional infra needed, only a Postgres instance.
- **Fully typed.** Everything is type safe thanks to standard schema support (Zod v4, etc.).
- **Callable thenable model.** Steps return `StepCall<T>` — a thenable you can await directly or chain builders on: `.compensate()`, `.retry()`, `.failure()`, `.complete()`. No `.execute()` / `.start()` split.
- **Closure-based structured concurrency.** Scope entries are plain `async () => T` closures. Collections (Array, Map) are supported natively for dynamic fan-out.
- **One compensation callback per handle.** Defined via `.compensate(cb)` builder. Full `CompensationContext` with structured concurrency.
- **The actor model.** Workflows are independent and decoupled from each other.
- **State is not stored.** Workflow state is derived from replay — keeps workflows modifiable.

## Philosophy

- **Happy path by default, explicit when needed** — Workflow code describes business intent, not error handling plumbing. The engine handles retries, compensation, and cleanup. `.failure(cb)` opts in to explicit error handling for individual operations.
- **Explicit over implicit** — No decorators, no global state, no magic.
- **Structured concurrency** — Every concurrent branch lives inside `ctx.scope()` using either a closure (`async () => ...`) or a direct thenable entry (`ctx.steps.x(...)`). Branches with compensated steps are compensated on exit; others are settled.
- **Sound compensation** — One callback per handle via `.compensate(cb)` builder. `{ complete, failure }` handler entries for explicit failure recovery. Virtual event loop for concurrent compensation execution.
- **Type safety** — Full TypeScript inference with standard schemas. Impossible states are unrepresentable.
- **Deterministic replay** — Global sequence ordering for reproducible execution.

## Core Concepts

### Steps

Durable, idempotent operations defined outside the workflow.

```typescript
const bookFlight = defineStep({
  name: "bookFlight",
  execute: async ({ signal }, destination: string, customerId: string) => {
    const res = await fetch("https://api.flights.com/book", { signal });
    return res.json();
  },
  schema: FlightBookingSchema,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});
```

**In `WorkflowContext`:** calling a step returns a `StepCall<T>` thenable. Await it directly (happy path — failure auto-terminates the workflow) or chain builders before awaiting:

```typescript
// Happy path — await directly
const flight = await ctx.steps.bookFlight("Paris", "cust-1");
// flight is { id: string, price: number } — the decoded result

// With compensation — callback ALWAYS runs if an attempt was made.
// The step is idempotent and side effects may have occurred even on failure.
const flight = await ctx.steps
  .bookFlight("Paris", "cust-1")
  .compensate(async (compCtx) => {
    // No status check — always attempt to cancel.
    await compCtx.steps.cancelFlight("Paris", "cust-1");
  });

// With retry override
const flight = await ctx.steps
  .bookFlight("Paris", "cust-1")
  .retry({ maxAttempts: 5, intervalSeconds: 3 });
```

**`.failure()` / `.complete()` — explicit error handling:** When you need to observe step failures without auto-terminating the workflow, chain `.failure(cb)`. Optionally `.complete(cb)` to transform the success result:

```typescript
// With .compensate() — failure handler receives failure.compensate()
const flightId = await ctx.steps
  .bookFlight("Paris", "cust-1")
  .compensate(async (compCtx) => {
    await compCtx.steps.cancelFlight("Paris", "cust-1");
  })
  .failure(async (failure) => {
    // Eagerly discharge — runs in compensation mode (SIGTERM-resilient)
    await failure.compensate();
    return null;
    // Or: don't call it — engine runs it at LIFO unwinding (safe default)
  })
  .complete((data) => data.id);

// Without .compensate() — failure handler receives plain StepFailureInfo
const carId = await ctx.steps
  .reserveCar("Paris", "dates")
  .failure(() => null)
  .complete((data) => data.id);
```

**In `CompensationContext`:** calling a step returns a `CompensationStepCall<T>` that resolves to `CompensationStepResult<T>` — a discriminated union that compensation code must handle gracefully.

```typescript
// Sequential compensation
const cancelResult = await compCtx.steps.cancelFlight("Paris", "cust-1");
if (!cancelResult.ok) {
  compCtx.logger.error("Failed to cancel flight", {
    reason: cancelResult.status,
    errors: await cancelResult.errors.all(),
  });
}

// Concurrent compensation with scope
await compCtx.scope(
  {
    cancel: async () => compCtx.steps.cancelFlight("Paris", "cust-1"),
    notify: async () =>
      compCtx.steps.sendEmail("customer@example.com", "Cancelled", "..."),
  },
  async ({ cancel, notify }) => {
    const cancelResult = await cancel; // CompensationStepResult<T>
    const notifyResult = await notify; // CompensationStepResult<T>
  },
);
```

`"terminated"` is NOT included in `CompensationStepResult` — the only way to terminate during compensation is SIGKILL, which tears down the process immediately.

Steps have no lifecycle control — they are function calls, not processes. They run to completion based on their retry policy and timeout.

### Structured Concurrency (`ctx.scope()`)

Every concurrent branch must exist within a **scope** — a lexical boundary that manages branch lifecycle. Entries support two forms:

- **Closure form** (`async () => T`) — full control for complex branch logic.
- **Shorthand form** (`PromiseLike<T>`) — pass step/child-workflow thenables directly for concise common cases.

Both forms can be mixed in the same scope. The scope callback receives awaitable `BranchHandle<T>` values.

```typescript
const winner = await ctx.scope(
  {
    // shorthand (no async wrapper)
    flight:
      ctx.steps
        .bookFlight("Paris", "cust-1")
        .compensate(async (compCtx) => {
          // No status check — compensation always runs if an attempt was made
          await compCtx.steps.cancelFlight("Paris", "cust-1");
        }),
    // closure form remains supported for complex logic
    hotel: async () =>
      ctx.steps
        .bookHotel(city, checkIn, checkOut)
        .compensate(async (compCtx) => {
          await compCtx.steps.cancelHotel(city, checkIn, checkOut);
        }),
  },
  async ({ flight, hotel }) => {
    // flight, hotel are BranchHandle<T> — await them or pass to select/forEach/map
    const sel = ctx.select({ flight, hotel });
    // for await yields data from each handle as it resolves.
    // Return on first to implement a race pattern.
    for await (const data of sel) {
      return data; // Scope exits → loser's compensation fires
    }
    throw new Error("All handles exhausted");
  },
);
```

The scope resolves to whatever the callback returns. Cleanup happens after the callback returns but before the scope's promise resolves.

**Dynamic fan-out with collections:** Scope entries can also be arrays or Maps for parallel dispatch over unknown-at-definition-time sets (each element can be a closure or direct thenable):

```typescript
// Build a Map of closures dynamically (closure form)
const providers = new Map<string, () => Promise<Quote>>();
for (const p of args.providerCodes) {
  providers.set(p, async () => ctx.steps.getQuote(p, args.destination));
}

const result = await ctx.scope(
  { flight: ctx.steps.bookFlight(...), quotes: providers }, // shorthand + closures mixed
  async ({ flight, quotes }) => {
    // flight: BranchHandle<Flight>
    // quotes: Map<string, BranchHandle<Quote>>
    const mapped = await ctx.map(
      { flight, quotes },
      {
        flight: { complete: (d) => d.id, failure: () => null },
        quotes: { complete: (d, innerKey) => d.price, failure: () => Infinity },
      },
    );
    // mapped.flight: string | null
    // mapped.quotes: Map<string, number>
    return mapped;
  },
);
```

### Scope Exit Behavior

The presence of a `.compensate()` builder determines what happens to unjoined branches when a scope exits:

| Condition                      | Branch has compensated steps | No compensated steps          |
| ------------------------------ | ---------------------------- | ----------------------------- |
| Normal exit (callback returns) | Compensation runs            | Settled (wait, ignore result) |
| Error exit (callback throws)   | Compensation runs            | Settled (wait, ignore result) |

### Compensation Model

Each handle has at most **one compensation callback**, registered via the `.compensate(cb)` builder before awaiting. The callback receives a full `CompensationContext`.

```typescript
const flight = await ctx.steps
  .bookFlight("Paris", "cust-1")
  .compensate(async (compCtx, result) => {
    // result: StepCompensationResult<T> — available if you need it, but
    // compensation should ALWAYS run regardless of result.status.
    //
    // Rationale: if any attempt was made, the remote system may have already
    // processed the request but failed to send the response (e.g. HTTP POST
    // that mutates state then errors on the response). The step is idempotent;
    // the compensation callback assumes at-least-once delivery semantics.
    await compCtx.steps.cancelFlight("Paris", "cust-1");
  });
```

Properties:

- **Full `CompensationContext`** — has steps, childWorkflows, channels, streams, events, scope, select, forEach, map.
- **Has access to the outcome** via `result` parameter — available if needed, but unconditional compensation is the safe default.
- **Pushed onto the LIFO compensation stack** at call time.
- **Virtual event loop** — when multiple compensation callbacks from the same scope need to run, the engine transparently interleaves their execution at durable operation `await` points for concurrency, while keeping each callback's code sequential.

#### `addCompensation()` (general purpose)

Available on `WorkflowContext` for non-step cleanup. Not available on `CompensationContext` (no nesting).

```typescript
ctx.addCompensation(async (compCtx) => {
  await compCtx.channels.notifications.send({ type: "rollback" });
});
```

### `.failure()` / `.complete()` — Explicit Failure Handling

The `.failure(cb)` builder on `StepCall` / `WorkflowCall` provides explicit failure handling without auto-terminating the workflow. Chain after `.compensate()` if needed — the failure handler receives `compensate()` for eager discharge when compensation was registered.

```typescript
// { complete, failure } pattern for forEach and map handlers
await ctx.forEach(
  { flight: flightHandle, hotel: hotelHandle },
  {
    flight: {
      complete: (data) => {
        ctx.state.flightId = data.id;
      },
      failure: async (failure) => {
        // failure: BranchFailureInfo with compensate() and dontCompensate()
        await failure.compensate(); // run callback + discharge from LIFO
        // OR:
        // failure.dontCompensate(); // discharge WITHOUT running the callback
      },
    },
    hotel: (data) => {
      ctx.state.hotelId = data.id;
    },
    // Plain function → failure crashes the workflow (happy-path default)
  },
);
```

**`BranchFailureInfo` — two discharge methods:**

- **`failure.compensate()`** — invokes the registered compensation callback, switches the context to compensation mode (SIGTERM-resilient), runs the callback to completion, then discharges it from the LIFO stack.
- **`failure.dontCompensate()`** — explicitly discharge the obligation WITHOUT running the compensation callback. Use when you know the failed operation had no observable side effects (e.g. a timeout before the request ever reached the server). Prevents unnecessary undo work.
- If neither is called, the compensation still runs at scope exit / LIFO unwinding (safe default).
- For `map` and `match`, the `failure` callback can return a fallback value.
- **Step failure info:** `StepFailureInfo` — `{ reason: "attempts_exhausted" | "timeout", errors: StepErrorAccessor }` — passed directly to `.failure(cb)` on a `StepCall`.
- **Child workflow failure info:** `ChildWorkflowFailureInfo` — discriminated union: `{ status: "failed", error: WorkflowExecutionError } | { status: "terminated", reason: WorkflowTerminationReason }` — passed to `.failure(cb)` on a `WorkflowCall`.

**Handler shapes for concurrency primitives:**

- `(data) => ...` — plain function. Receives successful data `T`. Failure crashes the workflow.
- `{ complete, failure }` — explicit handling for branch handles.

### Select (Concurrency Primitive)

The `select` primitive multiplexes multiple handles and yields events as they arrive. Two access patterns are available:

```typescript
// Inside a scope callback:
const sel = ctx.select({
  flight: flightHandle,
  hotel: hotelHandle,
  cancel: ctx.channels.cancel,
});
```

#### Primary: `for await...of`

The primary iteration surface. Yields `SelectDataUnion<M>` — the successful data values from all handles — until all handles are exhausted. Any branch failure **auto-terminates** the workflow (LIFO compensation fires).

```typescript
// Simple "process all" loop
for await (const data of sel) {
  ctx.logger.info("Handle resolved", { data });
}

// Race pattern — return on first value, scope cleans up the rest
for await (const data of sel) {
  return data;
}
```

Use `for await` when you want to process events as they arrive and failures are unrecoverable.

#### Lower-level: `.match()` — key-aware, one event at a time

Waits for the **first** event matching a provided handler map. Handlers can be plain functions or `{ complete, failure }` objects for branch handle keys. The optional second argument is a default handler for unhandled events.

Default handler forms:
- Plain function: happy path only (receives completion events only). Unhandled failures still terminate the workflow.
- `{ complete, failure }`: explicit handling for unhandled completion/failure events.

```typescript
// Drive a loop: one event per iteration, explicit failure recovery
while (sel.remaining.size > 0) {
  const result = await sel.match(
    {
      // { complete, failure } for explicit branch failure handling
      flight: {
        complete: (data) => ({ ok: true as const, id: data.id }),
        failure: async (failure) => {
          await failure.compensate();
          return { ok: false as const, id: null };
        },
      },
      // Channel handler — plain function (channels don't fail)
      cancel: (data) => ({ ok: false as const, id: null }),
    },
    // Optional default object — only for unhandled keys
    {
      complete: (event) => ({ ok: true as const, id: event.data.id }),
      failure: async (event) => {
        await event.failure.compensate();
        return { ok: false as const, id: null };
      },
    },
  );

  if (result.status === "exhausted") break;
  if (result.data.ok) return result.data.id;
}
```

`match()` overloads: handlers only, or handlers + default handler (plain function or `{ complete, failure }`).

#### Time-bounded step/child patterns (`scope + sleep`)

Workflow-internal APIs intentionally avoid timeout parameters for step/child waits.
Model time bounds explicitly by racing work against a durable sleep branch:

```typescript
// Step race: step result vs timer
const stepRace = await ctx.scope(
  {
    flight: ctx.steps.bookFlight(dest, customerId),
    timer: ctx.sleep(30).then(() => "timed_out" as const),
  },
  async ({ flight, timer }) => {
    const result = await ctx.select({ flight, timer }).match({
      flight: { complete: () => "booked" as const, failure: () => "timed_out" as const },
      timer: () => "timed_out" as const,
    });
    return result.status === "exhausted" ? "timed_out" : result.data;
  },
);

// Child workflow race: child completion vs timer
const childRace = await ctx.scope(
  {
    payment: ctx.childWorkflows.payment({
      id: "payment-1",
      args: { amount: 100, customerId: "cust-1" },
    }),
    timer: ctx.sleep(45).then(() => "timed_out" as const),
  },
  async ({ payment, timer }) => {
    const result = await ctx.select({ payment, timer }).match({
      payment: { complete: () => "completed" as const, failure: () => "timed_out" as const },
      timer: () => "timed_out" as const,
    });
    return result.status === "exhausted" ? "timed_out" : result.data;
  },
);
```

Use `sleepUntil` when your workflow works with explicit target instants:

```typescript
let nextRunAt = ctx.timestamp;
while (true) {
  nextRunAt += 10 * 60 * 1000;
  await ctx.sleepUntil(nextRunAt);
  await ctx.steps.runTick();
}
```

#### Remaining handles

```typescript
console.log(sel.remaining); // ReadonlySet<'flight' | 'hotel' | 'cancel'>
```

### Select Event Types (`HandleSelectEvent`)

Branch handles carry `status: "complete" | "failed"` discrimination. Channel handles carry data directly. Collection handles include an `innerKey`.

| Handle Type                     | Event Shape                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `BranchHandle<T>` (single)      | `{ key: K; status: "complete"; data: T }` or `{ key: K; status: "failed"; failure: BranchFailureInfo }`              |
| `BranchHandle<T>[]` (array)     | `{ key: K; innerKey: number; status: "complete"; data: T }` or `{ key: K; innerKey: number; status: "failed"; ... }` |
| `Map<K, BranchHandle<T>>` (map) | `{ key: K; innerKey: K; status: "complete"; data: T }` or `{ key: K; innerKey: K; status: "failed"; ... }`           |
| `ChannelHandle<T>`              | `{ key: K; data: T }`                                                                                                 |

`SelectableHandle` includes only `BranchHandle` variants and `ChannelHandle`. Streams and lifecycle events are not selectable in workflow-internal code — use the external API (`WorkflowHandleExternal`) for those.

`for await...of` on a `Selection<M>` yields `SelectDataUnion<M>` — the union of successful data types across all handles. Failed branch events auto-terminate the workflow when iterating; to handle failures explicitly, use `.match()` with `{ complete, failure }` handlers.

### forEach / map (Batch Processing)

Process all branch handles concurrently. Callbacks receive successful data `T` directly (plain function) or use `{ complete, failure }` for explicit failure handling.

Collection handles (Array, Map) pass `innerKey` as a second argument to callbacks.

```typescript
// forEach — { complete, failure } for flight, plain default for unhandled keys
await ctx.forEach(
  { flight: flightHandle, hotel: hotelHandle, car: carHandle },
  {
    flight: {
      complete: (data) => {
        ctx.state.flightId = data.id;
      },
      failure: async (failure) => {
        await failure.compensate();
      },
    },
  },
  // Plain default — only receives completion events for "hotel" | "car"
  (event) => {
    ctx.logger.info(`${event.key} completed`);
  },
);

// map — { complete, failure } for specific keys, default object for unhandled failures
// Return type mirrors collection structure: array → array, map → map
const ids = await ctx.map(
  { flight: flightHandle, hotel: hotelHandle, car: carHandle },
  {
    flight: {
      complete: (data) => data.id,
      failure: async (failure) => {
        await failure.compensate();
        return "FAILED"; // fallback value
      },
    },
    hotel: (data) => data.id,
  },
  {
    complete: (event) => event.data.id,
    failure: async (event) => {
      await event.failure.compensate();
      return "FAILED";
    },
  },
);
// ids: { flight: string, hotel: string, car: string }

// forEach with a Map collection — innerKey is the Map's key
await ctx.forEach(
  { quotes: quotesMap }, // Map<string, BranchHandle<Quote>>
  {
    quotes: {
      complete: (data, innerKey) => {
        ctx.state.quotes[innerKey] = data.price;
      },
      failure: (_failure, innerKey) => {
        ctx.logger.warn(`Quote failed for ${innerKey}`);
      },
    },
  },
);
```

### Child Workflows

Child workflow access is split by semantics:

- **`ctx.childWorkflows.*`** — structured invocation, lifecycle managed by parent.
- **`ctx.foreignWorkflows.*`** — message-only handles to existing workflow instances.
- Child starts also accept optional immutable `metadata` for audit/filtering.

This split is enforced at definition-time too:

```typescript
const checkoutWorkflow = defineWorkflow({
  name: "checkout",
  childWorkflows: {
    payment: paymentWorkflow, // callable as ctx.childWorkflows.payment(...)
  },
  foreignWorkflows: {
    campaign: campaignWorkflow, // handle via ctx.foreignWorkflows.campaign.get(id)
  },
  // ...
});
```

```typescript
// Sequential — childWorkflows call returns WorkflowCall<T>
const result = await ctx.childWorkflows
  .payment({
    id: `payment-${ctx.rng.paymentId.uuidv4()}`,
    metadata: { tenantId: "tenant-acme", correlationId: "req-42" },
    seed: "payment-seed-cust-123",
    args: { amount: 100, customerId: "cust-123" },
  })
  .compensate(async (compCtx, result) => {
    /* ... */
  });
// result is the decoded workflow result T directly

// Concurrent — via scope closure
const receiptId = await ctx.scope(
  {
    child: async () => {
      const result = await ctx.childWorkflows.payment({
        id: "payment-1",
        metadata: { tenantId: "tenant-acme" },
        seed: "payment-seed-1",
        args: { amount: 100, customerId: "cust-123" },
      });
      return result.receiptId;
    },
  },
  async ({ child }) => await child,
);

// Detached — pass detached: true in call options, no scope required
const notifier = await ctx.childWorkflows.emailCampaign({
  id: `campaign-${ctx.rng.campaignId.uuidv4()}`,
  metadata: { tenantId: "tenant-acme" },
  seed: "campaign-seed",
  args: { customerId: "cust-123" },
  detached: true,
  retention: {
    complete: 86400 * 7,
    failed: 86400 * 30,
    terminated: 86400 * 7,
  },
}); // → ForeignWorkflowHandle
await notifier.channels.commands.send({ type: "nudge" });
// The child runs independently — not terminated when parent fails

// Access an existing (non-child) workflow via foreign handle
const existing = ctx.foreignWorkflows.emailCampaign.get("campaign-existing-id");
await existing.channels.commands.send({ type: "nudge" });
```

**Detached option behavior on `childWorkflows`:**

- **Result mode** (default): call without `detached` (or with `detached: false`) and chain `.compensate()`, `.failure()`, `.complete()`.
- **Detached mode**: call with `detached: true` and await `ForeignWorkflowHandle` directly (no result builders).
- **Retention override**: detached child starts may set `retention`; attached child starts inherit retention from the parent.

**Engine-level handles (`WorkflowHandleExternal`) retain `sigterm()` and `sigkill()`** — these are operational concerns for engine callers.

**Signal semantics:**

- **SIGTERM**: Current step terminates → `beforeCompensate` hook → compensations (LIFO) → `afterCompensate` hook. NOOP if already compensating.
- **SIGKILL**: Immediate termination. No compensation, no hooks.

**Execution result vs compensation lifecycle (important):**

- `execute(...)` and compensation belong to the same workflow instance, but they run in different phases/contexts.
- As soon as `execute(...)` reaches a terminal workflow status (`complete`, `failed`, or `terminated`), that status/result is observable to workflow result listeners.
- If compensation is needed, it runs asynchronously after the terminal execute outcome has been recorded.
- Compensation progress is observable separately through lifecycle events (`compensating`, `compensated`) rather than by delaying `complete/failed/terminated`.

### Cron-Like Workflows

Use `ctx.schedule(cron, timezone?)` to model recurring jobs as durable workflow logic.

Why this works in a durable/replayable model:

- `schedule.sleep()` yields deterministic tick metadata (`scheduledAt`, `nextScheduledAt`, `secondsUntilNext`, `index`) computed from schedule math.
- The scheduler workflow can safely replay and regenerate the same tick sequence.
- Detached child workflows can use `deadlineUntil: tick.nextScheduledAt`; if `deadlineUntil` is already before the workflow's current timestamp at start, the workflow is terminated immediately (`deadline_exceeded`) and user code/effects do not run.
- Detached children can override `retention` independently, so scheduler and job lifecycles are decoupled.
- You can set a very small `retention.terminated` window for detached jobs so late/missed ticks are garbage-collected quickly.

```typescript
const schedule = ctx.schedule("0 9 * * 1-5", "America/New_York");

for await (const tick of schedule) {
  // Step-level deadline tied to this schedule window
  await ctx.steps
    .sendNotification("ops@example.com", `Starting tick ${tick.index}`)
    .retry({
      maxAttempts: 5,
      intervalSeconds: 10,
      deadlineUntil: tick.nextScheduledAt,
    });

  // Detached child job with independent retention policy
  await ctx.childWorkflows.dailyReport({
    id: `daily-report-${tick.index}`,
    args: { reportDate: tick.scheduledAt.toISOString() },
    detached: true,
    deadlineUntil: tick.nextScheduledAt,
    retention: {
      complete: 86400 * 7,
      failed: 86400 * 30,
      terminated: 60, // aggressively GC instantly-terminated late ticks
    },
  });
}
```

See `src/examples/cron-scheduler.example.ts` for a complete end-to-end example.

### CompensationContext vs WorkflowContext

Both extend a shared `BaseContext` with channels, streams, events, patches, sleep, rng, logger, timestamp, and date.

**`WorkflowContext`** (happy-path):

- Steps: calling a step returns `StepCall<T>` — chain `.compensate()`, `.retry()`, `.failure()`, `.complete()` before awaiting
- Child workflows: `ctx.childWorkflows.*` returns `WorkflowCall<T>` by default, or `ForeignWorkflowHandle` when called with `{ detached: true }`
- Foreign workflows: `ctx.foreignWorkflows.*` returns `ForeignWorkflowHandle` (channels.send only)
- Has `scope()`, `select()`, `forEach()`, `map()`, `addCompensation()`
- Concurrency primitives support `{ complete, failure }` handlers

**`CompensationContext`** (defensive, full structured concurrency):

- Steps: calling a step returns `CompensationStepCall<T>` — resolves to `CompensationStepResult<T>` (must handle ok/!ok)
- Child workflows: `ctx.childWorkflows.*` returns `CompensationWorkflowCall<T>` — resolves to `WorkflowResult<T>`
- Has `scope()`, `select()`, `forEach()`, `map()` — all with failures visible in result types
- No `addCompensation()` (prevents nesting)
- No `.compensate()` builders or `{ complete, failure }` handlers (can't nest compensations)
- All unjoined branches are settled on compensation scope exit

**Virtual event loop:** When multiple compensation callbacks from the same scope need to run, the engine transparently interleaves their execution at durable operation `await` points. Each callback looks like normal sequential code — the engine handles concurrency and determinism via global sequence ordering and advisory locks.

### Channels (Message Passing)

Async communication between workflows.

```typescript
// Inside workflow — receive blocks until a message arrives; returns T directly
const msg = await ctx.channels.payment.receive();
// msg is the decoded value (z.output<Schema>) — no wrapper

// Async iteration over channel messages
for await (const paymentMsg of ctx.channels.payment) {
  console.log(paymentMsg);
}

// Time-bounded receive: use ctx.sleep() + ctx.select() for an explicit race
const result = await ctx.scope(
  { payment: ctx.channels.payment.receive() }, // shorthand
  async ({ payment }) => {
    const sel = ctx.select({ payment });
    await ctx.sleep(300);
    // If payment hasn't arrived, scope exits and payment is settled
    for await (const data of sel) {
      return data; // payment message
    }
    return null; // timed out
  },
);

// From another workflow — send via foreign handle (fire-and-forget)
const handle = ctx.foreignWorkflows.order.get("order-123");
await handle.channels.payment.send({ amount: 100 });

// External — send with result
const sendResult = await engineHandle.channels.payment.send({ amount: 100 });
if (sendResult.ok) console.log("Sent");
```

### Streams (Append-Only Logs)

Output data for external consumers. Streams close implicitly when the workflow reaches a terminal state.

```typescript
// Inside workflow — write
const offset = await ctx.streams.progress.write({
  step: "payment",
  message: "Processed",
  timestamp: ctx.timestamp,
});

// External — iterator (uses AbortSignal for runtime cancellation)
const iter = handle.streams.progress.iterator(0);
while (true) {
  const record = await iter.read({ signal: AbortSignal.timeout(5_000) });
  if (record.ok) console.log(record.data);
  else if (record.status === "closed") break;
  else break; // timeout
}
```

### Events (Write-Once Flags)

Coordination signals with "never" semantics. After a workflow reaches a terminal state, all unset events are marked "never".

```typescript
// Inside workflow — set
await ctx.events.paymentReceived.set();

// External — wait
const result = await handle.events.paymentReceived.wait({
  signal: AbortSignal.timeout(60_000),
});
if (result.ok) {
  console.log("Event set!");
} else if (result.status === "never") {
  console.log("Workflow finished without setting this event");
} else if (result.status === "timeout") {
  console.log("Timed out");
}
```

### Lifecycle Events

Engine-managed events available on every workflow handle via `.lifecycle`:

| Event          | Set when                      | "Never" when                    |
| -------------- | ----------------------------- | ------------------------------- |
| `started`      | Workflow begins execution     | —                               |
| `sigterm`      | SIGTERM signal received       | Terminal without SIGTERM        |
| `compensating` | Compensation begins           | Workflow completes successfully |
| `compensated`  | All compensations finish      | Workflow completes successfully |
| `complete`     | Workflow returns successfully | Failed or terminated            |
| `failed`       | Workflow throws               | Completed or terminated         |

Terminal execute status and compensation are intentionally decoupled:

- `complete` / `failed` represent the terminal outcome of `execute(...)`.
- `compensating` / `compensated` represent asynchronous compensation progress after terminal outcome recording.
- Consumers that need post-compensation guarantees should wait on `lifecycle.compensated` in addition to checking the workflow result.

### State

State is NOT persisted — it's derived on replay. Provided as a factory function.

```typescript
const workflow = defineWorkflow({
  state: () => ({
    count: 0,
    items: [] as string[],
  }),

  async execute(ctx) {
    ctx.state.count += 1; // Mutable, replayed on recovery
  },
});

// Keep state factory dependency-free (no ctx/rng args)
const workflow = defineWorkflow({
  rng: { init: true },
  state: () => ({
    id: "",
  }),
  async execute(ctx) {
    // Derive RNG-dependent state in workflow logic where call order is explicit.
    ctx.state.id = ctx.rng.init.uuidv4();
  },
});
```

### Patches (Safe Workflow Evolution)

```typescript
const workflow = defineWorkflow({
  patches: {
    antifraud: true,          // Active — new workflows run this code path
    removeLegacyEmail: true,  // Active — new workflows skip legacy path
    requireSelfie: false,     // Deprecated — only old replaying workflows enter this
  },

  async execute(ctx) {
    // Callback form — adding new code
    const fraudResult = await ctx.patches.antifraud(async () => {
      return await ctx.steps.fraudCheck(args.flightId);
    }, null);

    // Boolean form — await patch accessor directly
    if (!(await ctx.patches.removeLegacyEmail)) {
      await ctx.steps.sendLegacyEmail(...);
    }
  },
});
```

### Deterministic RNG

Typed, deterministic random number generation declared upfront in the workflow definition.

```typescript
const workflow = defineWorkflow({
  rng: {
    txnId: true, // simple
    itemsShuffle: (category: string) => `items:${category}`, // parametrized
  },

  async execute(ctx) {
    const id = ctx.rng.txnId.uuidv4();
    const shuffled = ctx.rng.itemsShuffle("electronics").shuffle(products);
  },
});
```

Available methods on `DeterministicRNG`:

| Method                           | Description                     |
| -------------------------------- | ------------------------------- |
| `.uuidv4()`                      | Deterministic UUID              |
| `.int(min?, max?)`               | Integer in range [min, max]     |
| `.next()`                        | Float in [0, 1)                 |
| `.bool()`                        | Boolean (p = 0.5)               |
| `.chance(p)`                     | Boolean with custom probability |
| `.string({ length, alphabet? })` | Random string                   |
| `.pick(array)`                   | Random element                  |
| `.weightedPick(items)`           | Weighted random element         |
| `.shuffle(array)`                | Shuffled copy                   |
| `.sample(array, count)`          | Random sample                   |
| `.weightedSample(items, count)`  | Weighted random sample          |
| `.bytes(length)`                 | Random bytes                    |

### Error Observability

Failed steps and workflows expose detailed error information.

**`StepExecutionError`** — per-attempt error:

```typescript
interface StepExecutionError {
  readonly message: string;
  readonly type: string; // error class name
  readonly attempt: number; // 1-indexed
  readonly timestamp: number; // epoch ms
  readonly details?: Record<string, unknown>;
}
```

**`StepErrorAccessor`** — lazy, async-iterable over error history:

```typescript
interface StepErrorAccessor {
  last(): Promise<StepExecutionError>;
  all(): Promise<StepExecutionError[]>;
  [Symbol.asyncIterator](): AsyncIterableIterator<StepExecutionError>;
  reverse(): AsyncIterable<StepExecutionError>;
  readonly count: number;
}
```

**`WorkflowExecutionError`** — for failed child workflows (engine-level and compensation context):

```typescript
interface WorkflowExecutionError {
  readonly message: string;
  readonly type: string;
  readonly timestamp: number;
  readonly details?: Record<string, unknown>;
}
```

## Type System: Input vs Output

Every schema has **input** (encoded for DB) and **output** (decoded for runtime) types:

| Context                        | Type               | Reason           |
| ------------------------------ | ------------------ | ---------------- |
| Step execute **returns**       | `z.input<Schema>`  | Encoded to JSONB |
| Step call **resolves**         | `z.output<Schema>` | Decoded from DB  |
| Channel **send** accepts       | `z.input<Schema>`  | Saved to DB      |
| Channel **receive** returns    | `z.output<Schema>` | Decoded from DB  |
| Stream **write** accepts       | `z.input<Schema>`  | Saved to DB      |
| Stream **read** returns        | `z.output<Schema>` | Decoded from DB  |
| Workflow **execute** returns   | `z.input<Schema>`  | Saved to DB      |
| Workflow **getResult** returns | `z.output<Schema>` | Decoded from DB  |

## Result Types

### Workflow-Internal (happy-path model)

Step and child workflow calls in `WorkflowContext` resolve to `T` directly when awaited without a `.failure()` builder. Failure auto-terminates the workflow.

### Workflow-Internal (builder-based error handling)

`.failure(cb)` and `.complete(cb)` on `StepCall` / `WorkflowCall` let you handle outcomes explicitly. The call resolves to `T | TFail` where `TFail` is the `failure` callback's return type.

**`failure.compensate()` semantics (unified across all `failure` surfaces):**

- Calling it switches to compensation mode (SIGTERM-resilient), runs the callback to completion, discharges from LIFO.
- Not calling it → engine runs it after `failure` returns / at scope exit (safe default).
- Same mechanism in `match`/`forEach`/`map` failure handlers and `.failure()` builder.

### Compensation-Internal

`CompensationStepResult<T>` — steps inside `CompensationContext`:

```typescript
type CompensationStepResult<T> =
  | { ok: true; status: "complete"; data: T; errors: StepErrorAccessor }
  | {
      ok: false;
      status: "failed";
      reason: "attempts_exhausted" | "timeout";
      errors: StepErrorAccessor;
    };
```

No `"terminated"` — the only way to terminate during compensation is SIGKILL, which tears down the process immediately.

### Channel, Stream, Event Results

| Type                       | Success    | Failure Statuses                 | Notes                          |
| -------------------------- | ---------- | -------------------------------- | ------------------------------ |
| `ChannelSendResult`        | `sent`     | `not_found`                      | Engine-level send              |
| `StreamReadResult`         | `received` | `closed`, `timeout`, `not_found` | Engine-level random-access read |
| `StreamIteratorReadResult` | `record`   | `closed`, `timeout`              | Engine-level iterator read     |
| `EventWaitResult`          | `set`      | `never`, `timeout`               | Engine-level event wait        |
| `EventCheckResult`         | `set`      | `not_set`, `never`, `not_found`  | Engine-level non-blocking check |
| `SignalResult`             | `sent`     | `already_finished`, `not_found`  | Engine-level signal            |
| `SelectMatchResult`        | `matched`  | `exhausted`                      | Workflow-internal match result |

Workflow-internal `ChannelHandle.receive()` returns `T` directly — no wrapper type. Timeouts in workflow logic create temporal dependencies; model them explicitly using `ctx.sleep()` + `ctx.select()` races instead.

### Engine-Level Results

Engine-level types retain full result unions since engine callers need to handle all outcomes:

| Type                     | Success    | Failure Statuses                                              |
| ------------------------ | ---------- | ------------------------------------------------------------- |
| `WorkflowResult`         | `complete` | `failed` (with `error`), `terminated` (with `reason`)          |
| `WorkflowResultExternal` | `complete` | `failed` (with `error`), `terminated` (with `reason`), `timeout`, `not_found` |

`WorkflowTerminationReason` values: `"deadline_exceeded" | "terminated_by_signal" | "terminated_by_parent"`.

### Policy Scope Matrix

| Policy            | Applies To  | Purpose                                                                                     |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `retryPolicy`     | Steps only  | Controls retry attempts/backoff/step timeout before a **step** is considered failed.       |
| `deadlineSeconds` | Workflows   | Sets a runtime deadline for a **workflow**; expiry terminates with reason `deadline_exceeded`. |
| `retention`       | Workflows   | Controls how long terminal workflow records stay in DB before garbage collection.           |

Notes:
- Child workflows inherit retention from their parent by default.
- Detached child workflows can override retention at start-time with `retention` in call options.
- If `deadlineUntil` is already in the past at workflow start, the workflow terminates immediately with `deadline_exceeded`.
- For detached cron jobs, set a short `retention.terminated` to quickly GC late/missed runs that terminate immediately.
- Workflows are not retried as a unit; retry is step-scoped.
- Retention affects persistence lifecycle, not execution semantics.

### Timeout-Free Variants

Some external-facing blocking primitives exclude the `timeout` status when called without a timeout argument:

- External stream iterator: `read()` → `StreamIteratorReadResultNoTimeout<T>` (no `timeout` status)
- External stream reader: `read(offset)` → `StreamReadResultNoTimeout<T>` (no `timeout` status)
- External event: `wait()` without signal → `EventWaitResultNoTimeout` (no `timeout` status)

Workflow-internal blocking operations (`channels.receive()`, `select`, `sleep`) do not have timeout overloads. Use `ctx.sleep()` + `ctx.select()` races for time-bounded workflows.

## Visibility Rules

### Inside Workflow (`WorkflowContext`)

| Resource                     | Operations                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ctx.steps.*`                | `(args)` → `StepCall<T>` — chain `.compensate()`, `.retry()`, `.failure()`, `.complete()` before await |
| `ctx.channels.*`             | `.receive()` — blocks until message arrives; returns `T` directly                                      |
| `ctx.streams.*`              | `.write()`                                                                                             |
| `ctx.events.*`               | `.set()`                                                                                               |
| `ctx.childWorkflows.*`       | `(options)` → `WorkflowCall<T>` by default; supports optional `metadata`; with `detached: true` → `ForeignWorkflowHandle` |
| `ctx.foreignWorkflows.*`     | `.get(id)` → `ForeignWorkflowHandle` (channels.send only, fire-and-forget)                             |
| `ctx.patches.*`              | `await ctx.patches.name` → boolean, `(callback, default?)` → callback result or default                |
| `ctx.scope()`                | Structured concurrency boundary — accepts closures and collections                                     |
| `ctx.select()`               | Multiplex handles — `for await` (primary) or `.match()` (key-aware, `{ complete, failure }`)           |
| `ctx.forEach()`              | Process branch handles concurrently; `{ complete, failure }` handlers; collection-aware                |
| `ctx.map()`                  | Transform branch handle results; collection structure mirrored; `{ complete, failure }` handlers       |
| `ctx.addCompensation()`      | Register LIFO compensation callback                                                                    |
| `ctx.sleep(seconds)`         | Durable relative sleep                                                                                 |
| `ctx.sleepUntil(target)`     | Durable sleep until target `Date` / epoch milliseconds                                                |
| `ctx.rng.*`                  | Typed deterministic RNG streams                                                                        |
| `ctx.timestamp` / `ctx.date` | Deterministic time                                                                                     |
| `ctx.logger`                 | Replay-aware logger                                                                                    |

### Inside Compensation (`CompensationContext`)

| Resource                    | Operations                                                                     |
| --------------------------- | ------------------------------------------------------------------------------ |
| `ctx.steps.*`               | `(args)` → `CompensationStepCall<T>` — resolves to `CompensationStepResult<T>`; chain `.retry()` to override policy |
| `ctx.channels.*`            | `.receive()` — blocks until message arrives; returns `T` directly              |
| `ctx.streams.*`             | `.write()`                                                                     |
| `ctx.events.*`              | `.set()`                                                                       |
| `ctx.childWorkflows.*`      | `(options)` → `CompensationWorkflowCall<T>` — resolves to `WorkflowResult<T>`  |
| `ctx.scope()`               | Structured concurrency boundary — all unjoined branches settled on exit        |
| `ctx.select()`              | Multiplex handles — `for await` or `.match()` (no `{ complete, failure }` split in compensation) |
| `ctx.forEach()`             | Process branch results — plain callbacks; data carries result unions           |
| `ctx.map()`                 | Transform branch results — plain callbacks                                     |
| `ctx.sleep()` / `ctx.rng.*` | Same as WorkflowContext                                                        |
| `ctx.logger`                | Replay-aware logger                                                            |

### `ForeignWorkflowHandle`

| Resource      | Operations                       |
| ------------- | -------------------------------- |
| `.channels.*` | `.send()` only (fire-and-forget) |

### External (`engine.workflows.*`)

| Resource     | Operations                                            |
| ------------ | ----------------------------------------------------- |
| `.start()`   | Start workflow (`id`, optional `metadata`, optional `seed`, optional `deadlineSeconds`), returns `WorkflowHandleExternal` |
| `.execute()` | Start + wait for result (sugar for start + getResult) |
| `.get()`     | Get handle to existing workflow                       |

### External Handle (`WorkflowHandleExternal`)

Engine-level waits use `{ signal?: AbortSignal }` instead of numeric timeouts.

| Resource                    | Operations                                               |
| --------------------------- | -------------------------------------------------------- |
| `.channels.*`               | `.send()`                                                |
| `.streams.*`                | `.read(offset, { signal? })`, `.iterator()`, `.isOpen()`, `for await...of` |
| `.events.*`                 | `.wait({ signal? })`, `.isSet()`                         |
| `.lifecycle.*`              | `.wait({ signal? })`, `.get()`                           |
| `.getResult({ signal? })`   | Wait for result                                          |
| `.sigterm()` / `.sigkill()` | Send signals (engine-level only)                         |
| `.setRetention()`           | Update retention policy                                  |

External stream async iteration:

```typescript
// Iterate directly from offset 0
for await (const item of handle.streams.progress) {
  console.log(item);
}

// Iterate from a custom offset
for await (const item of handle.streams.progress.iterator(10)) {
  console.log(item);
}
```

## Garbage Collection

```typescript
const workflow = defineWorkflow({
  // Simple: same for all terminal states
  retention: 86400 * 30,

  // Granular
  retention: {
    complete: 86400 * 365,
    failed: 86400 * 90,
    terminated: 86400 * 7,
  },
});

// Override at start time
await engine.workflows.order.start({
  id: "vip-order",
  seed: "vip-order-seed-v1",
  retention: 86400 * 365 * 5,
});

// Update dynamically
await handle.setRetention({ complete: null }); // Never delete
```

## Quick Start

```typescript
import { z } from "zod";
import { Pool } from "pg";
import { defineStep, defineWorkflow, WorkflowEngine } from "./src";

const greet = defineStep({
  name: "greet",
  execute: async ({ signal }, name: string) => ({
    greeting: `Hello, ${name}!`,
  }),
  schema: z.object({ greeting: z.string() }),
});

const helloWorkflow = defineWorkflow({
  name: "hello",
  steps: { greet },
  result: z.object({ message: z.string() }),
  retention: 86400 * 7,

  async execute(ctx) {
    // Call step directly — returns T, no .execute() method needed
    const result = await ctx.steps.greet("World");
    return { message: result.greeting };
  },
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const engine = new WorkflowEngine({
  pool,
  workflows: { hello: helloWorkflow },
});

await engine.start();

// Engine-level uses full result unions
const result = await engine.workflows.hello.execute({ id: "hello-1" });
if (result.ok) {
  console.log(result.data.message); // "Hello, World!"
} else if (result.status === "failed") {
  console.error(result.error.message);
}

// Or start() for a handle with full control
const handle = await engine.workflows.hello.start({ id: "hello-2" });
const result2 = await handle.getResult();

await engine.shutdown();
```

## Example Workflows

Examples are split into focused files under `src/examples/`.

- Workflow-internal API examples: scopes, selection, compensation, channels, patches, child/foreign workflows.
- Cron-like scheduler example: `src/examples/cron-scheduler.example.ts` demonstrates `ctx.schedule(...)`, step-level `deadlineUntil` retry windows, and detached child workflow starts with `deadlineUntil` + `retention` override.
- Concurrency-focused example: `src/examples/concurrency-primitives.example.ts` demonstrates dynamic Map fan-out, cheapest-flight selection across variable providers (up to 3 hops), concurrent hotel reservation race, and child/foreign workflow orchestration in one realistic flow.
- Default-callback-focused example: `src/examples/onboarding-verification.example.ts` demonstrates 5 parallel identity methods, a 1-hour deadline race, 3-of-5 threshold gating, and default `{ complete, failure }` handling for unhandled verification branches.
- Engine-level API example: `src/examples/engine-level-api.example.ts` demonstrates `engine.start()`, `engine.workflows.*.start/execute/get`, handle channels/streams/events/lifecycle operations, `setRetention()`, `sigterm()`, `runGarbageCollection()`, and `engine.shutdown()`.

## Project Structure

```
src/
├── index.ts      # Public exports
├── types.ts      # Type definitions (canonical type system)
├── workflow.ts   # defineStep, defineWorkflow
├── engine.ts     # WorkflowEngine
├── example.ts    # Backward-compatible barrel re-export for examples
└── examples/     # One file per focused workflow example
```

## Status

Work in Progress — Public API design complete. Internal implementation pending.

### Complete

- Type definitions with standard schema support
- `defineStep()` — flat structure with `execute`, `schema`, `retryPolicy`
- `defineWorkflow()` with full type safety
- **Callable thenable model** — steps and child workflows return `StepCall<T>` / `WorkflowCall<T>` thenables with builder chains
- **Structured concurrency with shorthand entries** via `ctx.scope()` — entries can be `async () => T` closures or direct thenables; collections (Array, Map) supported for dynamic fan-out
- **One compensation callback per handle** — defined via `.compensate(cb)` builder, full `CompensationContext`; compensation is always unconditional (at-least-once semantics)
- **Scope exit behavior** — branches with compensated steps → compensated; others → settled
- **Unified failure model** — `.failure(cb)` / `{ complete, failure }` handler entries; `BranchFailureInfo` with `compensate()` for eager discharge and `dontCompensate()` to discharge without running the callback
- **`for await...of` as primary select iteration** — yields `SelectDataUnion<M>`, branch failure auto-terminates; `.match()` for key-aware granular handling
- **No temporal dependencies in workflow logic** — `ChannelHandle.receive()` has no timeout overload; time-bounded patterns use `ctx.sleep()` + `ctx.select()` races
- **Virtual event loop** — engine interleaves concurrent compensation callbacks transparently
- `BaseContext` / `WorkflowContext` / `CompensationContext` hierarchy
- **CompensationContext with full structured concurrency** — `scope()`, `select()`, `forEach()`, `map()`, `CompensationStepCall.retry()`; failures always explicit in result types
- `CompensationStepResult<T>` for defensive compensation code
- **`ctx.childWorkflows.*` / `ctx.foreignWorkflows.*`** split — structured vs message-only access
- **Detached child start via call options** — `ctx.childWorkflows.name({ id, args, detached: true })` returns `ForeignWorkflowHandle`
- **Simplified typing model** — detached vs result mode is selected at call-site options instead of builder chaining
- **Collection support** — Array and Map of closures/handles in scope/select/forEach/map; callbacks receive `innerKey` for collections
- Error observability — `StepExecutionError`, `StepErrorAccessor`, `WorkflowExecutionError`
- Channel receive returns `T` directly (no wrapper, no timeout overload)
- Engine-level handles retain `sigterm()`, `sigkill()`, `getResult()` with `WorkflowExecutionError`
- Lifecycle events with "never" semantics (external API)
- Stream iterators (external API; streams close implicitly on workflow termination)
- Patches for safe workflow code evolution
- Typed deterministic RNG (`ctx.rng.*`)
- `beforeCompensate` / `afterCompensate` lifecycle hooks on workflow definition

## License

MIT
