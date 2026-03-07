# Durable Workflow Engine

A type-safe, Postgres-backed durable execution engine for TypeScript.

## What makes it special

- **A library, not a bible.** Gradual adoption, lightweight in-process durable execution without additional infrastructure.
- **Postgres backed.** No additional infra needed, only a Postgres instance.
- **Fully typed.** Everything is type safe thanks to standard schema support (Zod v4, etc.).
- **Three-tier awaitable hierarchy.** A compile-time enforced separation between execute-only handles (steps, scopes), directly awaitable blocking primitives (sleep, channel receives), and directly awaitable atomic operations (stream writes, event sets, etc.).
- **Closure-based structured concurrency.** Scope entries are always `(ctx) => Promise<T>` closures. Each branch closure receives a path-specialized context — no context leaking across branch boundaries.
- **One compensation callback per handle.** Defined via `.compensate(cb)` builder. Full `CompensationContext` with structured concurrency.
- **The actor model.** Workflows are independent and decoupled from each other.
- **State is not stored.** Workflow state is derived from replay — keeps workflows modifiable.

## Philosophy

- **Happy path by default, explicit when needed** — Workflow code describes business intent, not error handling plumbing. The engine handles retries, compensation, and cleanup. `.failure(cb)` opts in to explicit error handling for individual operations.
- **Explicit over implicit** — No decorators, no global state, no magic.
- **Structured concurrency** — Every concurrent branch lives inside `ctx.scope(name, entries, callback)` as a closure `(ctx) => Promise<T>`. Branches with compensated steps are compensated on exit; others are settled.
- **Sound compensation** — One callback per handle via `.compensate(cb)` builder. `{ complete, failure }`, `{ failure }`, and `onFailure` handler forms for explicit failure recovery. Virtual event loop for concurrent compensation execution. Branch `failure` callbacks take no arguments — branch closures handle their own error logic internally.
- **Type safety** — Full TypeScript inference with standard schemas. Impossible states are unrepresentable.
- **Deterministic replay** — Global sequence ordering for reproducible execution.

## Awaitable Tier Hierarchy

Primitives are split into three tiers based on how they can be awaited. This is enforced at compile time — no runtime checks needed.

```
DeterministicAwaitable<T, TRoot>   — execute-only; no then(); requires .resolve(ctx) or ctx.join()
  └── BranchHandle<T, TScopePath, TRoot>

DirectAwaitable<T>                 — has then(); directly awaitable; NOT a scope entry
  └── WorkflowAwaitable<T>         — has then(); directly awaitable; CAN be a scope entry
        └── ChannelReceiveCall<T>  — accepted by select/listen
```

**Tier 1 — Execute-only (`DeterministicAwaitable`, `BranchHandle`):**
Steps, child workflows (result mode), scope/all/first results. Must be resolved via `await handle.resolve(ctx)` on base contexts, or `await ctx.join(branchHandle)` on concurrency contexts. The scope-path brand on `BranchHandle` gives compile-time lifetime guarantees.

**Tier 2 — Blocking, directly awaitable and valid scope entry (`WorkflowAwaitable`):**
`ctx.sleep()`, `ctx.sleepUntil()`, `ctx.channels.X.receive()` (all overloads), `scheduleHandle.sleep()`, `lifecycleEvent.wait()`. Directly `await`-able or passable as a scope entry.

**Tier 3 — Atomic, directly awaitable but NOT a scope entry (`DirectAwaitable`):**
`ctx.streams.X.write()`, `ctx.events.X.set()`, `ctx.patches.X`, `foreignHandle.channels.X.send()`, `ctx.channels.X.receiveNowait()`, `ctx.childWorkflows.X.startDetached()`, `lifecycleEvent.get()`. These complete atomically at the engine level and cannot block as concurrent scope branches.

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

**In `WorkflowContext`:** calling a step returns a `StepCall<T>` (Tier 1 — execute-only). Chain builders before resolving via `.resolve(ctx)`:

```typescript
// Happy path — resolve via .resolve(ctx)
const flight = await ctx.steps.bookFlight("Paris", "cust-1").resolve(ctx);
// flight is { id: string, price: number } — the decoded result

// With compensation — callback ALWAYS runs if an attempt was made.
// The step is idempotent and side effects may have occurred even on failure.
const flight = await ctx.steps.bookFlight("Paris", "cust-1").compensate(async (ctx) => {
    // No status check — always attempt to cancel.
    await ctx.steps.cancelFlight("Paris", "cust-1").resolve(ctx);
  }).resolve(ctx);

// With retry override
const flight = await ctx.steps
    .bookFlight("Paris", "cust-1")
    .retry({ maxAttempts: 5, intervalSeconds: 3 }).resolve(ctx);
```

**`.failure()` / `.complete()` — explicit error handling:** When you need to observe step failures without auto-terminating the workflow, chain `.failure(cb)`. Optionally `.complete(cb)` to transform the success result:

```typescript
const flightId = await ctx.steps
    .bookFlight("Paris", "cust-1")
    .compensate(async (ctx) => {
      await ctx.steps.cancelFlight("Paris", "cust-1").resolve(ctx);
    })
    .failure(async (failure) => {
      ctx.logger.warn("Flight booking failed", { reason: failure.reason });
      return null;
    })
    .complete((data) => data.id).resolve(ctx);

// Without .compensate()
const carId = await ctx.steps
    .reserveCar("Paris", "dates")
    .failure(() => null)
    .complete((data) => data.id).resolve(ctx);
```

**In `CompensationContext`:** calling a step returns a `CompensationStepCall<T>` (Tier 1 — execute-only) that resolves to `CompensationStepResult<T>` — a discriminated union that compensation code must handle gracefully.

```typescript
// Sequential compensation
const cancelResult = await ctx.steps.cancelFlight("Paris", "cust-1").resolve(ctx);
if (!cancelResult.ok) {
  ctx.logger.error("Failed to cancel flight", {
    reason: cancelResult.status,
    errors: await cancelResult.errors.all(),
  });
}

// Concurrent compensation with scope
await ctx.scope(
    "NotifyAndCancel",
    {
      cancel: async (ctx) => ctx.steps.cancelFlight("Paris", "cust-1").resolve(ctx),
      notify: async (ctx) =>
        ctx.steps.sendEmail("customer@example.com", "Cancelled", "...").resolve(ctx),
    },
    async (ctx, { cancel, notify }) => {
      const cancelResult = await ctx.join(cancel);
      const notifyResult = await ctx.join(notify);
    },
  ).resolve(ctx);
```

`"terminated"` is NOT included in `CompensationStepResult` — the only way to terminate during compensation is SIGKILL, which tears down the process immediately.

Steps have no lifecycle control — they are function calls, not processes. They run to completion based on their retry policy and timeout.

### Structured Concurrency (`ctx.scope(name, entries, callback)`)

Every concurrent branch must exist within a **scope** — a lexical boundary that manages branch lifecycle. Entries are always async closures: `(ctx) => Promise<T>`.

Each closure receives a path-specialized context as its argument — a `WorkflowContext` (or `CompensationContext`) typed with the branch's exact scope path. This prevents accidental closure over the outer context and enables compile-time lifetime tracking.

`ctx.scope(...)` always returns a Tier 1 `DeterministicAwaitable` — resolve it via `.resolve(ctx)`:

```typescript
const winner = await ctx.scope(
    "BookTravelOptions",
    {
      flight: async (ctx) =>
        ctx.steps.bookFlight("Paris", "cust-1").compensate(async (ctx) => {
            await ctx.steps.cancelFlight("Paris", "cust-1").resolve(ctx);
          }).resolve(ctx),
      hotel: async (ctx) =>
        ctx.steps.bookHotel(city, checkIn, checkOut).compensate(async (ctx) => {
            await ctx.steps.cancelHotel(city, checkIn, checkOut).resolve(ctx);
          }).resolve(ctx),
    },
    async (ctx, { flight, hotel }) => {
      // ctx is WorkflowConcurrencyContext
      // flight, hotel are BranchHandle<T> (Tier 1) — join them or pass to select
      const sel = ctx.select({ flight, hotel });
      for await (const { key, result } of ctx.match(sel)) {
        return result;
      }
      throw new Error("All handles exhausted");
    },
  ).resolve(ctx);
```

To race a child scope against an outer branch, place the inner scope in entries rather than creating it inside the callback:

```typescript
await ctx.scope(
    "Parent",
    {
      timer: async (ctx) => {
        await ctx.sleep(10);
        return "timeout" as const;
      },
      child: async (ctx) =>
        ctx.scope(
            "Child",
            {
              work: async (ctx) => {
                await ctx.sleep(1);
                return "done" as const;
              },
            },
            async (ctx, { work }) => await ctx.join(work),
          ).resolve(ctx),
    },
    async (ctx, { timer, child }) => {
      const sel = ctx.select({ timer, child });
      for await (const { key, result } of ctx.match(sel, {
        timer: (v) => v,
        child: (v) => v,
      })) {
        return result;
      }
      return "timeout" as const;
    },
  ).resolve(ctx);
```

For the common "run everything and collect all resolved values" case, use `ctx.all(entries)`:

```typescript
const result = await ctx.all({
    flight: async (ctx) => ctx.steps.bookFlight("Paris", "cust-1").resolve(ctx),
    hotel: async (ctx) => ctx.steps.bookHotel("Paris", checkIn, checkOut).resolve(ctx),
  }).resolve(ctx);
// result.flight -> Flight
// result.hotel -> Hotel
```

For dynamic fan-out over a runtime-determined set, use `ctx.all()` inside a single branch closure:

```typescript
const quotes = await ctx.scope(
    "QuoteFanout",
    {
      allQuotes: async (ctx) =>
        ctx.all(
            Object.fromEntries(
              args.providers.map((p) => [
                p,
                async (ctx) => ctx.steps.getQuote(p, args.destination).resolve(ctx),
              ]),
            ),
          ).resolve(ctx),
    },
    async (ctx, { allQuotes }) => ctx.join(allQuotes),
  ).resolve(ctx);
```

For returning the first branch to complete, use `ctx.first(entries)`:

```typescript
const winner = await ctx.first({
    fast: async (ctx) => ctx.steps.fastRoute(destination).resolve(ctx),
    cheap: async (ctx) => ctx.steps.cheapRoute(destination).resolve(ctx),
  }).resolve(ctx);
// winner: { key: "fast" | "cheap"; result: Route }

// With a fallback if all branches fail (required on CompensationContext):
const winner = await ctx.first({ ... }, null).resolve(ctx);
// winner: { key: ...; result: Route } | null
```

**Scope possession and naming rules:**

- Every scope must be named: `ctx.scope("ScopeName", entries, callback)`.
- Branch handles are branded with the scope lineage and can only be consumed by `select` or `join` in the current scope or descendant scopes.
- Child scopes cannot reuse an ancestor scope name (compile-time check for literal names).
- Under the same parent scope, duplicate active child scope names are rejected at runtime.
- Widened `string` names are allowed, but once a dynamic key appears in the scope path, compile-time ancestor-name collision detection is disabled for all nested scopes. You are responsible for uniqueness manually in that case.

### Scope Exit Behavior

The presence of a `.compensate()` builder determines what happens to unjoined branches when a scope exits:

| Condition                      | Branch has compensated steps | No compensated steps          |
| ------------------------------ | ---------------------------- | ----------------------------- |
| Normal exit (callback returns) | Compensation runs            | Settled (wait, ignore result) |
| Error exit (callback throws)   | Compensation runs            | Settled (wait, ignore result) |

### Compensation Model

Each handle has at most **one compensation callback**, registered via the `.compensate(cb)` builder before resolving. The callback receives a full `CompensationContext`.

```typescript
const flight = await ctx.steps.bookFlight("Paris", "cust-1").compensate(async (ctx, result) => {
    // result: StepCompensationResult<T> — available if you need it, but
    // compensation should ALWAYS run regardless of result.status.
    //
    // Rationale: if any attempt was made, the remote system may have already
    // processed the request but failed to send the response. The step is
    // idempotent; the compensation callback assumes at-least-once delivery.
    await ctx.steps.cancelFlight("Paris", "cust-1").resolve(ctx);
  }).resolve(ctx);
```

Properties:

- **Full `CompensationContext`** — has steps, childWorkflows, channels, streams, events, and scope.
- **Scope-local concurrency context** — full `select/match` with branch handles is available as the first callback argument of `ctx.scope(name, ...)`.
- **Has access to the outcome** via `result` parameter — available if needed, but unconditional compensation is the safe default.
- **Pushed onto the LIFO compensation stack** at call time.
- **Virtual event loop** — when multiple compensation callbacks from the same scope need to run, the engine transparently interleaves their execution at durable operation `await` points for concurrency, while keeping each callback's code sequential.

#### `addCompensation()` (general purpose)

Available on `WorkflowContext` for non-step cleanup. Not available on `CompensationContext` (no nesting).

```typescript
ctx.addCompensation(async (ctx) => {
  await ctx.channels.notifications.send({ type: "rollback" });
});
```

### `.failure()` / `.complete()` — Explicit Failure Handling

The `.failure(cb)` builder on `StepCall` / `WorkflowCall` provides explicit failure handling without auto-terminating the workflow. Chain after `.compensate()` if needed — compensation remains engine-managed and runs during normal LIFO unwinding.

```typescript
const ids = await ctx.scope(
    "BookHandles",
    {
      flight: async (ctx) =>
        ctx.steps.bookFlight(dest, customerId).resolve(ctx),
      hotel: async (ctx) =>
        ctx.steps.bookHotel(dest, checkIn, checkOut).resolve(ctx),
    },
    async (ctx, { flight, hotel }) => {
      for await (const { key, result } of ctx.match(ctx.select({ flight, hotel }), {
        flight: {
          complete: (data) => ({ flightId: data.id, hotelId: null }),
          failure: () => ({ flightId: null, hotelId: null }),
        },
        hotel: {
          complete: (data) => ({ flightId: null, hotelId: data.id }),
          failure: () => ({ flightId: null, hotelId: null }),
        },
      })) {
        return result;
      }
      throw new Error("Selection exhausted");
    },
  ).resolve(ctx);
```

**Handler shapes for concurrency primitives:**

- `(data) => ...` — plain function. Receives successful data `T`. Failure crashes the workflow (branch handles) or resolves with the received value (channel receive calls).
- `{ complete, failure }` — explicit handling for branch handles only. `failure` callback takes no arguments — branch closures handle their own error logic internally.
- `{ complete }` only — failure auto-terminates (or uses `onFailure`).
- `{ failure }` only — complete yields data unchanged (identity); failure handled explicitly.

**Step and child workflow failure info:**

- `StepFailureInfo` — `{ reason: "attempts_exhausted" | "timeout", errors: StepErrorAccessor }` — passed to `.failure(cb)` on a `StepCall`.
- `ChildWorkflowFailureInfo` — discriminated union: `{ status: "failed", error: WorkflowExecutionError } | { status: "terminated", reason: WorkflowTerminationReason }` — passed to `.failure(cb)` on a `WorkflowCall`.

### Select and Match (Concurrency Primitives)

`ctx.select()` and `ctx.match()` are available only on concurrency contexts (inside scope callbacks). Use `ctx.listen()` on any context for channel-only multiplexing.

#### `ctx.select()` — branch + channel multiplexing

```typescript
// One-shot receive: key removed from `remaining` after resolving
const sel = ctx.select({
  flight: flightHandle,
  cancel: ctx.channels.cancel.receive(), // ChannelReceiveCall — one-shot
});

// Streaming channel: key NEVER removed from `remaining`
const sel2 = ctx.select({
  booking: bookingHandle,
  cancel: ctx.channels.cancel, // ChannelHandle — fires on every message
});
```

**Channel input forms — two distinct semantics:**

- `ctx.channels.<n>` (`ChannelHandle`) — streaming; fires on every new message; the key is **never** removed from `remaining`. Use for long-running consumer loops.
- `ctx.channels.<n>.receive(...)` (`ChannelReceiveCall` — Tier 2) — one-shot; resolves exactly once; key **is** removed from `remaining`.

#### `ctx.match()` — key-aware async iteration

Primary iteration surface for `Selection<M>`. Four call forms:

- `ctx.match(sel)` — identity for all keys; yields `{ key, result }`. Branch failures auto-terminate.
- `ctx.match(sel, onFailure)` — identity, `onFailure` catches every branch failure.
- `ctx.match(sel, handlers)` — per-key handlers; omitted keys yield data unchanged.
- `ctx.match(sel, handlers, onFailure)` — per-key handlers + default failure catch-all.

```typescript
const sel = ctx.select({
  flight: flightHandle,
  hotel: hotelHandle,
  cancel: ctx.channels.cancel.receive(),
});

for await (const result of ctx.match(
  sel,
  {
    flight: {
      complete: (data) => ({ ok: true as const, id: data.id }),
      failure: () => ({ ok: false as const, id: null }),
    },
    cancel: () => ({ ok: false as const, id: null }),
  },
  () => ({ ok: false as const, id: null }),
)) {
  if (result.ok) return result.id;
}
```

#### `ctx.listen()` — channel-only multiplexing (all contexts)

Available on all contexts (base and concurrency). Accepts only `ChannelHandle` and `ChannelReceiveCall`. Returns a `Listener<M>` — directly iterable, yields `{ key, message }`:

```typescript
// Available even outside a scope callback
for await (const { key, message } of ctx.listen({
  cancel: ctx.channels.cancel,
  payment: ctx.channels.payment.receive(300),
})) {
  if (key === "cancel") break;
  if (key === "payment") handlePayment(message);
}
```

#### Time-bounded step/child patterns (`scope + sleep`)

Sleep (`ctx.sleep()`, `ctx.sleepUntil()`) is a Tier 2 `WorkflowAwaitable` — directly awaitable or usable as a scope entry. Model time bounds by racing work against a durable sleep closure:

```typescript
// Step race: step result vs timer
const stepRace = await ctx.scope(
    "StepTimeoutRace",
    {
      flight: async (ctx) => ctx.steps.bookFlight(dest, customerId).resolve(ctx),
      timer: async (ctx) => {
        await ctx.sleep(30);
        return "timed_out" as const;
      },
    },
    async (ctx, { flight, timer }) => {
      const sel = ctx.select({ flight, timer });
      for await (const val of ctx.match(sel, {
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
  ).resolve(ctx);

// Child workflow race: child completion vs timer
const childRace = await ctx.scope(
    "ChildTimeoutRace",
    {
      payment: async (ctx) =>
        ctx.childWorkflows.payment({
            idempotencyKey: "payment-1",
            args: { amount: 100, customerId: "cust-1" },
          }).resolve(ctx),
      timer: async (ctx) => {
        await ctx.sleep(45);
        return "timed_out" as const;
      },
    },
    async (ctx, { payment, timer }) => {
      const sel = ctx.select({ payment, timer });
      for await (const val of ctx.match(sel, {
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
  ).resolve(ctx);
```

Sleep is also directly awaitable at any level (no scope required):

```typescript
let nextRunAt = ctx.timestamp;
while (true) {
  nextRunAt += 10 * 60 * 1000;
  await ctx.sleepUntil(nextRunAt); // WorkflowAwaitable — directly awaitable
  await ctx.steps.runTick().resolve(ctx);
}
```

#### Remaining handles

```typescript
console.log(sel.remaining); // ReadonlySet<'flight' | 'hotel' | 'cancel'>
```

`remaining` tracks keys that have not yet been removed. Branch handle keys are removed when the branch completes or fails. `ChannelReceiveCall` keys are removed after the single receive resolves. **Raw `ChannelHandle` keys are never removed** — they represent an infinite stream.

### Child Workflows

Child workflow access is split by semantics:

- **`ctx.childWorkflows.*`** — structured invocation, lifecycle managed by parent.
- **`ctx.foreignWorkflows.*`** — message-only handles to existing workflow instances.
- Child starts also accept optional immutable `metadata` for audit/filtering.
- `idempotencyKey` is optional on workflow starts. If omitted, the engine generates a unique key.

```typescript
const checkoutWorkflow = defineWorkflow({
  name: "checkout",
  childWorkflows: {
    payment: paymentWorkflow, // callable as ctx.childWorkflows.payment(...)
  },
  foreignWorkflows: {
    campaign: campaignWorkflow, // handle via ctx.foreignWorkflows.campaign.get(key)
  },
});
```

```typescript
// Sequential — childWorkflows call returns WorkflowCall<T> (Tier 1 — execute-only)
const result = await ctx.childWorkflows
    .payment({
      idempotencyKey: `payment-${ctx.rng.paymentId.uuidv4()}`,
      metadata: { tenantId: "tenant-acme", correlationId: "req-42" },
      seed: "payment-seed-cust-123",
      args: { amount: 100, customerId: "cust-123" },
    })
    .compensate(async (ctx, result) => {
      /* ... */
    }).resolve(ctx);

// Concurrent — via scope closure
const receiptId = await ctx.scope(
    "AwaitPaymentReceipt",
    {
      child: async (ctx) => {
        const result = await ctx.childWorkflows.payment({
            idempotencyKey: "payment-1",
            metadata: { tenantId: "tenant-acme" },
            seed: "payment-seed-1",
            args: { amount: 100, customerId: "cust-123" },
          }).resolve(ctx);
        return result.receiptId;
      },
    },
    async (ctx, { child }) => ctx.join(child),
  ).resolve(ctx);

// Detached — use .startDetached() (Tier 3 — directly awaitable, no scope required)
const notifier = await ctx.childWorkflows.emailCampaign.startDetached({
  idempotencyKey: `campaign-${ctx.rng.campaignId.uuidv4()}`,
  metadata: { tenantId: "tenant-acme" },
  seed: "campaign-seed",
  args: { customerId: "cust-123" },
  retention: {
    complete: 86400 * 7,
    failed: 86400 * 30,
    terminated: 86400 * 7,
  },
}); // → ForeignWorkflowHandle
await notifier.channels.commands.send({ type: "nudge" }); // directly awaitable

// Access an existing (non-child) workflow via foreign handle
const existing = ctx.foreignWorkflows.emailCampaign.get("campaign-existing-id");
await existing.channels.commands.send({ type: "nudge" }); // directly awaitable
```

**Child workflow start modes:**

- **Result mode** (default): call without `.startDetached()` and chain `.compensate()`, `.failure()`, `.complete()`. Requires `.resolve(ctx)` to resolve.
- **Detached mode**: call `.startDetached(opts)` and `await` directly. Returns `ForeignWorkflowHandle`. The child runs independently — not terminated when parent fails. Retention may be overridden in detached options.

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
  // params.ctx: CompensationContext (works from both contexts since
  // ForeignWorkflowHandle.channels.send() is Tier 3 — directly awaitable)
  await params.ctx.foreignWorkflows.manager
    .get(params.args.managerId)
    .channels.done.send({ workerId: params.ctx.workflowId });
};
```

**Execution result vs compensation lifecycle:**

- `execute(...)` and compensation belong to the same workflow instance but run in different phases/contexts.
- `beforeSettle` runs before terminal status is finalized and exposed to result listeners.
- On `failed` / `terminated` paths that require compensation, `beforeSettle` runs after `beforeCompensate` → LIFO compensations → `afterCompensate`.
- Compensation progress remains observable through `handle.compensation.lifecycle.*`.

### Hook Ordering Table

| Path                                                    | Hook order                                                                      | `beforeSettle` params                                        | Final status behavior                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `execute` returns successfully, `beforeSettle` succeeds | `beforeSettle`                                                                  | `{ status: "complete", ctx: WorkflowContext, result, args }` | Settles as `complete`                                                   |
| `execute` returns successfully, `beforeSettle` throws   | `beforeSettle` -> `beforeCompensate` -> LIFO compensations -> `afterCompensate` | Initial call uses `{ status: "complete", ... }`              | Transitions and settles as `failed`; `beforeSettle` is not called again |
| `execute` throws (non-signal failure)                   | `beforeCompensate` -> LIFO compensations -> `afterCompensate` -> `beforeSettle` | `{ status: "failed", ctx: CompensationContext, args }`       | Settles as `failed`                                                     |
| SIGTERM (graceful termination with compensation)        | `beforeCompensate` -> LIFO compensations -> `afterCompensate` -> `beforeSettle` | `{ status: "terminated", ctx: CompensationContext, args }`   | Settles as `terminated`                                                 |
| SIGKILL (immediate termination)                         | _none_                                                                          | _none_                                                       | Immediate termination; no hooks/compensation                            |

### Workflow Headers

A `WorkflowHeader` is a minimal authoring descriptor used to wire workflow-to-workflow references before full implementations exist. It captures only what internal references need: `name`, and optionally `channels` (for `foreignWorkflows`), `args`, `metadata`, and `result` (for `childWorkflows`). It contains no implementation details.

For external/client APIs, use `PublicWorkflowHeader` (type-level contract) — it includes `name`, `args`, `metadata`, `channels`, `streams`, `events`, and `result`.

Use `defineWorkflowHeader()` to create one, then:

- **Spread it into `defineWorkflow`** so the full definition inherits the same name and schemas — single source of truth, no duplication.
- **Pass it directly to `childWorkflows` or `foreignWorkflows`** in any workflow that needs to reference this one before its full definition exists.

**Breaking circular references** is the primary use case:

```typescript
// Step 1 — declare the manager's public interface
const managerHeader = defineWorkflowHeader({
  name: "schedulerManager",
  channels: { workerDone: WorkerDonePayload },
});

// Step 2 — worker references manager via header (no circular dep)
const workerWorkflow = defineWorkflow({
  ...workerHeader,
  foreignWorkflows: { manager: managerHeader },
  execute: async (ctx, args) => {
    // ForeignWorkflowHandle.channels.send() is Tier 3 — directly awaitable
    await ctx.foreignWorkflows.manager
      .get(args.managerId)
      .channels.workerDone.send({ ... });
  },
});

// Step 3 — manager spreads its own header + adds full implementation
const managerWorkflow = defineWorkflow({
  ...managerHeader,
  args: ManagerArgs,
  childWorkflows: { worker: workerWorkflow },
  execute: async (ctx, args) => { ... },
});
```

**Self-referential (recursive) workflows:**

```typescript
const treeHeader = defineWorkflowHeader({ name: "tree", args: TreeArgs });

const treeWorkflow = defineWorkflow({
  ...treeHeader,
  childWorkflows: { subtree: treeHeader },
  execute: async (ctx, args) => {
    for (const child of args.children) {
      // startDetached() is Tier 3 — directly awaitable
      await ctx.childWorkflows.subtree.startDetached({
        idempotencyKey: child.id,
        args: child,
      });
    }
  },
});
```

**Idempotent child starts as cycle prevention.** When a self-referential workflow uses a content-derived idempotency key (e.g. a URL, a node key) for each child start, the engine's idempotent start semantics automatically prevent duplicate work:

```typescript
await ctx.childWorkflows.page.startDetached({
  idempotencyKey: pageUrl,
  args: { url: pageUrl, depth: args.depth + 1, ... },
});
```

See `src/examples/web-scraper.example.ts` for a complete web crawler built on this pattern.

### Cron-Like Workflows

Use `ctx.schedule(cron, { timezone?, resumeAt? })` to model recurring jobs as durable workflow logic.

```typescript
const schedule = ctx.schedule("0 9 * * 1-5", {
  timezone: "America/New_York",
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
      }).resolve(ctx);

  // Detached child job — startDetached() is Tier 3 (directly awaitable)
  await ctx.childWorkflows.dailyReport.startDetached({
    idempotencyKey: `daily-report-${tick.index}`,
    args: { reportDate: tick.scheduledAt.toISOString() },
    deadlineUntil: tick.nextScheduledAt,
    retention: {
      complete: 86400 * 7,
      failed: 86400 * 30,
      terminated: 60,
    },
  });
}
```

See `src/examples/cron-scheduler.example.ts` for a complete end-to-end example.

### CompensationContext vs WorkflowContext

Both extend a shared `BaseContext` with channels, streams, events, patches, sleep, rng, logger, timestamp, and date.

**`WorkflowContext`** (happy-path):

- Steps: calling a step returns `StepCall<T>` (Tier 1) — chain `.compensate()`, `.retry()`, `.failure()`, `.complete()` then resolve via `.resolve(ctx)`
- Child workflows: `ctx.childWorkflows.*` returns `WorkflowCall<T>` (Tier 1) by default; `.startDetached()` returns `DirectAwaitable<ForeignWorkflowHandle>` (Tier 3)
- Foreign workflows: `ctx.foreignWorkflows.*` returns `ForeignWorkflowHandle` (`channels.send()` is Tier 3 — directly awaitable)
- Has `scope(name, entries, callback)`, `all(entries)`, `first(entries)`, `listen()`, and `addCompensation()`
- Full branch-aware `select()` and `match()` are available only on scope callback context (`WorkflowConcurrencyContext`)

**`CompensationContext`** (defensive, full structured concurrency):

- Steps: calling a step returns `CompensationStepCall<T>` (Tier 1) — resolves to `CompensationStepResult<T>` via `.resolve(ctx)`
- Child workflows: `ctx.childWorkflows.*` returns `CompensationWorkflowCall<T>` (Tier 1) — resolves to `WorkflowResult<T>` via `.resolve(ctx)`
- Has `scope(name, entries, callback)`, `all(entries)`, `first(entries, defaultValue)`, and `listen()`
- `first()` requires a `defaultValue` — compensation must always produce a meaningful result
- No `addCompensation()` (prevents nesting)
- No `.compensate()` builders or `{ complete, failure }` handlers

### Channels (Message Passing)

Async communication between workflows. `channels.receive()` returns a Tier 2 `WorkflowAwaitable` (`ChannelReceiveCall`) — directly awaitable or passable to `select`/`listen`.

```typescript
// Blocking receive — directly awaitable (Tier 2)
const msg = await ctx.channels.payment.receive();
// msg is the decoded value (z.output<Schema>) — no wrapper

// Async iteration over channel messages
for await (const paymentMsg of ctx.channels.payment) {
  console.log(paymentMsg);
}

// Time-bounded receive: timeout in seconds
const maybePayment = await ctx.channels.payment.receive(300);
if (maybePayment === undefined) {
  console.log("timed out");
}

// Time-bounded receive with explicit timeout default
const paymentOrDefault = await ctx.channels.payment.receive(300, {
  amount: 0,
  txnId: "timeout",
});

// Non-blocking poll — receiveNowait() is Tier 3 (DirectAwaitable)
// Directly awaitable; NOT valid as a scope/select/listen entry
const nowait = await ctx.channels.payment.receiveNowait();
const nowaitWithDefault = await ctx.channels.payment.receiveNowait({
  amount: 0,
  txnId: "none",
});

// From another workflow — send via foreign handle (Tier 3 — directly awaitable)
const handle = ctx.foreignWorkflows.order.get("order-123");
await handle.channels.payment.send({ amount: 100 });

// External — send with result
const sendResult = await engineHandle.channels.payment.send({ amount: 100 });
if (sendResult.ok) console.log("Sent");
```

### Streams (Append-Only Logs)

Output data for external consumers. `ctx.streams.X.write()` is Tier 3 (`DirectAwaitable`) — directly awaitable.

```typescript
// Inside workflow — write (Tier 3 — directly awaitable)
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

Coordination signals with "never" semantics. `ctx.events.X.set()` is Tier 3 (`DirectAwaitable`) — directly awaitable.

```typescript
// Inside workflow — set (Tier 3 — directly awaitable)
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

### Phase Lifecycle Events

Engine-managed phase events are available on every workflow handle via:

- `handle.execution.lifecycle`
- `handle.compensation.lifecycle`

Each phase exposes the same event names:

| Event        | Meaning for that phase       |
| ------------ | ---------------------------- |
| `started`    | Phase execution begins       |
| `complete`   | Phase completes successfully |
| `failed`     | Phase fails with an error    |
| `terminated` | Phase is terminated          |

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
```

### Patches (Safe Workflow Evolution)

`ctx.patches.X` is Tier 3 (`DirectAwaitable<boolean>`) — directly awaitable. Evaluates to `true` when the patch is active.

```typescript
const workflow = defineWorkflow({
  patches: {
    antifraud: true,          // Active — new workflows run this code path
    removeLegacyEmail: true,  // Active — new workflows skip legacy path
    requireSelfie: false,     // Deprecated — only old replaying workflows enter this
  },

  async execute(ctx) {
    // Boolean form — await directly (Tier 3)
    if (await ctx.patches.antifraud) {
      const result = await ctx.steps.fraudCheck(args.flightId).resolve(ctx);
      // use result ...
    }

    if (!(await ctx.patches.removeLegacyEmail)) {
      await ctx.steps.sendLegacyEmail(...).resolve(ctx);
    }
  },
});
```

### Deterministic RNG

Typed, deterministic random number generation declared upfront in the workflow definition.

```typescript
const workflow = defineWorkflow({
  rng: {
    txnId: true,
    itemsShuffle: (category: string) => `items:${category}`,
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

**`WorkflowExecutionError`** — for failed child workflows:

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

| Context                               | Type               | Reason           |
| ------------------------------------- | ------------------ | ---------------- |
| Step execute **returns**              | `z.input<Schema>`  | Encoded to JSONB |
| Step call **resolves**                | `z.output<Schema>` | Decoded from DB  |
| Channel **send** accepts              | `z.input<Schema>`  | Saved to DB      |
| Channel **receive** returns           | `z.output<Schema>` | Decoded from DB  |
| Stream **write** accepts              | `z.input<Schema>`  | Saved to DB      |
| Stream **read** returns               | `z.output<Schema>` | Decoded from DB  |
| Workflow **execute** returns          | `z.input<Schema>`  | Saved to DB      |
| Workflow **execution.wait()** returns | `z.output<Schema>` | Decoded from DB  |

## Result Types

### Workflow-Internal (happy-path model)

Step and child workflow calls in `WorkflowContext` return Tier 1 `DeterministicAwaitable` handles. Resolve via `.resolve(ctx)` — failure auto-terminates the workflow when no `.failure()` builder is chained.

### Workflow-Internal (builder-based error handling)

`.failure(cb)` and `.complete(cb)` on `StepCall` / `WorkflowCall` let you handle outcomes explicitly. The call resolves to `T | TFail` where `TFail` is the `failure` callback's return type.

**Compensation semantics (unified across all `failure` surfaces):**

- Register compensation via `.compensate(cb)` (or `ctx.addCompensation()` for general cleanup).
- The engine owns compensation execution and runs callbacks in LIFO order during unwind.
- `failure` callbacks (`.failure(cb)`, `match`, `onFailure`) can return fallbacks, but do not manually trigger/claim compensation.

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

### Channel, Stream, Event Results

| Type                       | Success    | Failure Statuses                | Notes                           |
| -------------------------- | ---------- | ------------------------------- | ------------------------------- |
| `ChannelSendResult`        | `sent`     | `not_found`                     | Engine-level send               |
| `StreamReadResult`         | `received` | `closed`, `not_found`           | Engine-level random-access read |
| `StreamIteratorReadResult` | `record`   | `closed`                        | Engine-level iterator read      |
| `EventWaitResultNoTimeout` | `set`      | `never`                         | Engine-level event wait         |
| `EventCheckResult`         | `set`      | `not_set`, `never`, `not_found` | Engine-level non-blocking check |
| `SignalResult`             | `sent`     | `already_finished`, `not_found` | Engine-level signal             |

Workflow-internal `ChannelHandle` receive overloads (all return Tier 2 `ChannelReceiveCall` — directly awaitable):

- `receive()` → `T` (blocks until message)
- `receive(timeoutSeconds)` → `T | undefined`
- `receive(timeoutSeconds, defaultValue)` → `T | typeof defaultValue`

Non-blocking poll (Tier 3 `DirectAwaitable` — not a scope/select/listen entry):

- `receiveNowait()` → `T | undefined`
- `receiveNowait(defaultValue)` → `T | typeof defaultValue`

### Engine-Level Results

| Type                         | Success    | Failure Statuses                                                   |
| ---------------------------- | ---------- | ------------------------------------------------------------------ |
| `WorkflowResult`             | `complete` | `failed` (with `error`), `terminated` (with `reason`)              |
| `ExecutionResultExternal`    | `complete` | `failed` (with `error`), `terminated` (with `reason`), `not_found` |
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
- Detached child workflows can override retention at start-time via `.startDetached({ retention: ... })`.
- If `deadlineUntil` is already in the past at workflow start, the workflow terminates immediately with `deadline_exceeded`.
- Workflows are not retried as a unit; retry is step-scoped.

### External Wait Cancellation

Engine-level wait APIs use `{ signal?: AbortSignal }` for runtime cancellation:

- If the signal aborts, the wait rejects with `AbortError`.
- Wait result unions do not contain a `timeout` status.

## Visibility Rules

### Inside Workflow (`WorkflowContext`)

| Resource                                       | Operations                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.steps.*`                                  | `(args)` → `StepCall<T>` (Tier 1) — chain `.compensate()`, `.retry()`, `.failure()`, `.complete()` then resolve via `.resolve(ctx)`                                                                                     |
| `ctx.channels.*`                               | `.receive()` → `ChannelReceiveCall<T>` (Tier 2, directly awaitable or select/listen entry); `.receiveNowait()` → `DirectAwaitable<T \| undefined>` (Tier 3, directly awaitable, NOT a scope entry); `for await...of` |
| `ctx.streams.*`                                | `.write()` → `DirectAwaitable<number>` (Tier 3 — directly awaitable)                                                                                                                                                    |
| `ctx.events.*`                                 | `.set()` → `DirectAwaitable<void>` (Tier 3 — directly awaitable)                                                                                                                                                        |
| `ctx.childWorkflows.*`                         | `(options)` → `WorkflowCall<T>` (Tier 1, execute-only); `.startDetached(options)` → `DirectAwaitable<ForeignWorkflowHandle>` (Tier 3)                                                                                   |
| `ctx.foreignWorkflows.*`                       | `.get(key)` → `ForeignWorkflowHandle`; `.channels.*.send()` → `DirectAwaitable<void>` (Tier 3)                                                                                                                          |
| `ctx.patches.*`                                | `await ctx.patches.name` → `boolean` (Tier 3 — directly awaitable)                                                                                                                                                      |
| `ctx.scope(name, entries, callback)`           | Structured concurrency boundary → `DeterministicAwaitable<R>` (Tier 1) — resolve via `.resolve(ctx)`                                                                                                                    |
| `ctx.all(entries)`                             | "Run all + collect results" → `DeterministicAwaitable<...>` (Tier 1) — resolve via `.resolve(ctx)`                                                                                                                      |
| `ctx.first(entries[, defaultValue])`           | "Run concurrently, return first to complete" → `DeterministicAwaitable<FirstResult<E> [| TDefault]>` (Tier 1) — resolve via `.resolve(ctx)`                                                                             |
| `ctx.listen(handles)`                          | Channel-only multiplexing — accepts `ChannelHandle` (streaming) or `ChannelReceiveCall` (one-shot); returns `Listener<M>`, directly iterable                                                                            |
| `handle.resolve(ctx)`                          | Resolves any Tier 1 `DeterministicAwaitable` (steps, child workflows, scope/all/first results)                                                                                                                           |
| `ctx.addCompensation()`                        | Register LIFO compensation callback                                                                                                                                                                                     |
| `ctx.schedule(cron, { timezone?, resumeAt? })` | Durable cron-like schedule handle                                                                                                                                                                                       |
| `ctx.sleep(seconds)`                           | `WorkflowAwaitable<void>` (Tier 2 — directly awaitable, valid scope entry)                                                                                                                                              |
| `ctx.sleepUntil(target)`                       | `WorkflowAwaitable<void>` (Tier 2 — directly awaitable, valid scope entry)                                                                                                                                              |
| `ctx.rng.*`                                    | Typed deterministic RNG streams                                                                                                                                                                                         |
| `ctx.timestamp` / `ctx.date`                   | Deterministic time                                                                                                                                                                                                      |
| `ctx.logger`                                   | Replay-aware logger                                                                                                                                                                                                     |

### Inside scope callback (`WorkflowConcurrencyContext`)

Extends `WorkflowContext` with the following additions:

| Resource                | Operations                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ctx.join(handle)`      | Resolves a `BranchHandle` — enforces scope-path lifetime at compile time; use `.resolve(ctx)` for all other Tier 1 handles |
| `ctx.select(handles)`   | Branch + channel multiplexing; accepts `BranchHandle`, `ChannelHandle`, `ChannelReceiveCall`; returns `Selection<M>` |
| `ctx.match(sel, ...)`   | Iterate a `Selection<M>`; four overloads (no handlers / onFailure / handlers / handlers + onFailure)         |

### Inside Compensation (`CompensationContext`)

| Resource                                   | Operations                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.steps.*`                              | `(args)` → `CompensationStepCall<T>` (Tier 1) — chain `.retry()` then resolve via `.resolve(ctx)`; resolves to `CompensationStepResult<T>` |
| `ctx.channels.*`                           | `.receive()` → `ChannelReceiveCall<T>` (Tier 2); `.receiveNowait()` → `DirectAwaitable<T \| undefined>` (Tier 3)                        |
| `ctx.streams.*`                            | `.write()` → `DirectAwaitable<number>` (Tier 3)                                                                                         |
| `ctx.events.*`                             | `.set()` → `DirectAwaitable<void>` (Tier 3)                                                                                             |
| `ctx.childWorkflows.*`                     | `(options)` → `CompensationWorkflowCall<T>` (Tier 1) — resolve via `.resolve(ctx)`; resolves to `WorkflowResult<T>`                     |
| `ctx.foreignWorkflows.*`                   | `.get(key)` → `ForeignWorkflowHandle`; `.channels.*.send()` → `DirectAwaitable<void>` (Tier 3)                                          |
| `ctx.patches.*`                            | `await ctx.patches.name` → `boolean` (Tier 3)                                                                                           |
| `ctx.scope(name, entries, callback)`       | Structured concurrency → `DeterministicAwaitable<R>` (Tier 1) — resolve via `.resolve(ctx)`; all unjoined branches settled on exit      |
| `ctx.all(entries)`                         | → `DeterministicAwaitable<...>` (Tier 1) — resolve via `.resolve(ctx)`                                                                  |
| `ctx.first(entries, defaultValue)`         | `defaultValue` is required — → `DeterministicAwaitable<FirstResult<E> \| TDefault>` (Tier 1) — resolve via `.resolve(ctx)`              |
| `ctx.listen(handles)`                      | Channel-only multiplexing — same as `WorkflowContext`                                                                                   |
| `handle.resolve(ctx)`                      | Resolves any Tier 1 `DeterministicAwaitable`                                                                                            |
| `ctx.sleep()` / `ctx.rng.*`               | Same as WorkflowContext                                                                                                                 |
| `ctx.logger`                               | Replay-aware logger                                                                                                                     |

### Inside compensation scope callback (`CompensationConcurrencyContext`)

Extends `CompensationContext` with the following additions:

| Resource                   | Operations                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ctx.join(handle)`         | Resolves a `BranchHandle` — enforces scope-path lifetime at compile time                                          |
| `ctx.select(handles)`      | Branch + channel multiplexing; returns `CompensationSelection<M>`                                                 |
| `ctx.match(sel, ...)`      | Iterate a `CompensationSelection<M>`; same four overloads as workflow side                                        |

### `ForeignWorkflowHandle`

| Resource      | Operations                                                       |
| ------------- | ---------------------------------------------------------------- |
| `.channels.*` | `.send()` → `DirectAwaitable<void>` (Tier 3, directly awaitable) |

### External (`engine.workflows.*`)

| Resource     | Operations                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `.start()`   | Start workflow (`idempotencyKey?`, optional `metadata`, optional `seed`, optional `deadlineSeconds`), returns `WorkflowHandleExternal` |
| `.execute()` | Start + wait for execution result (sugar for `start + handle.execution.wait()`)                                                        |
| `.get()`     | Get handle to existing workflow                                                                                                        |

### External Handle (`WorkflowHandleExternal`)

| Resource                          | Operations                                                                 |
| --------------------------------- | -------------------------------------------------------------------------- |
| `.channels.*`                     | `.send()`                                                                  |
| `.streams.*`                      | `.read(offset, { signal? })`, `.iterator()`, `.isOpen()`, `for await...of` |
| `.events.*`                       | `.wait({ signal? })`, `.isSet()`                                           |
| `.execution.lifecycle.*`          | `.wait({ signal? })`, `.get()`                                             |
| `.compensation.lifecycle.*`       | `.wait({ signal? })`, `.get()`                                             |
| `.execution.wait({ signal? })`    | Wait for execution phase result                                            |
| `.compensation.wait({ signal? })` | Wait for compensation phase result                                         |
| `.sigterm()` / `.sigkill()`       | Send signals (engine-level only)                                           |
| `.setRetention()`                 | Update retention policy                                                    |

External stream async iteration:

```typescript
for await (const item of handle.streams.progress) {
  console.log(item);
}
for await (const item of handle.streams.progress.iterator(10)) {
  console.log(item);
}
```

## Garbage Collection

```typescript
const workflow = defineWorkflow({
  retention: 86400 * 30,
  // or granular:
  retention: {
    complete: 86400 * 365,
    failed: 86400 * 90,
    terminated: 86400 * 7,
  },
});

await engine.workflows.order.start({
  idempotencyKey: "vip-order",
  retention: 86400 * 365 * 5,
});

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
    // Step call returns a Tier 1 handle — resolve via .resolve(ctx)
    const result = await ctx.steps.greet("World").resolve(ctx);
    return { message: result.greeting };
  },
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const engine = new WorkflowEngine({
  pool,
  workflows: { hello: helloWorkflow },
});

await engine.start();

const result = await engine.workflows.{
  idempotencyKey: "hello-1",
}.resolve(hello);
if (result.ok) {
  console.log(result.data.message); // "Hello, World!"
} else if (result.status === "failed") {
  console.error(result.error.message);
}

const handle = await engine.workflows.hello.start({
  idempotencyKey: "hello-2",
});
const result2 = await handle.execution.wait();

await engine.shutdown();
```

## Example Workflows

Examples are split into focused files under `src/examples/`.

- Workflow-internal API examples: scopes, selection, compensation, channels, patches, child/foreign workflows.
- Cron-like scheduler example: `src/examples/cron-scheduler.example.ts` demonstrates the manager/worker split for long-running schedulers — a stable idempotency-key manager loop delegates to bounded-history workers, with `beforeSettle` + `foreignWorkflows` guaranteeing worker handoff delivery on complete/failed/terminated outcomes. Detached child starts via `.startDetached()` ensure workers carry no compensation obligation to the manager.
- Web scraper example: `src/examples/web-scraper.example.ts` demonstrates `defineWorkflowHeader` for self-referential workflows and URL-as-idempotency-key for automatic cycle prevention — no explicit visited-set needed.
- Concurrency-focused example: `src/examples/concurrency-primitives.example.ts` demonstrates dynamic fan-out using `ctx.all()` inside a branch closure, cheapest-flight selection across variable providers, `ctx.select()` + `ctx.match()` racing, `receiveNowait()` for early-cancel polling, and child/foreign workflow orchestration.
- `ctx.all()` and nested scope example: `src/examples/scope-all-and-nested-select.example.ts` demonstrates `ctx.all(entries)` and racing a nested child scope against an outer branch by placing both in the parent scope's entries.
- Per-key match example: `src/examples/onboarding-verification.example.ts` demonstrates 5 parallel identity methods, a 1-hour deadline race, 3-of-5 threshold gating, and explicit per-key `{ complete, failure }` handlers.
- Client API example: `src/examples/engine-level-api.example.ts` demonstrates the shared workflow client API and handle operations.

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
- **Three-tier awaitable hierarchy** — Tier 1 (`DeterministicAwaitable`, execute-only via `.resolve(ctx)`), Tier 2 (`WorkflowAwaitable`, directly awaitable + valid scope entry), Tier 3 (`DirectAwaitable`, directly awaitable, not a scope entry). Enforced at compile time with no runtime overhead.
- **`handle.resolve(ctx)` as the primary resolution path for Tier 1** on base contexts; **`ctx.join(handle)` restricted to `BranchHandle` on concurrency contexts** — enforces scope-path lifetime at compile time and prevents execution-root handles from being resolved in `CompensationContext` and vice versa.
- **Closure-based structured concurrency** via `ctx.scope(name, entries, callback)` — entries are always `(ctx) => Promise<T>` closures; each branch receives a path-specialized context preventing accidental outer-context closure.
- **Scope path symbol system** — `scopeDivider` and `branchDivider` unique symbols interleaved in `ScopePath` make scope name transitions and branch key transitions structurally unambiguous at both type and runtime level. Collision detection works for literal keys; dynamic (`string`) keys disable the check from that point downward.
- **`ctx.all(entries)` sugar** for the common "run all + collect" shape-preserving pattern
- **`ctx.first(entries[, defaultValue])` primitive** — returns the first branch to complete as `{ key, result }` discriminated union; `defaultValue` optional on execution contexts, required on compensation contexts
- **One compensation callback per handle** — defined via `.compensate(cb)` builder, full `CompensationContext`; compensation is always unconditional (at-least-once semantics)
- **Scope exit behavior** — branches with compensated steps → compensated; others → settled
- **Unified failure model** — `.failure(cb)` / `{ complete, failure }` / `{ failure }` handler entries; `onFailure` default for `match()`; branch `failure` callbacks take no arguments; compensation remains engine-managed
- **`ctx.listen()` as the channel-only multiplexing primitive on all contexts** — directly iterable, yields `{ key, message }`
- **`ctx.select()` + `ctx.match()` as the branch-coordination primitives on concurrency contexts only** — `ctx.match(sel)` yields `{ key, result }`; four overloads supporting handlers and default failure callbacks
- **`channels.receive()` overloads** — blocking, timeout, timeout-with-default (all Tier 2); **`receiveNowait()` / `receiveNowait(default)`** for non-blocking atomic poll (Tier 3)
- **Virtual event loop** — engine interleaves concurrent compensation callbacks transparently
- `BaseContext` / `WorkflowContext` / `CompensationContext` hierarchy
- **CompensationContext with full structured concurrency** — `scope(name, ...)` plus scope-local `select()/match()` and `CompensationStepCall.retry()`
- **`ctx.childWorkflows.*` / `ctx.foreignWorkflows.*`** split — structured vs message-only access
- **`.startDetached(opts)` for fire-and-forget child starts** — returns `DirectAwaitable<ForeignWorkflowHandle>` (Tier 3)
- Error observability — `StepExecutionError`, `StepErrorAccessor`, `WorkflowExecutionError`
- Engine-level handles retain `sigterm()`, `sigkill()`, `execution.wait()`, and `compensation.wait()` with typed terminal outcomes
- Lifecycle events with "never" semantics (external API)
- Stream iterators (external API; streams close implicitly on workflow termination)
- **Patches for safe workflow evolution** — boolean-form only (`await ctx.patches.name`), Tier 3 (`DirectAwaitable<boolean>`)
- Typed deterministic RNG (`ctx.rng.*`)
- `beforeCompensate` / `afterCompensate` / `beforeSettle` lifecycle hooks on workflow definition
- **`WorkflowHeader` / `defineWorkflowHeader`** — minimal authoring descriptors for circular reference resolution and self-referential workflows
- **`PublicWorkflowHeader`** — client-facing workflow contract

## License

MIT
