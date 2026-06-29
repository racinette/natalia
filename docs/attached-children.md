# Attached Child Workflows

## What it is

An **attached child** is a workflow run as a **dispatched entry of its parent**, with its lifecycle **owned by the parent** under structured concurrency. You invoke one inside the body with `ctx.children.<name>(args, opts?)`. The call returns an **awaitable entry**: the parent observes the child’s outcome by `await`-ing it directly, by joining it in a scope, or implicitly through the structured-concurrency helpers. When the entry is placed inside a `ctx.scope`, the scope hands you a **handle** to the running child that is also **sendable**—you can deliver messages to it on its channels while it runs.

```typescript
const result = await ctx.children.processOrder({ orderId: "o-1" });
// { ok: true; result } | { ok: false; status: "failed"; error }
```

An attached child is the engine’s **subroutine call**: the parent dispatches it, the engine runs it as its own durable instance, and the parent treats the outcome as a local value—success or a structured failure, never a thrown exception.

## Defined as

A child workflow is an ordinary workflow—nothing special at the definition site:

```typescript
const processOrder = defineWorkflow({
  name: "process-order",
  args: z.object({ orderId: z.string() }),
  result: z.object({ shipped: z.boolean() }),
  channels: {
    cancel: z.object({ reason: z.string() }),
  },
  async execute(ctx, args) {
    // …
    return { shipped: true };
  },
});
```

To use it as a child, declare it **once** on the parent under `children`. Whether it runs *attached* or *detached* is chosen at the **call site**, not at declaration—invoke the accessor for an attached child, call `.start()` for a detached one:

```typescript
const order = defineWorkflow({
  name: "order",
  args: z.object({ orderId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  children: { processOrder },
  async execute(ctx, args) {
    // attached: await the entry — runs owned, under structured concurrency
    const result = await ctx.children.processOrder({ orderId: args.orderId });

    // detached: call .start(…) on the same entry — spins it off as a root (see detached-children.md)
    // ctx.children.processOrder({ orderId: args.orderId }).start({ idempotencyKey: "…" });
    return { ok: result.ok };
  },
});
```

Call-time options for an attached invocation are `metadata`, `seed`, `retention`, and an optional **execution deadline** (`deadlineSeconds` / `deadlineUntil`). There is no `retry` (workflows are not retried—an unrecoverable error halts for fix-and-replay, it does not re-run the body), and there is no `idempotencyKey` (see below).

## Why it exists

Composition. Some work is itself a full workflow—its own steps, retries, channels, durability—but you want to run it *as part of* a larger workflow and act on its result. An attached child gives you exactly that, with the guarantees of structured concurrency: the child is **bound to the parent’s lifetime**, observed through a typed entry, and torn down with the parent rather than left running as an orphan.

That is the primitive’s defining axis, held against its siblings:

- **Attached** (bare call) — parent-owned, **awaitable**, sendable while running *via its scope handle*, **not** globally addressable (no `idempotencyKey`), torn down with the parent.
- **Detached** (`.start()`) — a fire-and-forget durable start that **outlives** the parent and returns a send-only handle with an `idempotencyKey`; not awaitable.
- **External** — a reference to an existing instance you did **not** start; send-only.

The attached call options are a strict **subset** of the detached ones; the only thing detached adds is the identity key, for the reason below.

## Why attached children have no idempotency key

This is a deliberate design decision, not an omission.

An `idempotencyKey` places a workflow in the engine’s **global identity namespace**, where every key must be unique. If attached children carried keys, a child started under one parent could **collide** with a workflow of the same key started in another scope entirely—two instances claiming one identity, with independent and conflicting lifecycles, and no sensible way to reconcile them. Who owns the run? Whose termination wins? There is no good answer, so we don’t allow the situation to arise.

Keeping attached children **keyless namespaces them under their parent**: a child’s identity is its parent’s identity plus its deterministic position in the body. That is replay-stable and collision-free by construction.

They are not hidden, though. Attached children remain **fully observable from the outside—through the client’s search API**, not by key lookup. That is exactly where parent-scoped work belongs: discoverable by querying (by parent, by metadata, by status), rather than addressable by a global handle it was never meant to have.

## What it is NOT

- **Not** globally addressable. No `idempotencyKey`; reach them through the search API, not `client.workflows.<name>.get(key)`.
- **Not** sendable from the *bare* entry. The awaitable entry returned by `ctx.children.<name>(...)` does not carry `channels.send` on its own. Messaging is available on the **scope handle**: place the entry in a `ctx.scope`, and the handle the scope gives you exposes `channels.<name>.send(...)` for as long as the child runs.
- **Not** retried by the parent, and **not** independently terminable by operators.
- **Not** a thrown failure. A failed child yields `{ ok: false; status: "failed"; error }`. Turning that into a workflow-level failure is the body’s choice via `throw ctx.errors.X(...)`.

## Observing the outcome

An attached child is a dispatched entry, so it resolves through every consumption path:

- **`await` the entry** directly for its success-or-failure union.
- **`ctx.join(handle)`** inside a scope. Passing `{ timeout }` here is a **join timeout**—an observation deadline that adds `{ ok: false; status: "join_timeout" }` and **does not cancel** the child; it keeps running and can be joined again.
- **Implicitly**, through the structured-concurrency helpers (`ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, `ctx.some`) and the completion iterator `ctx.match`, which resolve entries as they complete.

Note the two distinct timeouts. A **join timeout** bounds *your wait* and leaves the child running. An **execution deadline** (set at the call site) bounds *the child’s run*: when it fires the child is terminated and the entry settles as `{ ok: false; status: "timeout" }`. They compose—a single join can surface either—and they are distinguishable by status. Inside the structured-concurrency helpers, a child that hits its execution deadline counts as a **keyed failure** (it produced no result).

## Examples

**Await the outcome directly**

```typescript
const result = await ctx.children.processOrder({ orderId: "o-1" });
if (result.ok) {
  result.result; // the child's typed result
} else {
  // result.status === "failed"; result.error
  throw ctx.errors.OrderFailed("child order failed", { orderId: "o-1" });
}
```

**With an execution deadline** — adds a `timeout` variant to the awaited union

```typescript
const result = await ctx.children.processOrder({ orderId: "o-1" }, { deadlineSeconds: 60 });
// { ok: true; result } | { ok: false; status: "failed"; error } | { ok: false; status: "timeout" }
```

**Run several children under a scope**

```typescript
const all = await ctx.all("fan-out", {
  a: ctx.children.processOrder({ orderId: "a" }),
  b: ctx.children.processOrder({ orderId: "b" }),
});
```

**Send to a child while it runs (relay pattern)**

Inside a scope, the child’s handle exposes `channels.<name>.send(...)`. The parent receives on its own channel and forwards onto the child’s:

```typescript
await ctx.scope(
  "cancelable-order",
  { order: ctx.children.processOrder({ orderId: "o-1" }) },
  async (ctx, { order }) => {
    const fromOutside = await ctx.channels.operatorCancel.receive();
    order.channels.cancel.send({ reason: fromOutside.reason });
    return ctx.join(order);
  },
);
```
