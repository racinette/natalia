# External Workflows

## What it is

An **external workflow** is an **independent (root) workflow instance** that lives on its own lifecycle, addressed globally through the target workflow's [identity](./workflow-identity.md). You declare the target on the workflow's implementation under `externalWorkflows`, then interact with it inside the body through `ctx.externalWorkflows.<name>`, which offers two operations:

- **`.get(identity)`** — **reference** an instance that already exists.
- **`.start(args, opts)`** — **create** a new instance (a fire-and-forget durable start).

Both return an **`ExternalWorkflowHandle`**—a **send-only** handle (`channels.<name>.send(...)` plus the derived `idempotencyKey`). There is no awaitable result and no lifecycle control; you message the instance, you do not own it.

```typescript
// reference an existing instance (identity shape from the target's identity.schema)
const partner = ctx.externalWorkflows.partner.get({ token: "idem-1" });
partner.channels.notify.send({ n: 1 });

// create a new independent instance and move on
const reconcile = ctx.externalWorkflows.reconcile.start(
  { window: "2026-06-29" },
  { metadata: undefined },
);
```

The unifying idea: **`get` and `start` are two ways to obtain a handle to the same kind of thing — an independent root.** Whether you created it or merely referenced it, the handle and the relationship are identical.

## Defined as

Declare the workflows you reach this way under `externalWorkflows`. This is an **implementation concern**, declared on `.implement({ externalWorkflows: { … } })`, and is **not** part of the public `WorkflowInterface`:

```typescript
const coordinator = coordinatorInterface.implement({
  externalWorkflows: { partner: partnerHeader, reconcile: reconcileWorkflow },
  steps: { /* … */ },
  async execute(ctx) {
    ctx.externalWorkflows.partner
      .get({ token: ctx.args.partnerToken })
      .channels.handoff.send({ orderId: ctx.args.orderId });
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

Independent roots use the same [workflow identity](./workflow-identity.md) rules as client starts:

- When the target declares **`deriveIdentity`**, `.start(args, { metadata, … })` passes args and metadata only; the engine derives identity and the persisted key.
- When **`deriveIdentity` is omitted**, `.start(args, { identity, metadata, … })` requires an explicit `identity` object matching `identity.schema`.
- **`.get(identity)`** always takes the decoded identity object — never a raw idempotency key string.

Start options never accept `idempotencyKey`. The handle's `idempotencyKey` field is the derived string from `deriveIdempotencyKey`.

## What it is NOT

- **Not** awaitable. There is no result to observe in the parent body—the handle is send-only.
- **Not** a lifecycle handle: no `sigkill`/`sigterm`/`skip`, and no events or streams. Only `channels.send()` is exposed—deliberately, to prevent tight coupling between the two workflows.
- **Not** a child. A started external workflow **outlives** the parent and is not torn down with it; the parent finishing or being terminated does not affect it.
- **Not** part of the public `WorkflowInterface`. The `externalWorkflows` map is an **implementation** concern—declared on `.implement({ externalWorkflows: { … } })`, never on the interface a caller sees, so the public contract does not imply lifecycle coupling to other workflows.

## Examples

**Reference an existing instance** (explicit identity on the target)

```typescript
const partner = ctx.externalWorkflows.partner.get({ key: "partner-1" });
partner.channels.notify.send({ n: 1 });
partner.idempotencyKey; // derived string from identity.key
```

**Create a new independent root** (derived identity from args)

```typescript
const fulfillOrder = defineWorkflowHeader({
  name: "fulfill-order",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ shipped: z.boolean() }),
  identity: {
    schema: z.object({ orderId: z.string() }),
    deriveIdentity: ({ args }) => ({ orderId: args.orderId }),
    deriveIdempotencyKey: (id) => `fulfill:${id.orderId}`,
  },
});

const handle = ctx.externalWorkflows.fulfillOrder.start(
  { orderId: "order-42" },
  { metadata: undefined, deadlineSeconds: 3_600 },
);
handle.channels.expedite.send({ priority: "high" });

ctx.externalWorkflows.fulfillOrder.get({ orderId: "order-42" });
```

**Create with explicit identity** (no `deriveIdentity` on target)

```typescript
await ctx.externalWorkflows.audit.start(undefined, {
  metadata: undefined,
  identity: { key: "audit-2026-06-29" },
});
```

## Notes

- **Sends are buffered.** A send to a non-existent instance does not throw in the body—the `send` returns `void`, and a not-found outcome is resolved at the engine level rather than surfaced synchronously to the caller.
- **`.start` is buffered and synchronous.** It returns the `ExternalWorkflowHandle` immediately; the instance is dispatched at the next batch commit.
- **For a richer handle**, use the client: `client.workflows.<name>.get(identity)` returns a full external handle with status, `wait()`, and operator verbs. The in-body `ExternalWorkflowHandle` is intentionally narrower.
- **Operator introspection:** a parent instance exposes `instance.externalWorkflows.<name>` as a full workflow handle (lifecycle verbs, derived `idempotencyKey`), while its owned `instance.childWorkflows.<name>` exposes a narrower attached handle — see [Child workflows — Operator introspection](./child-workflows.md#operator-introspection).
