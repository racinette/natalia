# Child Workflows

## What it is

A **child workflow** is a workflow run as a **dispatched entry of its parent**, with its lifecycle **owned by the parent** under structured concurrency. You invoke one inside the body with `ctx.childWorkflows.<name>(args, opts)`. The call returns an **awaitable entry**: the parent observes the child’s outcome by `await`-ing it directly, by joining it in a scope, or implicitly through the structured-concurrency helpers. When the entry is placed inside a `ctx.scope`, the scope hands you a **handle** to the running child that is also **sendable**—you can deliver messages to it on its channels while it runs.

```typescript
const result = await ctx.childWorkflows.processOrder(
  { orderId: "o-1" },
  { metadata: undefined },
);
// { ok: true; result } | { ok: false; status: "failed"; error }
```

A child workflow is the engine’s **subroutine call**: the parent dispatches it, the engine runs it as its own durable instance, and the parent treats the outcome as a local value—success or a structured failure, never a thrown exception.

> Child workflows are **owned** and **awaitable**. To spin off an *independent* workflow that outlives you (a "detached" start), declare and start it through [`externalWorkflows`](./external-workflows.md) instead — that is a different relationship (create-and-reference an independent root), not a different way to call a child.

## Defined as

A child workflow is an ordinary workflow—nothing special at the definition site:

```typescript
const processOrder = defineWorkflow({
  name: "process-order",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ shipped: z.boolean() }),
  channels: {
    cancel: z.object({ reason: z.string() }),
  },
  async execute(ctx) {
    // …
    return { shipped: true };
  },
});
```

To use it as a child, declare it on the parent under `childWorkflows`:

```typescript
const order = defineWorkflow({
  name: "order",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  childWorkflows: { processOrder },
  async execute(ctx) {
    const result = await ctx.childWorkflows.processOrder(
      { orderId: ctx.args.orderId },
      { metadata: undefined },
    );
    return { ok: result.ok };
  },
});
```

Call-time options are **`metadata`** (required in the options bag — pass `undefined` when the child schema is `z.undefined()`), **`seed`**, **`retention`**, and an optional **execution deadline** (`deadlineSeconds` / `deadlineUntil`). There is no `retry` (workflows are not retried—an unrecoverable error halts for fix-and-replay, it does not re-run the body), and there is no `idempotencyKey` (see below).

## Why it exists

Composition. Some work is itself a full workflow—its own steps, retries, channels, durability—but you want to run it *as part of* a larger workflow and act on its result. A child workflow gives you exactly that, with the guarantees of structured concurrency: the child is **bound to the parent’s lifetime**, observed through a typed entry, and torn down with the parent rather than left running as an orphan.

That is the primitive’s defining axis, held against its sibling:

- **`childWorkflows`** — a workflow you **spawn and own**: awaitable, sendable while running *via its scope handle*, **not** globally addressable (no `idempotencyKey`), torn down with the parent.
- **[`externalWorkflows`](./external-workflows.md)** — an **independent root** you either **create** (`.start`) or **reference** (`.get(identity)`): globally addressable through [workflow identity](./workflow-identity.md), a send-only `ExternalWorkflowHandle`, not awaitable, runs on its own lifecycle.

The line between them is **create-an-owned-child** vs **touch-an-independent-root** — not a call-time toggle.

## Why child workflows have no idempotency key

This is a deliberate design decision, not an omission.

An `idempotencyKey` places a workflow in the engine’s **global identity namespace**, where every key must be unique. If child workflows carried keys, a child started under one parent could **collide** with a workflow of the same key started in another scope entirely—two instances claiming one identity, with independent and conflicting lifecycles, and no sensible way to reconcile them. Who owns the run? Whose termination wins? There is no good answer, so we don’t allow the situation to arise.

Keeping child workflows **keyless namespaces them under their parent**: a child’s identity is its parent’s identity plus its deterministic position in the body. That is replay-stable and collision-free by construction. (An independent root you genuinely want to address by key is an `externalWorkflows` start, not a child.)

They are not hidden, though. Child workflows remain **fully observable from the outside** — through parent-scoped search on the client, not by key lookup. See [Operator introspection](#operator-introspection).

## What it is NOT

- **Not** globally addressable. No `idempotencyKey`; reach them through `parentHandle.childWorkflows.<name>`, not `client.workflows.<name>.get(identity)`.
- **Not** sendable from the *bare* entry. The awaitable entry returned by `ctx.childWorkflows.<name>(...)` does not carry `channels.send` on its own. Messaging is available on the **scope handle**: place the entry in a `ctx.scope`, and the handle the scope gives you exposes `channels.<name>.send(...)` for as long as the child runs.
- **Not** startable as an independent root. There is no `.start` on the child accessor; that is an [`externalWorkflows`](./external-workflows.md) operation.
- **Not** retried by the parent, and **not** independently terminable by operators (see [Operator introspection](#operator-introspection)).
- **Not** a thrown failure. A failed child yields `{ ok: false; status: "failed"; error }`. Turning that into a workflow-level failure is the body’s choice via `throw ctx.errors.X(...)`.

## Operator introspection

Child workflows are observable from outside the parent body through the client, scoped to a **parent workflow instance**. Start from the parent handle, then search or get by the child's branded id:

```typescript
await client.session(async (session) => {
  const parent = client.workflows.order.get({ orderId: "order-42" });

  const children = await parent.childWorkflows.processOrder.find(
    session,
    ({ status }) => eq(status, "running"),
    { fields: { id: true, args: true, status: true } },
  );

  for (const child of children) {
    await child.fetchRow(session, { fields: { status: true } });
    await child.channels.cancel.send(session, { reason: "operator-review" });
  }
});
```

`parentHandle.childWorkflows.<name>.find(session, …)` and `.count(session, …)` query instances of one declared child workflow under that parent. `.get(childId)` grounds a handle from a known id without I/O.

Global workflow search (`client.workflows.<def>.find`) does not return attached children. They appear only under `parentHandle.childWorkflows.<name>`.

The returned handle supports introspection and messaging declared on the child workflow definition: `fetchRow`, `channels.<name>.send`, and per-instance reads for declared streams, events, and attributes. It does not expose `idempotencyKey`.

### Lifecycle

Operators cannot call `sigkill()`, `sigterm()`, or `skip()` on an attached child handle. The child's lifetime is owned by the parent body and its structured-concurrency scope. When an operator terminates the parent workflow, attached children are torn down with it.

To inspect or control an independent root with full lifecycle verbs (`sigkill`, `sigterm`, `skip`, derived `idempotencyKey`), use [`externalWorkflows`](./external-workflows.md) or global `client.workflows.<def>.get(identity)` — see [Workflow identity](./workflow-identity.md).

See [Operator sessions](../operator-sessions.md) for how snapshot and command calls take `session` as the first argument.

## Observing the outcome

A child workflow is a dispatched entry, so it resolves through every consumption path:

- **`await` the entry** directly for its success-or-failure union.
- **`ctx.join(handle)`** inside a scope. Passing `{ timeout }` here is a **join timeout**—an observation deadline that adds `{ ok: false; status: "join_timeout" }` and **does not cancel** the child; it keeps running and can be joined again.
- **Implicitly**, through the structured-concurrency helpers (`ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`, `ctx.some`) and the completion iterator `ctx.match`, which resolve entries as they complete.

Note the two distinct timeouts. A **join timeout** bounds *your wait* and leaves the child running. An **execution deadline** (set at the call site) bounds *the child’s run*: when it fires the child is terminated and the entry settles as `{ ok: false; status: "timeout" }`. They compose—a single join can surface either—and they are distinguishable by status. Inside the structured-concurrency helpers, a child that hits its execution deadline counts as a **keyed failure** (it produced no result).

## Examples

**Await the outcome directly**

```typescript
const result = await ctx.childWorkflows.processOrder(
  { orderId: "o-1" },
  { metadata: undefined },
);
if (result.ok) {
  result.result; // the child's typed result
} else {
  // result.status === "failed"; result.error
  throw ctx.errors.OrderFailed("child order failed", { orderId: "o-1" });
}
```

**With an execution deadline** — adds a `timeout` variant to the awaited union

```typescript
const result = await ctx.childWorkflows.processOrder(
  { orderId: "o-1" },
  { metadata: undefined, deadlineSeconds: 60 },
);
// { ok: true; result } | { ok: false; status: "failed"; error } | { ok: false; status: "timeout" }
```

**Run several children under a scope**

```typescript
const all = await ctx.all("fan-out", {
  a: ctx.childWorkflows.processOrder({ orderId: "a" }, { metadata: undefined }),
  b: ctx.childWorkflows.processOrder({ orderId: "b" }, { metadata: undefined }),
});
```

**Send to a child while it runs (relay pattern)**

Inside a scope, the child’s handle exposes `channels.<name>.send(...)`. The parent receives on its own channel and forwards onto the child’s:

```typescript
await ctx.scope(
  "cancelable-order",
  { order: ctx.childWorkflows.processOrder({ orderId: "o-1" }, { metadata: undefined }) },
  async (ctx, { order }) => {
    const fromOutside = await ctx.channels.operatorCancel.receive();
    order.channels.cancel.send({ reason: fromOutside.reason });
    return ctx.join(order);
  },
);
```
