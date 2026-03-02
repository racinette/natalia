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
- **Structured concurrency** — Every concurrent branch lives inside `ctx.scope(name, ...)` using either a closure (`async () => ...`) or a direct thenable entry (`ctx.steps.x(...)`). Branches with compensated steps are compensated on exit; others are settled.
- **Sound compensation** — One callback per handle via `.compensate(cb)` builder. `{ complete, failure }`, `{ failure }`, and `onFailure` handler forms for explicit failure recovery. Virtual event loop for concurrent compensation execution.
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
// With .compensate() — failure handler receives failure.claimCompensation()
const flightId = await ctx.steps
  .bookFlight("Paris", "cust-1")
  .compensate(async (compCtx) => {
    await compCtx.steps.cancelFlight("Paris", "cust-1");
  })
  .failure(async (failure) => {
    // Claim ownership, then run manually in compensation mode (SIGTERM-resilient)
    const compensate = failure.claimCompensation();
    await compensate();
    return null;
    // Or: don't claim it — engine runs it at LIFO unwinding (safe default)
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
  "NotifyAndCancel",
  {
    cancel: async () => compCtx.steps.cancelFlight("Paris", "cust-1"),
    notify: async () =>
      compCtx.steps.sendEmail("customer@example.com", "Cancelled", "..."),
  },
  async (compCtx, { cancel, notify }) => {
    const cancelResult = await cancel; // CompensationStepResult<T>
    const notifyResult = await notify; // CompensationStepResult<T>
  },
);
```

`"terminated"` is NOT included in `CompensationStepResult` — the only way to terminate during compensation is SIGKILL, which tears down the process immediately.

Steps have no lifecycle control — they are function calls, not processes. They run to completion based on their retry policy and timeout.

### Structured Concurrency (`ctx.scope(name, entries, callback)`)

Every concurrent branch must exist within a **scope** — a lexical boundary that manages branch lifecycle. Entries support two forms:

- **Closure form** (`async () => T`) — full control for complex branch logic.
- **Shorthand form** (`PromiseLike<T>`) — pass step/child-workflow thenables directly for concise common cases.

Both forms can be mixed in the same scope. The scope callback receives a scope-local concurrency context as its first argument, and awaitable `BranchHandle<T>` values as its second argument.

```typescript
const winner = await ctx.scope(
  "BookTravelOptions",
  {
    // shorthand (no async wrapper)
    flight: ctx.steps
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
  async (ctx, { flight, hotel }) => {
    // ctx is WorkflowConcurrencyContext (shadowing the outer WorkflowContext)
    // flight, hotel are BranchHandle<T> — await them or pass to select/map
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

**Scope possession and naming rules:**

- Every scope must be named: `ctx.scope("ScopeName", entries, callback)`.
- Branch handles are branded with the scope lineage and can only be consumed by `select/map` in the current scope or descendant scopes.
- Child scopes cannot reuse an ancestor scope name (compile-time check for literal names).
- Under the same parent scope, duplicate active child scope names are rejected at runtime.
- Widened `string` names are allowed, but literal names provide the strongest compile-time guarantees.

**Dynamic fan-out with collections:** Scope entries can also be arrays or Maps for parallel dispatch over unknown-at-definition-time sets (each element can be a closure or direct thenable):

```typescript
// Build a Map of closures dynamically (closure form)
const providers = new Map<string, () => Promise<Quote>>();
for (const p of args.providerCodes) {
  providers.set(p, async () => ctx.steps.getQuote(p, args.destination));
}

const result = await ctx.scope(
  "CollectQuoteFanout",
  { flight: ctx.steps.bookFlight(...), quotes: providers }, // shorthand + closures mixed
  async (ctx, { flight, quotes }) => {
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

- **Full `CompensationContext`** — has steps, childWorkflows, channels, streams, events, and scope.
- **Scope-local concurrency context** — full `select/map` with branch handles is available as the first callback argument of `ctx.scope(name, ...)`.
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

The `.failure(cb)` builder on `StepCall` / `WorkflowCall` provides explicit failure handling without auto-terminating the workflow. Chain after `.compensate()` if needed — the failure handler receives `claimCompensation()` when compensation was registered.

```typescript
// { complete, failure } pattern for map handlers (scope-local)
const ids = await ctx.scope(
  "MapBookingHandles",
  { flight: flightHandle, hotel: hotelHandle },
  async (ctx, { flight, hotel }) =>
    ctx.map(
      { flight, hotel },
      {
        flight: {
          complete: (data) => data.id,
          failure: async (failure) => {
            // failure: BranchFailureInfo with claimCompensation()
            const compensate = failure.claimCompensation();
            await compensate(); // run claimed callback manually
            // OR:
            // failure.claimCompensation(); // claim ownership and intentionally skip execution
            return null;
          },
        },
        hotel: (data) => data.id,
        // Plain function -> failure crashes the workflow (happy-path default)
      },
    ),
);
ctx.state.flightId = ids.flight;
ctx.state.hotelId = ids.hotel;
```

**`BranchFailureInfo` — ownership API:**

- **`failure.claimCompensation()`** — transfers compensation ownership to user code and returns the callable compensation runner.
- **Claimed means user-owned** — once claimed, the engine does not auto-run that compensation anymore.
- **Runner invocation** — calling the returned runner switches to compensation mode (SIGTERM-resilient), runs to completion, then returns to normal workflow context.
- **Runner is idempotent** — calling it more than once is a no-op and logs a warning (does not throw).
- If you never claim compensation, the engine still runs it at scope exit / LIFO unwinding (safe default).
- For `map` and `match`, per-key `failure` callbacks and the `onFailure` default can return fallback values instead of terminating.
- **Step failure info:** `StepFailureInfo` — `{ reason: "attempts_exhausted" | "timeout", errors: StepErrorAccessor }` — passed directly to `.failure(cb)` on a `StepCall`.
- **Child workflow failure info:** `ChildWorkflowFailureInfo` — discriminated union: `{ status: "failed", error: WorkflowExecutionError } | { status: "terminated", reason: WorkflowTerminationReason }` — passed to `.failure(cb)` on a `WorkflowCall`.

**Handler shapes for concurrency primitives:**

- `(data) => ...` — plain function. Receives successful data `T`. Failure crashes the workflow (branch handles) or resolves with the received value (channel receive calls).
- `{ complete, failure }` — explicit handling for branch handles only.

### Select (Concurrency Primitive)

The `select` primitive multiplexes multiple handles and yields events as they arrive. Two access patterns are available.

**Channel input forms — two distinct semantics:**

```typescript
// Streaming channel branch: ctx.channels.<n> (ChannelHandle)
// - Fires on every new message; the key is NEVER removed from `remaining`.
// - Use for long-running consumer loops where channel reads continue indefinitely.
// - Note: `while (sel.remaining.size > 0)` will not terminate on its own.
const sel = ctx.select({
  flight: flightHandle,
  cancel: ctx.channels.cancel, // streaming — reads forever
});

// One-shot receive branch: ctx.channels.<n>.receive(...) (ChannelReceiveCall)
// - Resolves exactly once; key IS removed from `remaining` afterwards.
// - Use when you want a single message (or a timeout fallback) in a race.
const sel = ctx.select({
  flight: flightHandle,
  cancel: ctx.channels.cancel.receive(), // one-shot — terminates
  payment: ctx.channels.payment.receive(300), // with timeout (T | undefined)
  confirm: ctx.channels.confirm.receive(60, false), // with default (T | false)
});
```

#### Primary: `for await...of`

The primary iteration surface. Yields `SelectDataUnion<M>` — the successful data values from all handles — until all handles are exhausted. Any branch failure **auto-terminates** the workflow (LIFO compensation fires).

```typescript
// Simple "process all" loop — works correctly when all handles are finite
// (branch handles and ChannelReceiveCall; avoid raw ChannelHandle here)
for await (const data of sel) {
  ctx.logger.info("Handle resolved", { data });
}

// Race pattern — return on first value, scope cleans up the rest
for await (const data of sel) {
  return data;
}
```

Use `for await` when you want to process events as they arrive and failures are unrecoverable. Avoid including a raw `ChannelHandle` when iterating with `for await` — the loop will not terminate once branch handles are exhausted.

#### `.match()` — key-aware async iteration

Returns an `AsyncIterable` that yields a transformed value for every event across all handles. The iteration ends when all handles are exhausted, so `for await` loops terminate naturally. **Three call forms — parallel to `ctx.map()`:**

- `sel.match(onFailure)` — identity for all keys, `onFailure` catches every branch failure.
- `sel.match(handlers)` — per-key handlers; omitted keys yield data unchanged.
- `sel.match(handlers, onFailure)` — per-key handlers + default failure catch-all.

**Handler forms** (for BranchHandle keys):

- Plain function: complete only; failure auto-terminates (or uses `onFailure`).
- `{ complete, failure }`: both paths handled explicitly.
- `{ complete }` only: failure auto-terminates (or uses `onFailure`).
- `{ failure }` only: complete yields data unchanged (identity); failure handled explicitly.
- Key omitted from map: yields data unchanged on complete; failure auto-terminates (or uses `onFailure`).

**`onFailure` — default failure handler:**

A single callback `(failure: BranchFailureInfo) => R` applied to all branch failures that do not have their own explicit `failure` handler. Its return value is yielded instead of terminating the workflow. Keys with explicit `failure` handlers are unaffected.

```typescript
// Drive a loop: explicit failure recovery per key, onFailure as catch-all.
// Use channel.receive() for cancel so the key is removed from remaining
// after one message — the for-await loop terminates naturally.
const sel = ctx.select({
  flight: flightHandle,
  hotel: hotelHandle,
  cancel: ctx.channels.cancel.receive(), // one-shot; removed from remaining after first message
});

for await (const result of sel.match(
  {
    // { complete, failure } for explicit per-key handling
    flight: {
      complete: (data) => ({ ok: true as const, id: data.id }),
      failure: async (failure) => {
        const compensate = failure.claimCompensation();
        await compensate();
        return { ok: false as const, id: null };
      },
    },
    // ChannelReceiveCall — plain function (channel receives don't fail)
    cancel: () => ({ ok: false as const, id: null }),
    // hotel: omitted — yields data unchanged on complete, onFailure on failure
  },
  async (failure) => {
    // default failure handler: covers hotel (and any other key without explicit failure)
    const compensate = failure.claimCompensation();
    await compensate();
    return { ok: false as const, id: null };
  },
)) {
  if (result.ok) return result.id;
}
```

**Empty handlers — equivalence with `for await`:**

`sel.match({})` is equivalent to `for await (const val of sel)`: all keys use identity for complete and auto-terminate on failure. The new `match(onFailure)` single-argument form is shorthand for this:

```typescript
// All events yielded as-is; any branch failure returns null instead of terminating
for await (const val of sel.match(() => null)) {
  // val: SelectDataUnion<M> | null
  // same as sel.match({}, () => null)
}
```

With a raw `ChannelHandle` (streaming form), the `remaining` set never drops the channel key, so the iteration will not end on its own. Drive the loop with an explicit `break` condition.

#### Time-bounded step/child patterns (`scope + sleep`)

Workflow-internal APIs intentionally avoid timeout parameters for step/child waits.
Model time bounds explicitly by racing work against a durable sleep branch:

```typescript
// Step race: step result vs timer
const stepRace = await ctx.scope(
  "StepTimeoutRace",
  {
    flight: ctx.steps.bookFlight(dest, customerId),
    timer: ctx.sleep(30).then(() => "timed_out" as const),
  },
  async (ctx, { flight, timer }) => {
    const sel = ctx.select({ flight, timer });
    for await (const val of sel.match({
      flight: {
        complete: () => "booked" as const,
        failure: () => "timed_out" as const,
      },
      timer: () => "timed_out" as const,
    })) {
      return val;
    }
    return "timed_out" as const;
  },
);

// Child workflow race: child completion vs timer
const childRace = await ctx.scope(
  "ChildTimeoutRace",
  {
    payment: ctx.childWorkflows.payment({
      idempotencyKey: "payment-1",
      args: { amount: 100, customerId: "cust-1" },
    }),
    timer: ctx.sleep(45).then(() => "timed_out" as const),
  },
  async (ctx, { payment, timer }) => {
    const sel = ctx.select({ payment, timer });
    for await (const val of sel.match({
      payment: {
        complete: () => "completed" as const,
        failure: () => "timed_out" as const,
      },
      timer: () => "timed_out" as const,
    })) {
      return val;
    }
    return "timed_out" as const;
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

`remaining` tracks keys that have not yet been removed. Branch handle keys are removed when the branch completes or fails. `ChannelReceiveCall` keys are removed after the single receive resolves. **Raw `ChannelHandle` keys are never removed** — they represent an infinite stream.

Inside `ctx.scope(name, ...)`, `ScopeSelectableHandle` includes `BranchHandle` variants, `ChannelHandle`, and `ChannelReceiveCall`. On base contexts (`WorkflowContext` / `CompensationContext`), `ctx.select(...)` is channel-only (`ChannelHandle` and `ChannelReceiveCall`).

`for await...of` on a `Selection<M>` yields `SelectDataUnion<M>` — the union of successful data types across all handles (including channel and receive-call data). Failed branch events auto-terminate the workflow when iterating; to handle failures without terminating, use `.match()` with `{ complete, failure }` or `{ failure }` per-key handlers, or the `onFailure` second argument.

### map (Batch Processing, Scope-Local)

Collects results from all finite handles concurrently and is available on the scope callback context. **Three call forms — parallel to `sel.match()`:**

- `ctx.map(handles)` — identity for all keys; failure auto-terminates. Returns raw resolved data.
- `ctx.map(handles, callbacks)` — partial per-key handlers; omitted keys yield data unchanged.
- `ctx.map(handles, callbacks, onFailure)` — same, plus a default failure callback for branch failures not covered by an explicit per-key `failure` handler.

Handler forms per key: plain function, `{ complete, failure }`, `{ complete }` (failure terminates), `{ failure }` (complete = identity).

**Accepted handle types (`ScopeFiniteHandle`):**

- `BranchHandle<T>` (single, array, or `Map`)
- `ChannelReceiveCall<T>` — produced by `ctx.channels.<n>.receive(...)`

Raw `ChannelHandle` is **not** accepted because it never exhausts and would prevent `map` from completing. Use `ctx.channels.<n>.receive(...)` for a one-shot channel wait, or `ctx.select()` for streaming channel iteration.

Collection handles (Array, Map) pass `innerKey` as a second argument to callbacks.

The examples below assume `ctx` is the scope callback context (`WorkflowConcurrencyContext` or `WorkflowCompensationConcurrencyContext`), e.g. `baseCtx.scope("MyScope", entries, async (ctx, handles) => { ... })`.

```typescript
// ctx.map(handles) — collect all results unchanged; failure terminates
const raw = await ctx.map({ flight: flightHandle, hotel: hotelHandle });
// raw: { flight: FlightData, hotel: HotelData }

// ctx.map(handles, callbacks) — per-key handlers; omitted keys yield data unchanged
// { failure } only: complete = identity, failure = explicit
// Return type mirrors collection structure: array → array, map → map
const ids = await ctx.map(
  { flight: flightHandle, hotel: hotelHandle, car: carHandle },
  {
    flight: {
      complete: (data) => data.id,
      failure: async (failure) => {
        const compensate = failure.claimCompensation();
        await compensate();
        return "FAILED";
      },
    },
    // { failure } only — complete yields HotelData unchanged; failure = fallback
    hotel: {
      failure: async (failure) => {
        const compensate = failure.claimCompensation();
        await compensate();
        return "FAILED";
      },
    },
    // car: omitted — yields CarData unchanged; failure terminates (or uses onFailure below)
  },
);
// ids: { flight: string | "FAILED", hotel: HotelData | "FAILED", car: CarData }

// ctx.map(handles, callbacks, onFailure) — onFailure covers car's failure
const ids2 = await ctx.map(
  { flight: flightHandle, hotel: hotelHandle, car: carHandle },
  {
    flight: { complete: (data) => data.id, failure: async (f) => "FAILED" },
    hotel: { failure: async (f) => "FAILED" },
  },
  async (failure) => {
    // covers car (omitted) and any key without explicit failure handler
    const compensate = failure.claimCompensation();
    await compensate();
    return "FAILED";
  },
);
// ids2: { flight: string | "FAILED", hotel: HotelData | "FAILED", car: CarData | "FAILED" }

// map with a Map collection — innerKey is the Map's key
const quotePrices = await ctx.map(
  { quotes: quotesMap }, // Map<string, BranchHandle<Quote>>
  {
    quotes: {
      complete: (data, innerKey) => {
        return { provider: innerKey, price: data.price };
      },
      failure: (_failure, innerKey) => {
        ctx.logger.warn(`Quote failed for ${innerKey}`);
        return null;
      },
    },
  },
);
for (const [provider, entry] of quotePrices.quotes) {
  if (entry == null) continue;
  ctx.state.quotes[provider] = entry.price;
}

// map with a ChannelReceiveCall — non-blocking cancel poll alongside a branch handle
// receive(0) = nowait: resolves immediately with undefined if no message is queued
const earlyCancel = await ctx.map(
  { cancel: ctx.channels.cancel.receive(0) },
  { cancel: (msg) => msg }, // msg: CancelCommand | undefined
);
if (earlyCancel.cancel !== undefined) {
  // a cancel message was already queued — abort early
}

// map mixing branch handles and a timed channel receive in a single call
const result = await ctx.scope(
  "BookingAndCancelMap",
  { booking: ctx.steps.bookFlight(dest, customerId) },
  async (ctx, { booking }) =>
    ctx.map(
      {
        booking,
        cancel: ctx.channels.cancel.receive(300, { type: "timeout" as const }),
      },
      {
        booking: {
          complete: (data) => ({ status: "booked" as const, id: data.id }),
          failure: () => ({ status: "failed" as const, id: null }),
        },
        cancel: (msg) => ({
          status:
            msg.type === "cancel"
              ? ("cancelled" as const)
              : ("timeout" as const),
          id: null,
        }),
      },
    ),
);
// result: { booking: ..., cancel: ... }
```

### Child Workflows

Child workflow access is split by semantics:

- **`ctx.childWorkflows.*`** — structured invocation, lifecycle managed by parent.
- **`ctx.foreignWorkflows.*`** — message-only handles to existing workflow instances.
- Child starts also accept optional immutable `metadata` for audit/filtering.
- `idempotencyKey` is optional on workflow starts. If omitted, the engine
  generates a unique key for that workflow instance.

This split is enforced at definition-time too:

```typescript
const checkoutWorkflow = defineWorkflow({
  name: "checkout",
  childWorkflows: {
    payment: paymentWorkflow, // callable as ctx.childWorkflows.payment(...)
  },
  foreignWorkflows: {
    campaign: campaignWorkflow, // handle via ctx.foreignWorkflows.campaign.get(idempotencyKey)
  },
  // ...
});
```

```typescript
// Sequential — childWorkflows call returns WorkflowCall<T>
const result = await ctx.childWorkflows
  .payment({
    idempotencyKey: `payment-${ctx.rng.paymentId.uuidv4()}`,
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
  "AwaitPaymentReceipt",
  {
    child: async () => {
      const result = await ctx.childWorkflows.payment({
        idempotencyKey: "payment-1",
        metadata: { tenantId: "tenant-acme" },
        seed: "payment-seed-1",
        args: { amount: 100, customerId: "cust-123" },
      });
      return result.receiptId;
    },
  },
  async (ctx, { child }) => await child,
);

// Detached — pass detached: true in call options, no scope required
const notifier = await ctx.childWorkflows.emailCampaign({
  idempotencyKey: `campaign-${ctx.rng.campaignId.uuidv4()}`,
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

**`beforeSettle` hook semantics:**

- Called once before final workflow status is settled (single-shot).
- Status-discriminated params:
  - `status: "complete"` → `WorkflowContext`, `args`, and decoded `result`.
  - `status: "failed" | "terminated"` → `CompensationContext` and `args`.
- If `beforeSettle` throws on the complete path, the workflow transitions to failure flow:
  `beforeCompensate` → LIFO compensations → `afterCompensate`.
- The hook is not re-entered after that transition (no second `beforeSettle` call).
- Not invoked on SIGKILL.

```typescript
beforeSettle: async (params) => {
  if (params.status === "complete") {
    // params.ctx: WorkflowContext, params.result available
    return;
  }
  // params.ctx: CompensationContext, status is failed|terminated
};
```

**Execution result vs compensation lifecycle (important):**

- `execute(...)` and compensation belong to the same workflow instance, but they run in different phases/contexts.
- `beforeSettle` runs before terminal status is finalized and exposed to result listeners.
- On `failed` / `terminated` paths that require compensation, `beforeSettle` runs after `beforeCompensate` -> LIFO compensations -> `afterCompensate`.
- Compensation progress remains observable through `handle.compensation.lifecycle.*`.

### Hook Ordering Table

| Path | Hook order | `beforeSettle` params | Final status behavior |
| --- | --- | --- | --- |
| `execute` returns successfully, `beforeSettle` succeeds | `beforeSettle` | `{ status: "complete", ctx: WorkflowContext, result, args }` | Settles as `complete` |
| `execute` returns successfully, `beforeSettle` throws | `beforeSettle` -> `beforeCompensate` -> LIFO compensations -> `afterCompensate` | Initial call uses `{ status: "complete", ... }` | Transitions and settles as `failed`; `beforeSettle` is not called again |
| `execute` throws (non-signal failure) | `beforeCompensate` -> LIFO compensations -> `afterCompensate` -> `beforeSettle` | `{ status: "failed", ctx: CompensationContext, args }` | Settles as `failed` |
| SIGTERM (graceful termination with compensation) | `beforeCompensate` -> LIFO compensations -> `afterCompensate` -> `beforeSettle` | `{ status: "terminated", ctx: CompensationContext, args }` | Settles as `terminated` |
| SIGKILL (immediate termination) | _none_ | _none_ | Immediate termination; no hooks/compensation |

### Workflow Headers

A `WorkflowHeader` is a minimal authoring descriptor used to wire workflow-to-workflow references before full implementations exist. It captures only what internal references need: `name`, and optionally `channels` (for `foreignWorkflows`), `args`, `metadata`, and `result` (for `childWorkflows`). It contains no implementation details.

For external/client APIs, use `PublicWorkflowHeader` (type-level contract) — it includes `name`, `args`, `metadata`, `channels`, `streams`, `events`, and `result`.

Use `defineWorkflowHeader()` to create one, then:

- **Spread it into `defineWorkflow`** so the full definition inherits the same name and schemas — single source of truth, no duplication.
- **Pass it directly to `childWorkflows` or `foreignWorkflows`** in any workflow that needs to reference this one before its full definition exists.

**Breaking circular references** is the primary use case. When two workflows reference each other, defining one first is impossible — the type of the second isn't known yet. Headers resolve this:

```typescript
// Step 1 — declare the manager's public interface
const managerHeader = defineWorkflowHeader({
  name: "schedulerManager",
  channels: { workerDone: WorkerDonePayload },
});

// Step 2 — worker references manager via header (no circular dep)
const workerWorkflow = defineWorkflow({
  ...workerHeader,
  foreignWorkflows: { manager: managerHeader }, // just a header
  execute: async (ctx, args) => {
    await ctx.foreignWorkflows.manager
      .get(args.managerId)
      .channels.workerDone.send({ ... });
  },
});

// Step 3 — manager spreads its own header + adds full implementation
const managerWorkflow = defineWorkflow({
  ...managerHeader,           // name + channels from header
  args: ManagerArgs,          // implementation-only fields added here
  childWorkflows: { worker: workerWorkflow },
  execute: async (ctx, args) => { ... },
});
```

In a multi-file project the circular import resolves naturally at module load time — define the header in one file and import it in both. The single-file case is handled exactly as shown above.

**Self-referential (recursive) workflows** are the other natural use case. A workflow that spawns children of its own type — a tree traversal, a recursive task decomposer, a web crawler — simply references its own header:

```typescript
const treeHeader = defineWorkflowHeader({ name: "tree", args: TreeArgs });

const treeWorkflow = defineWorkflow({
  ...treeHeader,
  childWorkflows: { subtree: treeHeader }, // self-reference
  execute: async (ctx, args) => {
    for (const child of args.children) {
      await ctx.childWorkflows.subtree({
        idempotencyKey: child.id,
        args: child,
        detached: true,
      });
    }
  },
});
```

**Idempotent child starts as cycle prevention.** When a self-referential workflow uses a content-derived idempotency key (e.g. a URL, a node key) for each child start, the engine's idempotent start semantics automatically prevent duplicate work. If two different paths in the tree both try to start a workflow for the same idempotency key, the second start is a no-op — no explicit visited-set, no coordination needed:

```typescript
// URL as stable idempotency key — same URL = same key = engine no-ops the duplicate
await ctx.childWorkflows.page({
  idempotencyKey: pageUrl, // deterministic from content, not from call site
  args: { url: pageUrl, depth: args.depth + 1, ... },
  detached: true,
});
```

See `src/examples/web-scraper.example.ts` for a complete web crawler built on this pattern.

### Cron-Like Workflows

Use `ctx.schedule(cron, { timezone?, resumeAt? })` to model recurring jobs as durable workflow logic.

Why this works in a durable/replayable model:

- `schedule.sleep()` yields deterministic tick metadata (`scheduledAt`, `nextScheduledAt`, `secondsUntilNext`, `index`) computed from schedule math.
- The scheduler workflow can safely replay and regenerate the same tick sequence.
- `resumeAt` lets a successor scheduler continue cadence from an explicit anchor (for rotation/continue-as-new patterns).
- The first emitted tick is always the first schedule point **strictly after** `resumeAt` (never equal), preventing duplicate boundary ticks at handoff.
- Detached child workflows can use `deadlineUntil: tick.nextScheduledAt`; if `deadlineUntil` is already before the workflow's current timestamp at start, the workflow is terminated immediately (`deadline_exceeded`) and user code/effects do not run.
- Detached children can override `retention` independently, so scheduler and job lifecycles are decoupled.
- You can set a very small `retention.terminated` window for detached jobs so late/missed ticks are garbage-collected quickly.

```typescript
const schedule = ctx.schedule("0 9 * * 1-5", {
  timezone: "America/New_York",
  // Optional handoff anchor from previous scheduler instance.
  // First tick is strictly after this instant.
  resumeAt: args.resumeAt ? new Date(args.resumeAt) : undefined,
});

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
    idempotencyKey: `daily-report-${tick.index}`,
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
- Has `scope(name, entries, callback)`, channel-only base `select()`, and `addCompensation()`
- Full branch-aware `select()` and `map()` are available only on scope callback context
- Concurrency primitives support `{ complete, failure }` handlers

**`CompensationContext`** (defensive, full structured concurrency):

- Steps: calling a step returns `CompensationStepCall<T>` — resolves to `CompensationStepResult<T>` (must handle ok/!ok)
- Child workflows: `ctx.childWorkflows.*` returns `CompensationWorkflowCall<T>` — resolves to `WorkflowResult<T>`
- Has `scope(name, entries, callback)` and channel-only base `select()`
- Full branch-aware `select()` and `map()` are available only on compensation scope callback context (with failures visible in result types)
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

// Time-bounded receive: timeout in seconds (0 = nowait)
const maybePayment = await ctx.channels.payment.receive(300);
if (maybePayment === undefined) {
  console.log("timed out");
}

// Time-bounded receive with explicit timeout default
const paymentOrDefault = await ctx.channels.payment.receive(300, {
  amount: 0,
  txnId: "timeout",
});

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
}
```

`wait({ signal })` rejects with `AbortError` if the signal aborts.

### Phase Lifecycle Events

Engine-managed phase events are available on every workflow handle via:

- `handle.execution.lifecycle`
- `handle.compensation.lifecycle`

Each phase exposes the same event names:

| Event        | Meaning for that phase |
| ------------ | ---------------------- |
| `started`    | Phase execution begins |
| `complete`   | Phase completes successfully |
| `failed`     | Phase fails with an error |
| `terminated` | Phase is terminated |

Execution and compensation are intentionally decoupled phases:

- `complete` / `failed` represent the terminal outcome of `execute(...)`.
- Compensation has its own terminal outcome (`complete` / `failed` / `terminated`).
- Consumers that need post-compensation guarantees should wait on `handle.compensation.wait(...)` in addition to checking `handle.execution.wait(...)`.

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
| Workflow **execution.wait()** returns | `z.output<Schema>` | Decoded from DB  |

## Result Types

### Workflow-Internal (happy-path model)

Step and child workflow calls in `WorkflowContext` resolve to `T` directly when awaited without a `.failure()` builder. Failure auto-terminates the workflow.

### Workflow-Internal (builder-based error handling)

`.failure(cb)` and `.complete(cb)` on `StepCall` / `WorkflowCall` let you handle outcomes explicitly. The call resolves to `T | TFail` where `TFail` is the `failure` callback's return type.

**`failure.claimCompensation()` semantics (unified across all `failure` surfaces):**

- Calling it transfers ownership and returns the compensation runner callback.
- Once claimed, the engine no longer auto-runs that compensation; user code owns it.
- Calling the returned runner switches to compensation mode (SIGTERM-resilient) and runs to completion.
- Calling the returned runner more than once is a no-op with a warning (no throw).
- Not claiming it → engine runs it after `failure` returns / at scope exit (safe default).
- Same mechanism in `match`/`map` failure handlers and `.failure()` builder.

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

| Type                       | Success    | Failure Statuses                 | Notes                           |
| -------------------------- | ---------- | -------------------------------- | ------------------------------- |
| `ChannelSendResult`        | `sent`     | `not_found`                      | Engine-level send               |
| `StreamReadResult`         | `received` | `closed`, `not_found`            | Engine-level random-access read |
| `StreamIteratorReadResult` | `record`   | `closed`                         | Engine-level iterator read      |
| `EventWaitResultNoTimeout` | `set`      | `never`                          | Engine-level event wait         |
| `EventCheckResult`         | `set`      | `not_set`, `never`, `not_found`  | Engine-level non-blocking check |
| `SignalResult`             | `sent`     | `already_finished`, `not_found`  | Engine-level signal             |

Workflow-internal `ChannelHandle.receive()` returns `T` directly when called without a timeout. The timeout overloads are:

- `receive(timeoutSeconds)` → `T | undefined`
- `receive(timeoutSeconds, defaultValue)` → `T | typeof defaultValue`
- `receive(0, ...)` is a deterministic nowait poll.

### Engine-Level Results

Engine-level types retain full result unions since engine callers need to handle all outcomes:

| Type                     | Success    | Failure Statuses                                                              |
| ------------------------ | ---------- | ----------------------------------------------------------------------------- |
| `WorkflowResult`         | `complete` | `failed` (with `error`), `terminated` (with `reason`)                         |
| `ExecutionResultExternal` | `complete` | `failed` (with `error`), `terminated` (with `reason`), `not_found` |
| `CompensationResultExternal` | `complete` | `failed` (with `error`), `terminated` (with `reason`), `not_found` |

`WorkflowTerminationReason` values: `"deadline_exceeded" | "terminated_by_signal" | "terminated_by_parent"`.

### Policy Scope Matrix

| Policy            | Applies To | Purpose                                                                                        |
| ----------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `retryPolicy`     | Steps only | Controls retry attempts/backoff/step timeout before a **step** is considered failed.           |
| `deadlineSeconds` | Workflows  | Sets a runtime deadline for a **workflow**; expiry terminates with reason `deadline_exceeded`. |
| `retention`       | Workflows  | Controls how long terminal workflow records stay in DB before garbage collection.              |

Notes:

- Child workflows inherit retention from their parent by default.
- Detached child workflows can override retention at start-time with `retention` in call options.
- If `deadlineUntil` is already in the past at workflow start, the workflow terminates immediately with `deadline_exceeded`.
- For detached cron jobs, set a short `retention.terminated` to quickly GC late/missed runs that terminate immediately.
- Workflows are not retried as a unit; retry is step-scoped.
- Retention affects persistence lifecycle, not execution semantics.

### External Wait Cancellation

Engine-level wait APIs use `{ signal?: AbortSignal }` for runtime cancellation:

- If the signal aborts, the wait rejects with `AbortError`.
- Wait result unions do not contain a `timeout` status.

Workflow-internal timeout behavior:

- `channels.receive(...)` returns `ChannelReceiveCall<T>` — awaitable directly or passed into `select`/`map`
- `channels.receive(timeoutSeconds, defaultValue?)` supports deterministic time-bounded waits; `receive(0)` is nowait
- `select` and `sleep` remain explicit primitives for orchestration/race patterns

## Visibility Rules

### Inside Workflow (`WorkflowContext`)

| Resource                                       | Operations                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.steps.*`                                  | `(args)` → `StepCall<T>` — chain `.compensate()`, `.retry()`, `.failure()`, `.complete()` before await                                                                                                      |
| `ctx.channels.*`                               | `.receive()` → `ChannelReceiveCall<T>` (blocking), `.receive(timeoutSeconds)` (`T \| undefined`), `.receive(timeoutSeconds, defaultValue)` (`T \| TDefault`); also `for await...of` for streaming iteration |
| `ctx.streams.*`                                | `.write()`                                                                                                                                                                                                  |
| `ctx.events.*`                                 | `.set()`                                                                                                                                                                                                    |
| `ctx.childWorkflows.*`                         | `(options)` → `WorkflowCall<T>` by default; supports optional `metadata`; with `detached: true` → `ForeignWorkflowHandle`                                                                                   |
| `ctx.foreignWorkflows.*`                       | `.get(idempotencyKey)` → `ForeignWorkflowHandle` (channels.send only, fire-and-forget)                                                                                                                       |
| `ctx.patches.*`                                | `await ctx.patches.name` → boolean, `(callback, default?)` → callback result or default                                                                                                                     |
| `ctx.scope(name, entries, callback)`           | Structured concurrency boundary — requires explicit scope name; accepts closures and collections                                                                                                             |
| `ctx.select()`                                 | Channel-only select on base context — accepts `ChannelHandle` (streaming) or `ChannelReceiveCall` (one-shot)                                                                                                 |
| `ctx.map()`                                    | Not available on base `WorkflowContext`; use `ctx.scope("Name", entries, async (ctx, handles) => ctx.map(...))`                                                                                             |
| `ctx.addCompensation()`                        | Register LIFO compensation callback                                                                                                                                                                         |
| `ctx.schedule(cron, { timezone?, resumeAt? })` | Durable cron-like schedule handle; first tick is strictly after `resumeAt` when provided                                                                                                                    |
| `ctx.sleep(seconds)`                           | Durable relative sleep                                                                                                                                                                                      |
| `ctx.sleepUntil(target)`                       | Durable sleep until target `Date` / epoch milliseconds                                                                                                                                                      |
| `ctx.rng.*`                                    | Typed deterministic RNG streams                                                                                                                                                                             |
| `ctx.timestamp` / `ctx.date`                   | Deterministic time                                                                                                                                                                                          |
| `ctx.logger`                                   | Replay-aware logger                                                                                                                                                                                         |

### Inside Compensation (`CompensationContext`)

| Resource                    | Operations                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.steps.*`               | `(args)` → `CompensationStepCall<T>` — resolves to `CompensationStepResult<T>`; chain `.retry()` to override policy                                                 |
| `ctx.channels.*`            | `.receive()` → `ChannelReceiveCall<T>` (blocking), `.receive(timeoutSeconds)`, `.receive(timeoutSeconds, defaultValue)`                                             |
| `ctx.streams.*`             | `.write()`                                                                                                                                                          |
| `ctx.events.*`              | `.set()`                                                                                                                                                            |
| `ctx.childWorkflows.*`      | `(options)` → `CompensationWorkflowCall<T>` — resolves to `WorkflowResult<T>`                                                                                       |
| `ctx.scope(name, entries, callback)` | Structured concurrency boundary — requires explicit scope name; all unjoined branches settled on exit                                                     |
| `ctx.select()`              | Channel-only select on base compensation context — accepts `ChannelHandle` (streaming) or `ChannelReceiveCall` (one-shot) |
| `ctx.map()`                 | Not available on base `CompensationContext`; use `ctx.scope("Name", entries, async (ctx, handles) => ctx.map(...))`         |
| `ctx.sleep()` / `ctx.rng.*` | Same as WorkflowContext                                                                                                                                             |
| `ctx.logger`                | Replay-aware logger                                                                                                                                                 |

### `ForeignWorkflowHandle`

| Resource      | Operations                       |
| ------------- | -------------------------------- |
| `.channels.*` | `.send()` only (fire-and-forget) |

### External (`engine.workflows.*`)

| Resource     | Operations                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `.start()`   | Start workflow (`idempotencyKey?`, optional `metadata`, optional `seed`, optional `deadlineSeconds`), returns `WorkflowHandleExternal` |
| `.execute()` | Start + wait for execution result (sugar for `start + handle.execution.wait()`)                                           |
| `.get()`     | Get handle to existing workflow                                                                                           |

### External Handle (`WorkflowHandleExternal`)

Engine-level waits use `{ signal?: AbortSignal }` instead of numeric timeouts.

| Resource                    | Operations                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| `.channels.*`               | `.send()`                                                                  |
| `.streams.*`                | `.read(offset, { signal? })`, `.iterator()`, `.isOpen()`, `for await...of` |
| `.events.*`                 | `.wait({ signal? })`, `.isSet()`                                           |
| `.execution.lifecycle.*`    | `.wait({ signal? })`, `.get()`                                             |
| `.compensation.lifecycle.*` | `.wait({ signal? })`, `.get()`                                             |
| `.execution.wait({ signal? })`   | Wait for execution phase result                                     |
| `.compensation.wait({ signal? })` | Wait for compensation phase result                                  |
| `.sigterm()` / `.sigkill()` | Send signals (engine-level only)                                           |
| `.setRetention()`           | Update retention policy                                                    |

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
  idempotencyKey: "vip-order",
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
const result = await engine.workflows.hello.execute({
  idempotencyKey: "hello-1",
});
if (result.ok) {
  console.log(result.data.message); // "Hello, World!"
} else if (result.status === "failed") {
  console.error(result.error.message);
}

// Or start() for a handle with full control
const handle = await engine.workflows.hello.start({
  idempotencyKey: "hello-2",
});
const result2 = await handle.execution.wait();

await engine.shutdown();
```

## Example Workflows

Examples are split into focused files under `src/examples/`.

- Workflow-internal API examples: scopes, selection, compensation, channels, patches, child/foreign workflows.
- Cron-like scheduler example: `src/examples/cron-scheduler.example.ts` demonstrates the manager/worker split for long-running schedulers — a stable idempotency-key manager loop delegates to bounded-history workers, with `beforeSettle` + `foreignWorkflows` guaranteeing worker handoff delivery on complete/failed/terminated outcomes and detached child starts so workers carry no compensation obligation to the manager.
- Web scraper example: `src/examples/web-scraper.example.ts` demonstrates `defineWorkflowHeader` for self-referential workflows and URL-as-idempotency-key for automatic cycle prevention — no explicit visited-set needed.
- Concurrency-focused example: `src/examples/concurrency-primitives.example.ts` demonstrates dynamic Map fan-out, cheapest-flight selection across variable providers (up to 3 hops), concurrent hotel reservation race, and child/foreign workflow orchestration in one realistic flow.
- Per-key match example: `src/examples/onboarding-verification.example.ts` demonstrates 5 parallel identity methods, a 1-hour deadline race, 3-of-5 threshold gating, and explicit per-key `{ complete, failure }` handlers for each verification branch.
- Client API example: `src/examples/engine-level-api.example.ts` demonstrates the shared workflow client API (`workflows.*.start/execute/get`) and handle operations (channels/streams/events/execution/compensation, `setRetention()`, `sigterm()`) via `clientApiShowcase`.

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
- **Structured concurrency with shorthand entries** via `ctx.scope(name, ...)` — entries can be `async () => T` closures or direct thenables; collections (Array, Map) supported for dynamic fan-out
- **One compensation callback per handle** — defined via `.compensate(cb)` builder, full `CompensationContext`; compensation is always unconditional (at-least-once semantics)
- **Scope exit behavior** — branches with compensated steps → compensated; others → settled
- **Unified failure model** — `.failure(cb)` / `{ complete, failure }` / `{ failure }` handler entries; `onFailure` default for `match()`; `BranchFailureInfo` with `claimCompensation()` for explicit ownership transfer
- **`for await...of` as primary select iteration** — yields `SelectDataUnion<M>`, branch failure auto-terminates; `.match(handlers, onFailure?)` for key-aware granular handling with async iteration
- **Time-bounded channel receive** — `ChannelHandle.receive(timeoutSeconds, defaultValue?)` supports deterministic timeout/nowait workflow logic
- **Virtual event loop** — engine interleaves concurrent compensation callbacks transparently
- `BaseContext` / `WorkflowContext` / `CompensationContext` hierarchy
- **CompensationContext with full structured concurrency** — `scope(name, ...)` plus scope-local `select()/map()` and `CompensationStepCall.retry()`; failures always explicit in result types
- `CompensationStepResult<T>` for defensive compensation code
- **`ctx.childWorkflows.*` / `ctx.foreignWorkflows.*`** split — structured vs message-only access
- **Detached child start via call options** — `ctx.childWorkflows.name({ idempotencyKey?, args, detached: true })` returns `ForeignWorkflowHandle`
- **Simplified typing model** — detached vs result mode is selected at call-site options instead of builder chaining
- **Collection support** — Array and Map of closures/handles in scope/select/map; callbacks receive `innerKey` for collections
- Error observability — `StepExecutionError`, `StepErrorAccessor`, `WorkflowExecutionError`
- Channel receive returns `T` directly (blocking) and supports timeout overloads with optional default values
- Engine-level handles retain `sigterm()`, `sigkill()`, `execution.wait()`, and `compensation.wait()` with typed terminal outcomes
- Lifecycle events with "never" semantics (external API)
- Stream iterators (external API; streams close implicitly on workflow termination)
- Patches for safe workflow code evolution
- Typed deterministic RNG (`ctx.rng.*`)
- `beforeCompensate` / `afterCompensate` / `beforeSettle` lifecycle hooks on workflow definition
- **`WorkflowHeader` / `defineWorkflowHeader`** — minimal authoring descriptors for circular reference resolution and self-referential (recursive/tree) workflows in `childWorkflows` / `foreignWorkflows`
- **`PublicWorkflowHeader`** — client-facing workflow contract (`name`, `args`, `metadata`, `channels`, `streams`, `events`, `result`); full `WorkflowDefinition` objects satisfy it structurally

## License

MIT
