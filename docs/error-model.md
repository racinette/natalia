# Error Model

Natalia does not treat errors as a single throwable hierarchy you navigate with `try/catch`. The engine **classifies outcomes** based on *where* code runs and *what form* the outcome takes. The same `throw new Error("oops")` in a step handler triggers a retry; in a workflow body it pauses the instance for operator intervention. That difference is not stylistic advice — it changes persistence, compensation, what the external caller receives, and whether replay can continue.

The model has two execution planes:

- **Workflow bodies** (`execute`, `ctx.scope` bodies) — durable, replayed, compensation-aware. They declare a typed failure vocabulary and interact with dispatched entries through **returned values**.
- **Handlers** (step `execute`, request/queue/topic workers) — ephemeral, retried outside the body. They use **handler-local** surfaces (`AttemptError`, `MANUAL`, queue `ctx.errors`, `UnrecoverableError`) and never the workflow body's `ctx.errors`.

Mixing vocabulary across planes does not produce a type error at the throw site in every case, but it produces the **wrong engine behavior**. The sections below describe what each plane actually does.

## Workflow bodies: four outcome paths

Code in a workflow body always ends up in exactly one of these buckets:

| Outcome | How it is expressed | Engine behavior |
|--------|---------------------|-----------------|
| **Success** | `return` a value matching the workflow `result` schema | Terminal `complete`; caller gets `data`. |
| **Declared business failure** | `throw ctx.errors.X(...)` for a code in the workflow's `errors` map | Terminal `failed`; compensation runs; caller gets a typed `error` by schema. |
| **Engine event** | `await` a dispatched entry and receive `{ ok: false, … }` | **Not terminal by itself.** The body keeps running until it returns or throws a declared error. |
| **Unmodeled fault** | Any other `throw` (bugs, `new Error`, stale codes) | **Execution halt** — workflow pauses; no terminal result; no compensation. |

There is no fifth path where an arbitrary exception becomes a business failure. Undeclared throws are intentionally **not** failures.

### Declared business failures

A workflow declares its externally visible failure vocabulary on `defineWorkflow`:

```typescript
const order = defineWorkflow({
  name: "order",
  errors: {
    OrderInvalid: z.object({ orderId: z.string() }),
    InsufficientFunds: z.object({ amount: z.number(), balance: z.number() }),
    Cancelled: true, // payload-less marker
  },
  async execute(ctx, args) {
    if (!valid) {
      throw ctx.errors.OrderInvalid("Order is invalid", { orderId: args.orderId });
    }
    // …
  },
});
```

`ctx.errors.<Code>` is a factory bound to that declaration. Schema-typed codes take `(message, details)`; `true` codes take `(message)` only. It returns an `ExplicitError` — you throw it. Wrong codes or detail shapes are compile errors.

Throwing a declared error **fails the workflow** and **triggers compensation** for completed compensable forward work. The same `errors` map is available in `ctx.scope` bodies; scopes do not introduce a separate failure namespace.

This is the **only** failure surface the external caller can observe by schema. Everything else either never reaches the caller (`halt`) or must be translated into a declared code by your body logic.

### Engine events are returned, not thrown

When a step times out, a request invocation times out, or a child workflow fails, the engine does **not** unwind your stack. The awaited entry resolves to a discriminated union you inspect locally:

```typescript
const child = await ctx.childWorkflows.processOrder({ orderId: "o-1" });
if (!child.ok && child.status === "failed") {
  throw ctx.errors.OrderProcessingFailed("child failed", {
    childError: child.error,
  });
}
```

Durable workflows replay. Whether a downstream timeout should abort the parent, trigger compensation, or trigger a different declared code is a **domain decision** the body makes explicitly — not something the runtime infers from an exception edge.

The same rule applies to step and request timeouts: branch on `{ ok: false, status: "timeout" }`, then decide.

### Unrecognized throws halt

Any throw in a workflow body that is **not** a `ctx.errors.X(...)` for a code **currently** in the workflow's `errors` map becomes an **execution halt**.

A halt is not a softer kind of failure:

- The workflow **does not** reach a terminal `failed` state.
- Compensation **does not** run.
- The external caller **does not** receive a `WorkflowResult` — the instance is **paused** until an operator patches and replays, or skips the faulting entry.

Plain bugs, assertions, and `throw new Error(...)` all halt. So do **stale** declared errors: if you remove a code from `errors` but replaying history still throws it, recognition fails and the instance halts instead of mis-reporting a failure the current schema no longer describes.

Failures are designed outcomes with compensation and a typed caller contract. Halts are "the code or history does not match what we model" — fix forward, then replay.

## What the caller sees

Terminal workflow outcomes are a closed union:

```typescript
type WorkflowResult<T, TError> =
  | { ok: true;  status: "complete";   data: T }
  | { ok: false; status: "failed";     error: TError }
  | { ok: false; status: "terminated"; reason: … };
```

`TError` is `ErrorValue<your declared errors>` — discriminated on `error.code` with typed `details` per entry:

```typescript
const result = await client.workflows.order.execute({ args, idempotencyKey: "o-1" });
if (!result.ok && result.status === "failed") {
  switch (result.error.code) {
    case "OrderInvalid":      result.error.details.orderId; break;
    case "InsufficientFunds": result.error.details.balance; break;
    case "Cancelled":         /* no details */ break;
  }
}
```

`failed` is a business outcome. `terminated` is operator action. **Halt is neither** — a halted workflow has no terminal result until it is resolved.

## Compensation is isolated

Compensation `undo` callbacks run as separate execution paths. They **do not** receive `ctx.errors`, and the parent workflow's declared errors are not visible inside them.

An `undo` reports success or partial outcome by **returning** through its optional `result` schema. There is no compensation equivalent of `ctx.errors.X(...)`.

An unexpected throw inside `undo` **halts that compensation block instance** — a distinct halt from a workflow-body halt. It does not fail the parent workflow as a declared business error. See [primitives/steps.md](./primitives/steps.md) for the compensation surface.

## Handlers: a separate vocabulary

Step, request, queue, and topic handlers execute outside the replayed workflow body. They never use `ctx.errors`. Each primitive defines how throws and returns map to retries, dead letters, manual mode, or exhaustion callbacks.

| Primitive | Intentional control flow | Transient fault |
|-----------|-------------------------|-----------------|
| **Steps** | normal `return` | `throw` (use `AttemptError` for structured attempt records) |
| **Requests** | `return` response; `return MANUAL` for external resolution | `throw` → retry per policy |
| **Queues** | `throw ctx.errors.X(..., { deadLetter: true })` | `throw ctx.errors.X(..., { deadLetter: false })` or unhandled throw → retry |
| **Topics** | `throw UnrecoverableError` → `onConsumeError` immediately | `throw AttemptError` or ordinary error → retry |

Queue handlers are `void`-returning and declare an optional **`errors`** map on `defineQueue` (same shape as workflow errors: `true` or schema per code). Each throw uses **`ctx.errors.<Code>(message, { deadLetter })`** or **`ctx.errors.<Code>(message, details, { deadLetter })`**, producing a **`QueueHandlerDeclaredError`**. Request handlers use **`return MANUAL`**. Topic consumers use **`UnrecoverableError`**.

Details and type-level rules live in the primitive docs: [queues](./primitives/queues.md), [requests](./primitives/requests.md), [topics](./primitives/topics.md), [steps](./primitives/steps.md).

## Attempt history

Retried operations persist tries for inspection. The shape depends on context:

- **Steps** — `AttemptAccessor` over `Attempt` records; **every** try is stored, including successes.
- **Requests, topics** — `AttemptAccessor`; **failed tries only**.
- **Queues** — `QueueHandlerAttemptAccessor` with per-code `details` (`serialized` / `serialization_error` / `unspecified`). When `code` is set, `message` is always `string`.

`AttemptError` attaches structured fields to step, request, and topic attempt rows. **`QueueHandlerDeclaredError`** (from queue `ctx.errors`) carries `code`, `message`, optional schema-backed `details`, and `deadLetter`.

Handler attempt records are diagnostic and operational. They do not flow to the workflow caller unless the body explicitly observes a dispatched result and translates it into `ctx.errors`.

## Mental model

Think in terms of **recognition**, not catching:

1. In the body, only `ctx.errors.X(...)` is recognized as business failure. Everything else thrown is a halt.
2. Dispatched failures arrive as **values** you must branch on before they become business failures.
3. In handlers, the engine recognizes primitive-specific throws and returns — not `ctx.errors`.
4. Compensation neither fails the workflow nor shares its error map.

The ergonomics look like conventions (`throw ctx.errors`, `return MANUAL`). Underneath, they are **distinct state machines** wired to durability, replay, compensation, and external contracts. Writing against the wrong surface does not merely read oddly — it changes what gets persisted and what the system does next.

## Examples

**Translate an engine event into a declared failure**

```typescript
const order = defineWorkflow({
  name: "order",
  errors: { OrderInvalid: z.object({ orderId: z.string() }), Cancelled: true },
  childWorkflows: { processOrder },
  async execute(ctx, args) {
    if (!args.orderId) {
      throw ctx.errors.OrderInvalid("missing id", { orderId: args.orderId });
    }
    const child = await ctx.childWorkflows.processOrder({ orderId: args.orderId });
    if (!child.ok) {
      throw ctx.errors.Cancelled("downstream failed");
    }
    return { ok: true };
  },
});
```

**A bug halts; it does not fail**

```typescript
async execute(ctx, args) {
  const total = compute(args); // TypeError → execution halt, not WorkflowResult.failed
  // Fix the code, redeploy, replay. Recorded history is preserved.
}
```

**Caller handles only terminal shapes**

```typescript
const r = await client.workflows.order.execute({ args, idempotencyKey: "o-1" });
if (r.ok) r.data;
else if (r.status === "failed") r.error.code;
else r.reason; // operator-terminated
```
