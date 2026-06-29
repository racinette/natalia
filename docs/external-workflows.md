# External Workflows

## What it is

An **external workflow** is an **independent (root) workflow instance** that lives on its own lifecycle, addressed globally by its `idempotencyKey`. You declare the target on the workflow’s implementation under `externalWorkflows`, then interact with it inside the body through `ctx.externalWorkflows.<name>`, which offers two operations:

- **`.get(...)`** — **reference** an instance that already exists.
- **`.start(args, opts)`** — **create** a new instance (a fire-and-forget durable start).

Both return an **`ExternalWorkflowHandle`**—a **send-only** handle (`channels.<name>.send(...)` plus the `idempotencyKey`). There is no awaitable result and no lifecycle control; you message the instance, you do not own it.

```typescript
// reference an existing instance
const partner = ctx.externalWorkflows.partner.get("idem-1");
partner.channels.notify.send({ n: 1 });

// create a new independent instance and move on
const reconcile = ctx.externalWorkflows.reconcile.start(
  { window: "2026-06-29" },
  { idempotencyKey: "reconcile-2026-06-29" },
);
```

The unifying idea: **`get` and `start` are two ways to obtain a handle to the same kind of thing — an independent root.** Whether you created it or merely referenced it, the handle and the relationship are identical.

## Defined as

Declare the workflows you reach this way under `externalWorkflows`. This is an **implementation concern**, declared on `.implement({ externalWorkflows: { … } })`, and is **not** part of the public `WorkflowInterface`:

```typescript
const coordinator = coordinatorInterface.implement({
  externalWorkflows: { partner: partnerHeader, reconcile: reconcileWorkflow },
  steps: { /* … */ },
  async execute(ctx, args) {
    ctx.externalWorkflows.partner.get(args.partnerKey).channels.handoff.send({
      orderId: args.orderId,
    });
    return undefined;
  },
});
```

## Why it exists

Workflows often need to interact with **independent, globally-addressable instances they do not own**—kick off a long-running side process and move on, nudge a peer, hand off a signal, reconcile out of band. That is a fundamentally different relationship from a [child workflow](./child-workflows.md), which you own and await under structured concurrency.

The defining axis:

- **`externalWorkflows`** — an independent root you **create** (`.start`) or **reference** (`.get`). Globally addressable, send-only `ExternalWorkflowHandle`, not awaitable, runs on its own lifecycle.
- **[`childWorkflows`](./child-workflows.md)** — a workflow you **spawn and own**: awaitable, lifecycle-bound, torn down with the parent, not globally addressable.

`create` vs `reference` is a call-site choice (`.start` vs `.get`) because both yield the same independent-root handle. `own` vs `independent`, by contrast, is the declaration-time choice between `childWorkflows` and `externalWorkflows`.

## Identity

Independent roots live in the engine’s **global identity namespace**, so identity is explicit. How the key is supplied depends on whether the target declares an **`idempotencyKeyFactory`**:

- **No factory** — `.start(args, { idempotencyKey })` requires the key, and `.get(idempotencyKey)` looks up by it. Starting a global root without a stable, predefined identity is a real decision; the type system makes you own it.
- **Factory present** — the key is derived from the workflow’s arguments. `.start(args, {})` takes no key (passing one is rejected), and `.get(args)` looks the instance up *by args* (the engine derives the same key). The factory is the single source of identity, so `get(args)` always finds what `start(args)` created.

## What it is NOT

- **Not** awaitable. There is no result to observe in the parent body—the handle is send-only.
- **Not** a lifecycle handle: no `sigkill`/`sigterm`/`skip`, and no events or streams. Only `channels.send()` is exposed—deliberately, to prevent tight coupling between the two workflows.
- **Not** a child. A started external workflow **outlives** the parent and is not torn down with it; the parent finishing or being terminated does not affect it.
- **Not** part of the public `WorkflowInterface`. The `externalWorkflows` map is an **implementation** concern—declared on `.implement({ externalWorkflows: { … } })`, never on the interface a caller sees, so the public contract doesn’t imply lifecycle coupling to other workflows.

## Examples

**Reference an existing instance** (no factory → by key)

```typescript
const partner = ctx.externalWorkflows.partner.get("idem-1");
partner.channels.notify.send({ n: 1 });
partner.idempotencyKey; // the key you looked up
```

**Create a new independent root** (no factory → key required)

```typescript
const handle = ctx.externalWorkflows.fulfillOrder.start(
  { orderId: "order-42" },
  { idempotencyKey: "fulfill:order-42", deadlineSeconds: 3_600 },
);
handle.channels.expedite.send({ priority: "high" });
```

**Factory-declared identity** (key derived from args)

```typescript
const fulfillOrder = defineWorkflow({
  name: "fulfill-order",
  args: z.object({ orderId: z.string() }),
  idempotencyKeyFactory: (args) => `fulfill:${args.orderId}`,
  // …
});

// start: no key passed — derived from args
ctx.externalWorkflows.fulfillOrder.start({ orderId: "order-42" }, {});
// get: look up the same instance by args
ctx.externalWorkflows.fulfillOrder.get({ orderId: "order-42" });
```

## Notes

- **Sends are buffered.** A send to a non-existent instance does not throw in the body—the `send` returns `void`, and a not-found outcome is resolved at the engine level rather than surfaced synchronously to the caller.
- **`.start` is buffered and synchronous.** It returns the `ExternalWorkflowHandle` immediately; the instance is dispatched at the next batch commit.
- **For a richer handle**, use the client: `client.workflows.<name>.get(...)` (by `args` with a factory, by `idempotencyKey` otherwise) returns a full external handle with status, `wait()`, and operator verbs. The in-body `ExternalWorkflowHandle` is intentionally narrower.
- **Operator introspection:** a parent instance exposes `instance.externalWorkflows.<name>` as a full `WorkflowHandleExternal` (lifecycle verbs, `idempotencyKey`), while its owned `instance.childWorkflows.<name>` exposes the narrower, search-only attached handle.
