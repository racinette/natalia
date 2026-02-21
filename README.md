# Durable Workflow Engine

A type-safe, Postgres-backed durable execution engine for TypeScript.

## What makes it special

- **A library, not a bible.** Gradual adoption, lightweight in-process durable execution without additional infrastructure.
- **Postgres backed.** No additional infra needed, only a Postgres instance.
- **Fully typed.** Everything is type safe thanks to standard schema support (Zod v4, etc.).
- **Happy-path workflow code.** `.execute()` returns `T` directly. Failures auto-terminate the workflow and trigger compensation — no `if (!result.ok) throw` boilerplate. `.tryExecute()` / `.tryJoin()` available when explicit error handling is needed.
- **One compensation callback per handle.** Defined at `.start()` or `.execute()` time. Full `CompensationContext` with structured concurrency.
- **Structured concurrency.** Every concurrent handle lives inside a `ctx.scope()`. Handles with `compensate` are compensated on scope exit; handles without are settled.
- **The actor model.** Workflows are independent and decoupled from each other.
- **State is not stored.** Workflow state is derived from replay — keeps workflows modifiable.

## Philosophy

- **Happy path by default, explicit when needed** — Workflow code describes business intent, not error handling plumbing. The engine handles retries, compensation, and cleanup. `tryExecute()` / `tryJoin()` opt in to explicit error handling for individual operations.
- **Explicit over implicit** — No decorators, no global state, no magic.
- **Structured concurrency** — Every concurrent handle has a declared lifecycle boundary (scope). Handles with `compensate` are compensated; handles without are settled.
- **Sound compensation** — One callback per handle. `onFailure` with a single flat failure parameter for explicit failure recovery. Virtual event loop for concurrent compensation execution.
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
    return await res.json();
  },
  schema: FlightBookingSchema,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});
```

**In `WorkflowContext`:** `.execute()` returns `T` directly — the decoded step result. If the step fails, the workflow is automatically terminated and compensations run.

```typescript
// .execute() returns T directly — no ok/status checking
const flight = await ctx.steps.bookFlight.execute("Paris", "cust-1");
// flight is { id: string, price: number } — the decoded result

// With compensation callback
const flight = await ctx.steps.bookFlight.execute("Paris", "cust-1", {
  compensate: async (compCtx, result) => {
    // result is StepCompensationResult: "complete" | "failed" | "terminated"
    await compCtx.steps.cancelFlight.execute("Paris", "cust-1");
  },
});
```

**`.tryExecute()` / `.tryJoin()` — explicit error handling:** When you need to observe step failures without auto-terminating the workflow, use the `try` variants. They accept `{ onComplete, onFailure }` callbacks — the same pattern used by `match`, `forEach`, and `map`:

- **With `compensate`:** `onFailure` receives failure info with `compensate()` merged in for eager discharge.
- **Without `compensate`:** `onFailure` receives plain failure info — no `compensate()` (full type safety).

```typescript
// With compensate — onFailure gets { reason, errors, compensate }
const flightId = await ctx.steps.bookFlight.tryExecute("Paris", "cust-1", {
  compensate: async (compCtx, result) => {
    if (result.status === "complete") {
      await compCtx.steps.cancelFlight.execute("Paris", "cust-1");
    }
  },
  onComplete: (data) => data.id,
  onFailure: async (failure) => {
    // Eagerly discharge — runs in compensation mode (SIGTERM-resilient)
    await failure.compensate();
    return null;
    // Or: don't call it — engine runs it at LIFO unwinding (safe default)
  },
});

// Without compensate — onFailure gets { reason, errors } (no compensate)
const carId = await ctx.steps.reserveCar.tryExecute("Paris", "dates", {
  onComplete: (data) => data.id,
  onFailure: (failure) => {
    // failure.compensate would be a type error — not available
    return null;
  },
});
```

Same for handles inside a scope — `.tryJoin()` callback shape depends on `HasCompensation`:

```typescript
const data = await ctx.scope({
  // .start() with compensate → StepHandle<T, true>
  flight: ctx.steps.bookFlight.start("Paris", "cust-1", { compensate: ... }),
}, async ({ flight }) => {
  // tryJoin's onFailure includes compensate() because HasCompensation = true
  return await flight.tryJoin({
    onComplete: (data) => data,
    onFailure: async (failure) => {
      await failure.compensate();
      return null;
    },
  });
});
```

**In `CompensationContext`:** `.execute()` returns `CompensationStepResult<T>` — a discriminated union that compensation code must handle gracefully. `.start()` returns a `ScopeEntry<CompensationStepHandle<T>>` for concurrent compensation within scopes.

```typescript
// Sequential compensation
const cancelResult = await compCtx.steps.cancelFlight.execute("Paris", "cust-1");
if (!cancelResult.ok) {
  compCtx.logger.error("Failed to cancel flight", {
    reason: cancelResult.status,
    errors: await cancelResult.errors.all(),
  });
}

// Concurrent compensation with scope
await compCtx.scope({
  cancel: compCtx.steps.cancelFlight.start("Paris", "cust-1"),
  notify: compCtx.steps.sendEmail.start("customer@example.com", "Cancelled", "..."),
}, async ({ cancel, notify }) => {
  const cancelResult = await cancel.join(); // CompensationStepResult<T>
  const notifyResult = await notify.join(); // CompensationStepResult<T>
});
```

`"terminated"` is NOT included in `CompensationStepResult` — the only way to terminate during compensation is SIGKILL, which tears down the process immediately. Compensation code never observes that status.

Steps have no lifecycle control — they are function calls, not processes. They run to completion based on their retry policy and timeout. The `signal: AbortSignal` in the step's execute function is only aborted by workflow-level SIGTERM/SIGKILL.

### Structured Concurrency (`ctx.scope()`)

Every concurrent handle (step or child workflow) must exist within a **scope** — a lexical boundary that manages handle lifecycle.

**Core rules:**
1. `.start()` is only available within scope declarations. You cannot call `ctx.steps.X.start()` directly.
2. `.execute()` remains available on `ctx` directly — it's sequential, self-contained, no scope needed.
3. When the scope callback exits:
   - Handles with a `compensate` callback that weren't consumed → compensation runs
   - Handles without `compensate` that weren't consumed → settled (waited for, result ignored)
4. On error (callback throws): all unjoined handles with `compensate` are compensated.

```typescript
const winner = await ctx.scope({
  flight: ctx.steps.bookFlight.start("Paris", "cust-1", {
    compensate: async (compCtx, result) => {
      if (result.status === "complete") {
        await compCtx.steps.cancelFlight.execute("Paris", "cust-1");
      }
    },
  }),
  hotel: ctx.steps.bookHotel.start(city, checkIn, checkOut, {
    compensate: async (compCtx, result) => {
      await compCtx.steps.cancelHotel.execute(city, checkIn, checkOut);
    },
  }),
}, async ({ flight, hotel }) => {
  // flight, hotel are StepHandle<T> — materialized by the scope
  const sel = ctx.select({ flight, hotel });
  const first = await sel.next();
  return first.data;
  // Scope exits → loser's compensation callback fires
});
```

The scope resolves to whatever the callback returns. Cleanup happens after the callback returns but before the scope's promise resolves.

### Scope Exit Behavior

The presence of a `compensate` callback determines what happens to unjoined handles when a scope exits:

| Condition | Has `compensate` | No `compensate` |
|-----------|------------------|-----------------|
| Normal exit (callback returns) | Compensation runs | Settled (wait, ignore result) |
| Error exit (callback throws) | Compensation runs | Settled (wait, ignore result) |

This replaces the previous five `unjoined` strategies with a single, clear rule: **compensate if callback exists, settle if not.**

### Compensation Model

Each handle has at most **one compensation callback**, defined at `.start()` or `.execute()` time. The callback receives a full `CompensationContext` and the step's outcome.

```typescript
const flight = await ctx.steps.bookFlight.execute("Paris", "cust-1", {
  compensate: async (compCtx, result) => {
    // result: StepCompensationResult<T>
    //   | { status: "complete"; data: T; errors: StepErrorAccessor }
    //   | { status: "failed"; reason: ...; errors: StepErrorAccessor }
    //   | { status: "terminated"; errors: StepErrorAccessor }
    if (result.status === "complete") {
      await compCtx.steps.cancelFlight.execute("Paris", "cust-1");
    }
  },
});
```

Properties:
- **Full `CompensationContext`** — has steps, workflows, channels, streams, events, scope, select, forEach, map.
- **Has access to the outcome** — can branch on `result.status`.
- **Pushed onto the LIFO compensation stack** at start/execute time.
- **Virtual event loop** — when multiple compensation callbacks from the same scope need to run, the engine transparently interleaves their execution at durable operation `await` points for concurrency, while keeping each callback's code sequential.

#### `addCompensation()` (general purpose)

Available on `WorkflowContext` for non-step cleanup. Not available on `CompensationContext` (no nesting).

```typescript
ctx.addCompensation(async (compCtx) => {
  await compCtx.channels.notifications.send({ type: "rollback" });
});
```

### `onFailure` — Explicit Failure Handling

Concurrency primitives (`match`, `forEach`, `map`) and sequential try variants (`tryExecute`, `tryJoin`) share a unified `onFailure` model. The callback receives a **single flat failure object** — with `compensate()` merged in when the handle was started with compensation.

```typescript
await ctx.forEach(
  { flight: flightHandle, hotel: hotelHandle },
  {
    flight: {
      onComplete: (data) => { ctx.state.flightId = data.id; },
      onFailure: async (failure) => {
        // failure: { reason, errors, compensate } (compensate present because handle had it)
        ctx.logger.error("Flight failed", { reason: failure.reason });
        // Explicitly run compensation to discharge SAGA obligation
        await failure.compensate();
      },
    },
    hotel: (data) => { ctx.state.hotelId = data.id; },
    // Plain function → failure crashes the workflow (happy-path default)
  },
);
```

**`onFailure` semantics:**
- Receives a **single parameter**: the failure info object, optionally augmented with `compensate()`.
- `failure.compensate()` invokes the handle's compensation callback explicitly. Calling it **switches the context to compensation mode** (SIGTERM-resilient) — the callback runs to completion. Then the obligation is discharged from the LIFO stack.
- If `failure.compensate()` is NOT called, the compensation still runs at scope exit / LIFO unwinding (safe default).
- If no `compensate` was registered at `.start()` / `.execute()` time, the failure object does NOT include `compensate()` — full type safety.
- For `map` and `match`, `onFailure` can return a fallback value.
- **Step failure info:** `StepFailureInfo` — `{ reason: "attempts_exhausted" | "timeout", errors: StepErrorAccessor }`.
- **Child workflow failure info:** `ChildWorkflowFailureInfo` — discriminated union: `{ status: "failed", error: WorkflowExecutionError } | { status: "terminated" }`. This lets the developer distinguish between a child that threw an error and one that was terminated by an administrator.

**Handler shapes:**
- `(data) => ...` — plain function. Receives successful data `T`. Failure crashes the workflow.
- `{ onComplete, onFailure }` — explicit handling. `onComplete` receives `T`; `onFailure` receives a flat failure info object.

### `tryExecute` / `tryJoin` — Proportional Error Handling

The `try` variants provide the same explicit `onFailure` model for **sequential** operations (direct `.execute()` or `.join()` calls). They accept `{ onComplete, onFailure }` callbacks — the same unified pattern used by `match`, `forEach`, and `map`.

**Type safety:** Whether `onFailure`'s parameter includes `compensate()` depends on whether `compensate` was provided:

| Method | `onFailure` parameter |
|---|---|
| `tryExecute` with `compensate` | `{ reason, errors, compensate }` |
| `tryExecute` without `compensate` | `{ reason, errors }` |
| `tryJoin` on handle started with `compensate` | `{ reason, errors, compensate }` |
| `tryJoin` on handle started without `compensate` | `{ reason, errors }` |

Return type is `Promise<Awaited<R1> | Awaited<R2>>` where `R1` and `R2` are independently inferred from each callback's return type. This allows `onComplete` and `onFailure` to return different types (including async vs sync).

Timeout overloads on `tryJoin` add an `onTimeout` callback.

**Compensation semantics (same model as `onFailure` everywhere):**
- Compensation is registered on the LIFO stack **before** execution (SIGTERM during execution → covered).
- On success → stays on LIFO (standard SAGA).
- On failure/terminated → **stays on LIFO**. `onFailure` receives `failure.compensate()`:
  - `await failure.compensate()` → switches to compensation mode (SIGTERM-resilient), runs callback to completion, discharges from LIFO.
  - Don't call it → engine runs it after `onFailure` returns / at scope exit (safe default).
- Steps don't have `"terminated"` — they are function calls with no external lifecycle control.
- Child workflows include `"terminated"` — admin-initiated kills (`ChildWorkflowFailureInfo`).

**Handle type parameter:** `.start()` with `compensate` produces `StepHandle<T, true>` / `ChildWorkflowHandle<..., true>`. Without → `false`. This tracks at the type level whether `onFailure`'s parameter includes `compensate()`.

```typescript
// Step: tryExecute WITH compensate — onFailure gets { reason, errors, compensate }
const flightId = await ctx.steps.bookFlight.tryExecute("Paris", "cust-1", {
  compensate: async (compCtx, result) => { ... },
  onComplete: (data) => data.id,
  onFailure: async (failure) => {
    await failure.compensate(); // eager discharge — or don't call it (safe default)
    return null;
  },
});

// Step: tryExecute WITHOUT compensate — { reason, errors } only
const carId = await ctx.steps.reserveCar.tryExecute("Paris", "dates", {
  onComplete: (data) => data.id,
  onFailure: (failure) => {
    // failure.compensate would be a type error — not available
    return null;
  },
});

// Child workflow: tryExecute WITH compensate
const paymentStatus = await ctx.workflows.payment.tryExecute({
  workflowId: "pay-123",
  args: { amount: 100 },
  compensate: async (compCtx, result) => { ... },
  onComplete: (data) => `paid:${data.receiptId}`,
  onFailure: async (failure) => {
    if (failure.status === "terminated") {
      await failure.compensate(); // admin killed the child — eager discharge
    }
    // Don't call failure.compensate() for "failed" — let LIFO handle it
    return failure.status;
  },
});

// tryJoin with timeout — adds onTimeout callback
const result = await flightHandle.tryJoin(30, {
  onComplete: (data) => data,
  onFailure: async (failure) => {
    await failure.compensate();
    return null;
  },
  onTimeout: () => null, // step still running, no compensation to discharge
});
```

### Select (Concurrency Primitive)

The `select` primitive multiplexes multiple handles and yields events as they arrive. In the happy-path model, step/child failures crash the workflow — the handle is removed from the selection.

```typescript
// Inside a scope callback:
const sel = ctx.select({ flight: flightHandle, hotel: hotelHandle, abort: ctx.channels.abort });
```

#### Manual iteration (`next`)

```typescript
// Without timeout
const event = await sel.next();
// With timeout
const event = await sel.next(60);

switch (event.key) {
  case "flight":
    console.log(event.data.id); // T directly — no ok/status check
    break;
  case "hotel":
    console.log(event.data.id);
    break;
  case "abort":
    // Channel message
    break;
  case null:
    // "exhausted" (always) or "timeout" (only with timeout arg)
    break;
}
```

#### Pattern matching (`match`) with default and onFailure

Handlers can be plain functions or `{ onComplete, onFailure }` objects for step/child keys. The second positional argument is a default handler for unhandled keys.

```typescript
const result = await sel.match(
  {
    // { onComplete, onFailure } for explicit failure handling
    flight: {
      onComplete: (data) => ({ type: "booking" as const, id: data.id }),
      onFailure: async (failure) => {
        await failure.compensate();
        return { type: "booking" as const, id: "FAILED" };
      },
    },
    // Channel handler — plain function (no failure for channels)
    abort: (data) => null,
  },
  // Positional default — only receives unhandled keys (hotel, car)
  (event) => ({ type: "other" as const, key: event.key }),
  60, // timeout
);

if (result.ok) {
  console.log(result.data); // handler return value
} else {
  console.log(result.status); // "exhausted" | "timeout"
}
```

`match()` overloads: handlers only, handlers + timeout, handlers + default, handlers + default + timeout. The second arg is disambiguated by type: `number` = timeout, `function` = default.

#### Async iteration

```typescript
for await (const event of sel) {
  console.log(event.key, event.data);
}
```

#### Remaining handles

```typescript
console.log(sel.remaining); // ReadonlySet<'flight' | 'hotel' | 'abort'>
```

### Select Event Types

Since step/child failures crash the workflow (happy-path model), select events are simplified:

| Handle Type | Event Shape |
|---|---|
| Step / Child Workflow | `{ key: K; data: T }` |
| Channel | `{ key: K; data: T }` |
| Stream Iterator | `{ key: K; status: "record"; data: T; offset: number } \| { key: K; status: "closed" }` |
| Lifecycle / User Event | `{ key: K; status: "set" } \| { key: K; status: "never" }` |

No `ok` field — for steps, channels, and children, the event IS the data.

### forEach / map (One-Shot Batch Processing)

Process all one-shot handles (StepHandle, ChildWorkflowHandle) concurrently. Callbacks receive successful data `T` directly (plain function) or a flat failure object (`{ onComplete, onFailure }`).

```typescript
// forEach — { onComplete, onFailure } for flight, plain function default
await ctx.forEach(
  { flight: flightHandle, hotel: hotelHandle, car: carHandle },
  {
    flight: {
      onComplete: (data) => { ctx.state.flightId = data.id; },
      onFailure: async (failure) => {
        await failure.compensate();
      },
    },
  },
  // Positional default — only receives "hotel" | "car" (type-narrowed)
  (key, data) => { ctx.logger.info(`${key} completed`); },
);

// map — { onComplete, onFailure } for specific keys
const ids = await ctx.map(
  { flight: flightHandle, hotel: hotelHandle },
  {
    flight: {
      onComplete: (data) => data.id,
      onFailure: async (failure) => {
        await failure.compensate();
        return "FAILED"; // fallback value
      },
    },
    hotel: (data) => data.id,
  },
);
// ids: { flight: string | undefined, hotel: string | undefined }
```

### Child Workflows

Child workflows in workflow code have no lifecycle control (`sigterm()` / `sigkill()` are removed). Lifecycle management is handled by scopes.

```typescript
// Sequential — returns T directly
const result = await ctx.workflows.payment.execute({
  workflowId: `payment-${ctx.rng.paymentId.uuidv4()}`,
  args: { amount: 100, customerId: "cust-123" },
  compensate: async (compCtx, result) => { /* ... */ },
});
// result is the decoded workflow result — T directly

// Concurrent — via scope
const data = await ctx.scope({
  child: ctx.workflows.payment.start({
    workflowId: "payment-1",
    args: { amount: 100 },
    compensate: async (compCtx, result) => { /* ... */ },
  }),
}, async ({ child }) => {
  return await child.join();
});

// Detached — fire-and-forget, no scope required
const handle = await ctx.workflows.notifications.startDetached({
  workflowId: `notify-${ctx.rng.notifyId.uuidv4()}`,
  args: { type: "booking-confirmed", customerId: "cust-123" },
});
// handle is limited: only channels.send() available
// The child runs independently — not terminated when parent fails

// Child interaction (in scope)
// child.channels.confirm.send({ approved: true }); // Send messages
// child.lifecycle.complete.wait();                   // Observe lifecycle
// child.events.processed.wait();                     // Observe events
// child.streams.auditLog.iterator(0);                // Read streams

// Get a handle to a non-child workflow (limited — only channels.send)
const otherHandle = ctx.workflows.order.get("order-123");
await otherHandle.channels.payment.send({ amount: 500 });
```

**`startDetached()`** is the ONLY way to start concurrent work without a scope. The child is not managed by structured concurrency, not compensated when the parent fails, and not terminated when the parent is signaled.

**Engine-level handles (`WorkflowHandleExternal`) retain `sigterm()` and `sigkill()`** — these are operational concerns for engine callers.

**Signal semantics:**
- **SIGTERM**: Current step terminates → `beforeCompensate` hook → compensations (LIFO) → `afterCompensate` hook. NOOP if already compensating.
- **SIGKILL**: Immediate termination. No compensation, no hooks.

### CompensationContext vs WorkflowContext

Both extend a shared `BaseContext` with channels, streams, events, patches, sleep, rng, logger, timestamp, and date.

**`WorkflowContext`** (happy-path):
- Steps: `.execute()` returns `T` directly, `.start()` returns `ScopeEntry<StepHandle>`
- Workflows: `.execute()` returns `T` directly, `.start()` returns `ScopeEntry<ChildWorkflowHandle>`
- Has `scope()`, `select()`, `forEach()`, `map()`, `addCompensation()`
- Concurrency primitives support `{ onComplete, onFailure }` handlers with unified single-param model

**`CompensationContext`** (defensive, full structured concurrency):
- Steps: `.execute()` returns `CompensationStepResult<T>`, `.start()` returns `ScopeEntry<CompensationStepHandle>`
- Workflows: `.execute()` returns `WorkflowResult<T>`, `.start()` returns `ScopeEntry<CompensationChildWorkflowHandle>`
- Has `scope()`, `select()`, `forEach()`, `map()` — all with failures visible in result types
- No `addCompensation()` (prevents nesting)
- No compensation callbacks on `.start()` or handlers (can't nest compensations)
- All unjoined handles are settled on compensation scope exit

**Virtual event loop:** When multiple compensation callbacks from the same scope need to run, the engine transparently interleaves their execution at durable operation `await` points. Each callback looks like normal sequential code — the engine handles concurrency and determinism via global sequence ordering and advisory locks.

### Channels (Message Passing)

Async communication between workflows.

```typescript
// Inside workflow — receive with timeout (discriminated union)
const result = await ctx.channels.payment.receive(300);
if (result.ok) {
  console.log(result.data); // z.output<PaymentSchema>
} else {
  console.log(result.status); // "timeout"
}

// Inside workflow — receive without timeout (returns T directly)
const msg = await ctx.channels.payment.receive();
// msg is the decoded value directly — no wrapper, no discriminated union
console.log(msg);

// From another workflow — send (fire-and-forget)
const handle = ctx.workflows.order.get("order-123");
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

// The factory also receives typed RNG accessors
const workflow = defineWorkflow({
  rng: { init: true },
  state: (ctx) => ({
    id: ctx.rng.init.uuidv4(),
  }),
  // ...
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
      return await ctx.steps.fraudCheck.execute(args.flightId);
    }, null);

    // Boolean form — removing old code
    if (!(await ctx.patches.removeLegacyEmail())) {
      await ctx.steps.sendLegacyEmail.execute(...);
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

### Suspension (Runtime Options)

Blocking primitives can optionally suspend the workflow — evicting it from memory and replaying when the wait condition is satisfied.

#### `ctx.sleep()` — `SleepRuntimeOptions`

```typescript
await ctx.sleep(86400 * 7, { suspend: true }); // Suspend immediately
await ctx.sleep(5);                              // Short sleep — no suspension
```

#### `ctx.channels.receive()` — `ChannelReceiveRuntimeOptions`

```typescript
// Stay hot for 10 minutes, then suspend
const decision = await ctx.channels.approval.receive(86400 * 3, {
  suspendAfter: 600,
});
```

#### `streamIterator.read()` — `StreamIteratorReadRuntimeOptions`

```typescript
const entry = await iterator.read(86400, { suspendAfter: 0 }); // Suspend immediately
```

#### `childWorkflowHandle.join()` and `ctx.workflows.execute()` — `ChildWorkflowJoinRuntimeOptions`

```typescript
const result = await childHandle.join({ suspendAfter: 30 });
```

**`suspendAfter` values:**

| Value               | Behavior                                                  |
| ------------------- | --------------------------------------------------------- |
| `"never"` (default) | Never suspend — stay in memory for the entire wait        |
| `0`                 | Suspend immediately when the call blocks                  |
| `N > 0`             | Stay in memory for N seconds ("hot window"), then suspend |

**NOT suspendable:** `stepHandle.join()` (steps execute in-process), `select.next()` / `select.match()` (hold live handle references).

### Error Observability

Failed steps and workflows expose detailed error information.

**`StepExecutionError`** — per-attempt error:

```typescript
interface StepExecutionError {
  readonly message: string;
  readonly type: string;       // error class name
  readonly attempt: number;    // 1-indexed
  readonly timestamp: number;  // epoch ms
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

**`WorkflowExecutionError`** — workflow-level error (without `attempt`):

```typescript
interface WorkflowExecutionError {
  readonly message: string;
  readonly type: string;
  readonly timestamp: number;
  readonly details?: Record<string, unknown>;
}
```

Engine-level results include error information:

```typescript
const result = await engine.workflows.travel.execute({ workflowId: "...", args: { ... } });
if (!result.ok && result.status === "failed") {
  console.log(result.error.message);  // WorkflowExecutionError
  console.log(result.error.type);
}
```

## Type System: Input vs Output

Every schema has **input** (encoded for DB) and **output** (decoded for runtime) types:

| Context                               | Type               | Reason           |
| ------------------------------------- | ------------------ | ---------------- |
| Step execute **returns**              | `z.input<Schema>`  | Encoded to JSONB |
| Step `.execute()` / `.join()` **returns** | `z.output<Schema>` | Decoded from DB  |
| Channel **send** accepts              | `z.input<Schema>`  | Saved to DB      |
| Channel **receive** returns           | `z.output<Schema>` | Decoded from DB  |
| Stream **write** accepts              | `z.input<Schema>`  | Saved to DB      |
| Stream **read** returns               | `z.output<Schema>` | Decoded from DB  |
| Workflow **execute** returns          | `z.input<Schema>`  | Saved to DB      |
| Workflow **getResult** returns        | `z.output<Schema>` | Decoded from DB  |

## Result Types

### Workflow-Internal (happy-path model)

Step and child workflow results in `WorkflowContext` are **not discriminated unions** — `.execute()` and `.join()` return `T` directly. Failure auto-terminates the workflow.

Timeout overloads on `.join()` return a discriminated union since timeout is an expected outcome:

```typescript
type StepJoinResultWithTimeout<T> =
  | { status: "complete"; data: T }
  | { status: "timeout" };
```

### Workflow-Internal (try variants — callback-based)

`tryExecute()` and `tryJoin()` accept `{ onComplete, onFailure }` callbacks. The workflow does NOT auto-terminate — the developer handles outcomes explicitly inside the callbacks. No result unions are returned; instead, the return value of whichever callback fires becomes the method's return value.

**Return type:** `Promise<Awaited<R1> | Awaited<R2>>` where `R1` and `R2` are independently inferred from each callback's return type. Async callbacks are automatically unwrapped via `Awaited`.

**`onFailure` receives a single flat parameter:**

```typescript
// With compensate — failure includes compensate()
onFailure: (failure: StepFailureInfo & { compensate: () => Promise<void> }) => R;

// Without compensate — plain failure info
onFailure: (failure: StepFailureInfo) => R;
```

For child workflows, `failure` is `ChildWorkflowFailureInfo` (discriminated: `"failed" | "terminated"`), optionally augmented with `compensate()`.

Timeout overloads on `tryJoin` add an `onTimeout: () => R` callback.

**`failure.compensate()` semantics (unified across all `onFailure` surfaces):**
- Calling it switches to compensation mode (SIGTERM-resilient), runs the callback to completion, discharges from LIFO.
- Not calling it → engine runs it after `onFailure` returns / at scope exit (safe default).
- Same mechanism in `match`/`forEach`/`map` and `tryExecute`/`tryJoin`.

### Compensation-Internal

`CompensationStepResult<T>` — steps inside `CompensationContext` (via `.execute()` or `.join()` on `CompensationStepHandle`):

```typescript
type CompensationStepResult<T> =
  | { ok: true;  status: "complete";   data: T;  errors: StepErrorAccessor }
  | { ok: false; status: "failed";     reason: "attempts_exhausted" | "timeout"; errors: StepErrorAccessor };
```

No `"terminated"` — the only way to terminate during compensation is SIGKILL, which tears down the process immediately.

### Channel, Stream, Event Results (unchanged)

| Type                          | Success    | Failure Statuses                               |
| ----------------------------- | ---------- | ---------------------------------------------- |
| `ChannelReceiveResult`        | `received` | `timeout`                                      |
| `ChannelSendResult`           | `sent`     | `not_found`                                    |
| `StreamReadResult`            | `received` | `closed`, `timeout`, `not_found`               |
| `StreamIteratorReadResult`    | `record`   | `closed`, `timeout`                            |
| `EventWaitResult`             | `set`      | `never`, `timeout`                             |
| `EventCheckResult`            | `set`      | `not_set`, `never`, `not_found`                |
| `SignalResult`                | `sent`     | `already_finished`, `not_found`                |
| `SelectMatchResult`           | `matched`  | `exhausted`                                    |
| `SelectMatchResultWithTimeout`| `matched`  | `exhausted`, `timeout`                         |

### Engine-Level Results

Engine-level types retain full result unions since engine callers need to handle all outcomes:

| Type                         | Success    | Failure Statuses                               |
| ---------------------------- | ---------- | ---------------------------------------------- |
| `WorkflowResult`             | `complete` | `failed` (with `error`), `terminated`          |
| `WorkflowResultExternal`     | `complete` | `failed` (with `error`), `terminated`, `timeout`, `not_found` |

### Timeout-Free Overloads

When a blocking primitive is called **without** a timeout, the return type excludes the `timeout` status entirely:

**Happy-path (auto-terminates on failure):**
- `StepHandle.join()` → `T` vs `StepJoinResultWithTimeout<T>` (with timeout)
- `ChildWorkflowHandle.join()` → `T` vs `ChildWorkflowJoinResultWithTimeout<T>`

**Try variants (callback-based — return type is `Awaited<R1> | Awaited<R2>` from callbacks):**
- `StepHandle.tryJoin({ onComplete, onFailure })` → `Awaited<R1> | Awaited<R2>` (with timeout: `Awaited<R1> | Awaited<R2> | Awaited<R3>`)
- `ChildWorkflowHandle.tryJoin({ onComplete, onFailure })` → `Awaited<R1> | Awaited<R2>` (with timeout: `Awaited<R1> | Awaited<R2> | Awaited<R3>`)
- `onFailure`'s parameter includes `compensate()` only when `HasCompensation = true` on the handle

**Compensation (failures always explicit):**
- `CompensationStepHandle.join()` → `CompensationStepResult<T>` vs `CompensationStepJoinResultWithTimeout<T>`
- `CompensationChildWorkflowHandle.join()` → `WorkflowResult<T>` vs `CompensationChildWorkflowJoinResultWithTimeout<T>`

**Other:**
- `Selection.next()` → `SelectNextResultNoTimeout` vs `SelectNextResult`
- `Selection.match()` → `SelectMatchResult` vs `SelectMatchResultWithTimeout`
- `ChannelHandle.receive()` → `T` directly vs `ChannelReceiveResult` (with timeout)
- `EventAccessor.wait()` → `EventWaitResultNoTimeout` vs `EventWaitResult`
- `StreamIteratorHandle.read()` → `StreamIteratorReadResultNoTimeout` vs `StreamIteratorReadResult`
- `StreamReaderAccessor.read()` → `StreamReadResultNoTimeout` vs `StreamReadResult`

## Visibility Rules

### Inside Workflow (`WorkflowContext`)

| Resource                       | Operations                                                            |
| ------------------------------ | --------------------------------------------------------------------- |
| `ctx.steps.*`                  | `.execute()` → `T`, `.tryExecute({ onComplete, onFailure })` → `Awaited<R1> \| Awaited<R2>`, `.start()` → `ScopeEntry<StepHandle<T, bool>>` |
| `ctx.channels.*`               | `.receive(options?)` / `.receive(timeout, options?)`                  |
| `ctx.streams.*`                | `.write()`                                                            |
| `ctx.events.*`                 | `.set()`                                                              |
| `ctx.workflows.*`              | `.start()` → `ScopeEntry<ChildWorkflowHandle<..., bool>>`, `.execute()` → `T`, `.tryExecute({ onComplete, onFailure })` → `Awaited<R1> \| Awaited<R2>`, `.startDetached()`, `.get()` |
| `ctx.patches.*`                | `()` → boolean, `(callback, default?)` → callback result or default  |
| `ctx.scope()`                  | Structured concurrency boundary                                       |
| `ctx.select()`                 | Multiplex handles (`.next()`, `.match()`, async iteration)            |
| `ctx.forEach()`                | Process one-shot handles concurrently                                 |
| `ctx.map()`                    | Transform one-shot handle results concurrently                        |
| `ctx.addCompensation()`        | Register LIFO compensation callback                                   |
| `ctx.sleep(seconds, options?)` | Durable sleep                                                         |
| `ctx.rng.*`                    | Typed deterministic RNG streams                                       |
| `ctx.timestamp` / `ctx.date`   | Deterministic time                                                    |
| `ctx.logger`                   | Replay-aware logger                                                   |

### Inside Compensation (`CompensationContext`)

| Resource                       | Operations                                                            |
| ------------------------------ | --------------------------------------------------------------------- |
| `ctx.steps.*`                  | `.execute()` → `CompensationStepResult<T>`, `.start()` → `ScopeEntry<CompensationStepHandle>` |
| `ctx.channels.*`               | `.receive()`                                                          |
| `ctx.streams.*`                | `.write()`                                                            |
| `ctx.events.*`                 | `.set()`                                                              |
| `ctx.workflows.*`              | `.execute()` → `WorkflowResult<T>`, `.start()` → `ScopeEntry<CompensationChildWorkflowHandle>`, `.get()` → limited handle |
| `ctx.scope()`                  | Structured concurrency boundary (all unjoined handles settled)        |
| `ctx.select()`                 | Multiplex handles — failures visible in events                        |
| `ctx.forEach()`                | Process one-shot handles — callbacks receive result unions             |
| `ctx.map()`                    | Transform one-shot handle results — callbacks receive result unions    |
| `ctx.sleep()` / `ctx.rng.*`   | Same as WorkflowContext                                               |
| `ctx.logger`                   | Replay-aware logger                                                   |

### Parent → Child Workflow (`ChildWorkflowHandle`)

| Resource          | Operations                                |
| ----------------- | ----------------------------------------- |
| `.join(options?)`  | Wait for result (supports `suspendAfter`) |
| `.tryJoin(options?)`| Wait with result union — type depends on `HasCompensation` |
| `.channels.*`     | `.send()` (fire-and-forget)               |
| `.lifecycle.*`    | `.wait()`, `.get()`                       |
| `.events.*`       | `.wait()`, `.get()`                       |
| `.streams.*`      | `.read()`, `.iterator()`, `.isOpen()`     |

### Parent → Non-Child Workflow (`.get()` handle)

| Resource      | Operations                       |
| ------------- | -------------------------------- |
| `.channels.*` | `.send()` only (fire-and-forget) |

### External (`engine.workflows.*`)

| Resource   | Operations                                            |
| ---------- | ----------------------------------------------------- |
| `.start()` | Start workflow, returns `WorkflowHandleExternal`      |
| `.execute()` | Start + wait for result (sugar for start + getResult) |
| `.get()`   | Get handle to existing workflow                       |

### External Handle (`WorkflowHandleExternal`)

Engine-level waits use `{ signal?: AbortSignal }` instead of numeric timeouts.

| Resource                    | Operations                                               |
| --------------------------- | -------------------------------------------------------- |
| `.channels.*`               | `.send()`                                                |
| `.streams.*`                | `.read(offset, { signal? })`, `.iterator()`, `.isOpen()` |
| `.events.*`                 | `.wait({ signal? })`, `.isSet()`                         |
| `.lifecycle.*`              | `.wait({ signal? })`, `.get()`                           |
| `.getResult({ signal? })`   | Wait for result                                          |
| `.sigterm()` / `.sigkill()` | Send signals (engine-level only)                         |
| `.setRetention()`           | Update retention policy                                  |

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
  workflowId: "vip-order",
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
    // .execute() returns T directly — no result checking needed
    const result = await ctx.steps.greet.execute("World");
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
const result = await engine.workflows.hello.execute({ workflowId: "hello-1" });
if (result.ok) {
  console.log(result.data.message); // "Hello, World!"
} else if (result.status === "failed") {
  console.error(result.error.message);
}

// Or start() for a handle with full control
const handle = await engine.workflows.hello.start({ workflowId: "hello-2" });
const result2 = await handle.getResult();

await engine.shutdown();
```

## Project Structure

```
src/
├── index.ts      # Public exports
├── types.ts      # Type definitions (canonical type system)
├── workflow.ts   # defineStep, defineWorkflow
├── engine.ts     # WorkflowEngine
└── example.ts    # Comprehensive usage examples
```

## Status

Work in Progress — Public API design complete. Internal implementation pending.

### Complete

- Type definitions with standard schema support
- `defineStep()` — flat structure with `execute`, `schema`, `retryPolicy`
- `defineWorkflow()` with full type safety
- **Happy-path model** — `.execute()` returns `T` directly, failures auto-terminate
- **Structured concurrency** via `ctx.scope()` — `.start()` only inside scopes, `ScopeEntry` branded type
- **One compensation callback per handle** — defined at `.start()` or `.execute()` time, full `CompensationContext` with result
- **Scope exit behavior** — handles with `compensate` → compensated; without → settled
- **Unified `onFailure`** — `{ onComplete, onFailure }` handler entries; `onFailure` receives a single flat failure object with `compensate()` merged in when applicable
- **Virtual event loop** — engine interleaves concurrent compensation callbacks transparently
- `BaseContext` / `WorkflowContext` / `CompensationContext` hierarchy
- **CompensationContext with full structured concurrency** — `scope()`, `select()`, `forEach()`, `map()`, `.start()` returning handles, failures always explicit in result types
- `CompensationStepResult<T>` for defensive compensation code (no `"terminated"` — only `"complete"` and `"failed"`)
- `CompensationStepHandle` / `CompensationChildWorkflowHandle` for concurrent compensation operations
- Error observability — `StepExecutionError`, `StepErrorAccessor`, `WorkflowExecutionError`
- `ctx.select()` — happy-path events, positional default handler, `{ onComplete, onFailure }` handler entries (unified single-param)
- `ctx.forEach()` / `ctx.map()` — positional default handler with type narrowing, `{ onComplete, onFailure }` handler entries (unified single-param)
- `startDetached()` for fire-and-forget child workflows outside scopes
- Channel receive without timeout returns `T` directly (no wrapper)
- Child workflow handles without lifecycle control (no `sigterm()` / `sigkill()`)
- Engine-level handles retain `sigterm()`, `sigkill()`, `getResult()` with `WorkflowExecutionError`
- Lifecycle events with "never" semantics
- Stream iterators (streams close implicitly on workflow termination)
- Patches for safe workflow code evolution
- Suspension via per-primitive runtime options
- Typed deterministic RNG (`ctx.rng.*`)
- Consistent timeout-free overloads

### Removed from previous API

- `StepCompensation<TArgs>` (start-time step reference) — replaced by full compensation callbacks
- Five `unjoined` strategies (`kill`, `settle`, `join`, `terminate`, `compensate`) — replaced by single rule: compensate if callback exists, settle if not
- `{ on, compensate }` handler entries on match/forEach/map — replaced by `{ onComplete, onFailure }` with single flat failure param
- Join-time compensation (separate compensation definition at `.join()`) — compensation is now defined once at `.start()` / `.execute()` time only
- `StepResult<T>` / `StepJoinResult<T>` — replaced by happy-path `T` return
- `WorkflowResult<T>` for child `.execute()` — replaced by `T` return
- `StepHandle.sigkill()` — steps have no lifecycle control
- `ChildWorkflowHandle.sigterm()` / `.sigkill()` — removed from workflow code
- `"terminated"` from workflow-visible step types (stays in compensation types)
- `ok` field from `HandleSelectEvent` for step/child handles
- `_default` key convention in handlers (replaced by positional default with proper type narrowing)
- `CompensationStepObject.run()` (renamed to `.execute()`)
- `"terminated"` from `CompensationStepResult` (only SIGKILL can terminate during compensation — invisible)
- `ChannelReceiveResultNoTimeout` wrapper (channel receive without timeout returns `T` directly)
- `defineTransaction()` — transactions leaked storage semantics
- Queries — replaced by streams + events
- `cancelSchema` — replaced by signals
- Step-level compensations — replaced by callback model
- `stream.close()` — streams close implicitly

## License

MIT
