# Error Model

## What it is

The engine separates failure into surfaces that look similar but mean very different things. Getting them straight is most of understanding the model:

1. **Declared business failure** — the workflow declares a typed `errors` vocabulary and fails *deliberately* with `ctx.errors.X(...)`. This is terminal, triggers compensation, and is the **only** failure an external caller sees by schema.
2. **Engine events** — a step/request that times out, or a child workflow that fails, comes back as an **ordinary return value** on the awaited entry, never as a throw. The body decides whether to turn one into a business failure.
3. **Unrecognized throws** — anything thrown that *isn't* a declared `ctx.errors.X(...)` is **not** a failure. It **halts** the workflow for fix-and-replay (see the halt model). Failures are terminal; halts are pauses.
4. **Handler failures** — step/request/queue/topic handlers run *outside* the workflow body and use a **different vocabulary entirely** (`throw` to retry, `AttemptError`, `UnrecoverableError`, `MANUAL`, `DEAD_LETTER`) — not `ctx.errors`.

The throughline: **`ctx.errors` is the workflow body's failure surface; everything else is either a value to inspect, a pause to fix, or a handler-side outcome.**

## Declaring and throwing business failures

A workflow declares its failure vocabulary as a schema map. Each entry is either a payload schema or `true` (a payload-less marker):

```typescript
const order = defineWorkflow({
  name: "order",
  errors: {
    OrderInvalid: z.object({ orderId: z.string() }),
    InsufficientFunds: z.object({ amount: z.number(), balance: z.number() }),
    Cancelled: true,
  },
  async execute(ctx, args) {
    if (!valid) {
      throw ctx.errors.OrderInvalid("Order is invalid", { orderId: args.orderId });
    }
    // …
  },
});
```

`ctx.errors.<Code>` is a factory: for a schema-typed error you pass `(message, details)`; for a `true` error you pass `(message)` only. It returns an **`ExplicitError`** — you `throw` it. The signature is enforced from the declaration, so a typo'd code or a wrong `details` shape is a compile error.

Throwing a declared `ctx.errors.X(...)` **fails the workflow** and **triggers compensation** for its completed compensable steps. It's available in the `execute` body and in any `ctx.scope` body (scopes share the workflow's `errors`).

## Engine events are values, not throws

A dispatched entry that times out or fails does **not** throw. You observe it as a local union on the awaited value, and you decide what it means:

```typescript
const result = await ctx.childWorkflows.processOrder({ orderId: "o-1" });
if (!result.ok && result.status === "failed") {
  // translate a child's failure into one of *our* declared failures
  throw ctx.errors.OrderProcessingFailed("child failed", { childError: result.error });
}
```

This is deliberate: durable bodies are replayed, and "is this fatal?" is a domain decision, not something the engine should make by unwinding the stack. A step timeout (`{ ok: false; status: "timeout" }`), a child failure (`{ ok: false; status: "failed"; error }`) — all are data you branch on.

## Unrecognized throws halt — they don't fail

Any throw the body produces that is **not** a `ctx.errors.X(...)` of a *currently-declared* code becomes an **execution halt**, not a failure. A plain `throw new Error(...)`, a bug, an assertion — all halt.

This is the model's sharpest rule, and it's a feature:

- A **failure** is a terminal, expected outcome you designed for — it compensates and reports a typed error to the caller.
- A **halt** is "something is wrong that I didn't model" — the workflow **pauses** (no compensation, no terminal state) so an operator can fix the code and **replay**, or `skip` it. The recorded history is preserved.

It also catches **stale throws**: if you remove an error code from the `errors` map but a replaying history still throws it, that throw is no longer recognized → it halts rather than silently mis-failing. (Halt resolution — patch + replay vs `skip` — is the halt model's domain.)

## What the caller sees

A workflow's terminal outcome is a `WorkflowResult`:

```typescript
type WorkflowResult<T, TError> =
  | { ok: true;  status: "complete";   data: T }
  | { ok: false; status: "failed";     error: TError }      // TError = ErrorValue<declared errors>
  | { ok: false; status: "terminated"; reason: … };         // operator termination
```

The caller discriminates the **failed** arm on `error.code` — there is no outer error category, just the codes you declared:

```typescript
const result = await client.workflows.order.execute({ args: { … }, idempotencyKey: "…" });
if (!result.ok && result.status === "failed") {
  switch (result.error.code) {
    case "OrderInvalid":      result.error.details.orderId; break;
    case "InsufficientFunds": result.error.details.balance; break;
    case "Cancelled":         /* details is undefined for `true` errors */ break;
  }
}
```

Note the three terminal shapes are distinct, and a **halt is none of them** — a halted workflow has no terminal result; it is paused, waiting to be fixed or skipped. `failed` is a business outcome; `terminated` is an operator action; `halt` is an unmodeled fault.

## Errors per context

The recognized-throw rule changes by where you are:

| Context | A recognized failure throw | Anything else thrown |
|---|---|---|
| Workflow `execute` body | `ctx.errors.X(...)` (the workflow's errors) → **fails the workflow** | **execution halt** |
| `ctx.scope` body | the parent body's `ctx.errors.X(...)` → fails the workflow | execution halt |
| Compensation `undo` | *none* — there is no `ctx.errors` | **compensation-block halt** |
| Step / request / queue / topic handler | *none* — see "Handler-side failures" | retry / dead-letter / halt, per handler |

## Compensation has no error surface

Compensation `undo` callbacks **do not** receive `ctx.errors`, and the workflow body's errors are invisible to them — each compensation block instance is its own isolated execution path. An `undo` reports its outcome by **returning a value** through its optional `result` schema, not by throwing. An unexpected throw inside `undo` **halts that compensation block** (a distinct halt from a workflow halt) for operator intervention. (See [steps.md](./steps.md) for the compensation surface.)

## Handler-side failures (a different vocabulary)

Step, request, queue, and topic **handlers** run outside the workflow body and never touch `ctx.errors`. They fail through a separate vocabulary, by **what they throw or return**:

- **`throw` (any error)** — a transient failure: the engine **retries** per the retry policy. Use `AttemptError` to attach a structured `type` / `details` to the recorded attempt.
- **`UnrecoverableError`** (topic consumers) — stop retrying immediately; go to the `onConsumeError` exhaustion path. (Topics only — see [topics.md](./topics.md).)
- **`return DEAD_LETTER`** (queue handlers) — the message itself is the problem; dead-letter it instead of retrying. (See [queues.md](./queues.md).)
- **`return MANUAL`** (request handlers) — stop retrying and transition to manual resolution. (See [requests.md](./requests.md).)

Intentional control-flow outcomes (`DEAD_LETTER`, `MANUAL`) are **returns**; only genuine transient faults are **throws**. This is the inverse of the body, where the *intentional* outcome (`ctx.errors`) is the throw.

## Attempt history

Every retried operation records its tries. `AttemptAccessor` exposes them — `last()`, `all()`, `count()`, async iteration — as `Attempt` records (a `Failure` plus a 1-indexed `attempt`). Steps persist **every** attempt (including the successful one); queues, requests, and topics persist **failed tries only**. The most common reader is compensation `undo`, where `info.attempts` lets rollback logic judge reachability before doing irreversible work (see [steps.md](./steps.md)).

## What it is NOT

- **Not** a single throwable hierarchy. There is no base `Error` you catch; the body fails by throwing **declared** `ctx.errors.X(...)`, and handlers fail by their own returns/throws.
- **Not** exception-based control flow for engine events. Timeouts and child failures are **values**, not throws — you branch on them.
- **Not** a way to fail with an undeclared error. An undeclared/stale throw **halts**; it does not become a failure.
- **Not** shared between body and compensation. They are isolated execution paths with separate (or no) error surfaces.
- **Not** the same as the handler vocabulary. `ExplicitError` (body, business) and `AttemptError` (handler, transient) look alike but are unrelated — don't reach for `ctx.errors` in a handler or `AttemptError` in a body.

## Examples

**Declaring, throwing, and translating**

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
      // engine event (a value) → translate into a declared business failure
      throw ctx.errors.Cancelled("downstream failed");
    }
    return { ok: true };
  },
});
```

**A bug halts rather than fails**

```typescript
async execute(ctx, args) {
  const total = compute(args); // throws TypeError on a bad input shape
  // ^ not a ctx.errors throw → the workflow HALTS (paused), not "failed".
  //   Fix the code and replay; the recorded history is intact.
}
```

**Caller branches on the code**

```typescript
const r = await client.workflows.order.execute({ args, idempotencyKey: "o-1" });
if (r.ok) r.data;
else if (r.status === "failed") r.error.code; // "OrderInvalid" | "Cancelled"
else r.reason; // terminated by an operator
```
