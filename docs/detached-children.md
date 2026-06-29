# Detached Child Workflows

## What it is

A **detached child** is a **fire-and-forget durable start** of a child workflow as its own root. You get one by calling `.start(...)` on a child entry: `ctx.children.<name>(args, opts?).start(detachedOpts)`. The bare call builds the (unstarted) entry; `.start()` commits it as a detached root instead of awaiting it. It returns immediately with a **`ForeignWorkflowHandle`**—a buffered, synchronous start—not an awaitable entry. The child runs **independently** of the parent’s lifecycle and is globally addressable by its `idempotencyKey`. The handle is **send-only**: `channels.<name>.send(...)`, plus the `idempotencyKey`.

```typescript
const fulfillment = ctx.children
  .fulfillOrder({ orderId: "order-42" })
  .start({ idempotencyKey: "fulfill:order-42" });

fulfillment.channels.expedite.send({ priority: "high" }); // send-only, buffered
```

## Defined as

A detached child is the **same child workflow** you would run attached—declared once on the parent under `children`. The mode is decided by the **terminal operation** on the entry: `await` it (or join it, or hand it to `ctx.scope`) to run it *attached*; call `.start()` on it to spin it off *detached*.

```typescript
const placeOrder = defineWorkflow({
  name: "place-order",
  args: z.object({ orderId: z.string() }),
  children: { fulfillOrder },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    const fulfillment = ctx.children
      .fulfillOrder({ orderId: args.orderId })
      .start({ idempotencyKey: `fulfill:${args.orderId}` });
    fulfillment.channels.expedite.send({ priority: "high" });
    return { ok: true };
  },
});
```

See [attached-children.md](./attached-children.md) for the attached form of the same entry.

`args` and the shared start options—`metadata`, `seed`, `retention`, and an optional **execution deadline** (`deadlineSeconds` / `deadlineUntil`)—are supplied **once, in the bare call**. `.start()` takes only what detached adds on top: the **identity key** (see *Identity* below). That single extra argument is the entire difference between the two modes—detached’s options are exactly the attached options plus the key—which is why `.start()` hangs off the entry rather than re-taking `args`. Committing to detached is always explicit: even when the key is derived from args, you still call `.start()` (just with no argument).

## Why it exists

Sometimes you want to **kick off another durable process and move on**—fulfillment that runs for days, a notification pipeline, a reconciliation job whose result the parent does not need to wait for. `.start()` models exactly that: the engine starts a genuine root workflow, the parent gets a handle to address it, and the two lifecycles are independent. The parent can finish (or be terminated) without affecting the child.

The defining axis against its siblings:

- **Detached** (`.start()`) — buffered start that **outlives** the parent, returns a `ForeignWorkflowHandle` with an `idempotencyKey`, **send-only**, **not** joinable from the parent.
- **Attached** (await the entry) — parent-owned, **awaitable**, torn down with the parent, no `idempotencyKey`.
- **External** — you do not start it; you look up an existing instance. (It returns the *same* `ForeignWorkflowHandle` type as `.start()`.)

A detached **start** and an external **lookup** produce the same handle—the difference is whether you created the instance or merely referenced one.

## Identity

A detached child is an independent root you address later, so—unlike an attached child—it lives in the engine’s **global identity namespace** and must have an `idempotencyKey`. How that key is supplied depends on whether the child workflow declares an **`idempotencyKeyFactory`** on its definition:

- **No factory** — you must pass `idempotencyKey` explicitly: `.start({ idempotencyKey })`. This is a deliberate constraint: starting a global root without a stable, predefined identity is a real decision, and the type system makes you own it rather than silently minting a random key.
- **Factory present** — the key is derived from the workflow’s arguments by the factory, and `.start()` takes **no argument**. The factory is the single source of identity: a workflow with a factory is always addressable by its args (`client.workflows.<name>.get(args)`), and allowing a caller to override the key would let an instance exist under an identity its own args don’t reproduce—defeating the lookup. So we forbid the override entirely.

```typescript
const fulfillOrder = defineWorkflow({
  name: "fulfill-order",
  args: z.object({ orderId: z.string() }),
  idempotencyKeyFactory: (args) => `fulfill:${args.orderId}`,
  // …
});

// factory present → key derived from args, .start() takes nothing:
ctx.children.fulfillOrder({ orderId: "order-42" }).start();
```

## What it is NOT

- **Not** awaitable or joinable in the parent. There is no outcome union returned to the body. To observe the child’s result later, go through a client/operator handle—`client.workflows.<name>.get(...)` and then `wait()`.
- **Not** lifecycle-bound to the parent. It is a true root; the parent finishing or being terminated does not tear it down.
- **Not** a full operator handle in the body. What you hold is send-only. The richer surface (status, lifecycle verbs) is available later through the client.
- **Not** something to `await`. `.start()` returns a `ForeignWorkflowHandle`, which has no awaitable result; `await entry.start(...)` just yields the handle unchanged.

## Examples

**Fire-and-forget with an explicit key** (no factory on the child)

```typescript
const fulfillment = ctx.children
  .fulfillOrder({ orderId: "order-42" })
  .start({ idempotencyKey: "fulfill:order-42" });
fulfillment.channels.expedite.send({ priority: "high" });
```

**Key derived from args** (child declares an `idempotencyKeyFactory`)

```typescript
const fulfillment = ctx.children.fulfillOrder({ orderId: "order-42" }).start();
// no key at the call site — the factory derived it from args
```

**Shared options in the bare call, key in `.start()`**

The execution deadline, metadata, seed, and retention are start options shared with the attached form, so they go in the bare call. Only the identity key belongs to `.start()`.

```typescript
ctx.children
  .fulfillOrder({ orderId: "order-42" }, { deadlineSeconds: 3_600 })
  .start({ idempotencyKey: "fulfill:order-42" });
```

**Observing the child later, from the client**

```typescript
const handle = client.workflows.fulfillOrder.get("fulfill:order-42");
const outcome = await handle.wait();
```
