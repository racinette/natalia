# External Workflows

## What it is

An **external workflow** is a **reference to an already-existing workflow instance that you did not start**. You declare the target on the workflow’s implementation under `external`, then obtain a handle inside the body with `ctx.external.<name>.get(...)`. The result is a **`ForeignWorkflowHandle`**—a **send-only** handle. You use it purely to message another live instance over its channels; there is no lifecycle control and no awaitable result.

```typescript
const partner = ctx.external.partner.get("idem-1");
partner.channels.notify.send({ n: 1 });
```

## Why it exists

Workflows often need to **coordinate with another globally-addressable instance they do not own**—nudge a long-running peer, hand off a signal, notify a sibling process—without the coupling that the other relationships imply. A step couples you to an implementation; an attached child couples you to a lifecycle; a detached child means *you* started it. An external reference is the loosest coupling available: you name another workflow’s contract, look up an instance by key, and send it messages. Nothing else.

The defining axis against its siblings:

- **External** — a handle to a **pre-existing** instance you did not start, obtained with `ctx.external.<name>.get(...)`; **send-only**.
- **Detached** — *you* start it; also returns a `ForeignWorkflowHandle` with an `idempotencyKey`. The only difference from external is start vs. lookup.
- **Attached** — an owned child, awaitable, messaged via scope + `join`.

External lookups and detached starts produce the **same handle type**—the contrast is solely whether you created the instance.

## What it is NOT

- **Not** a way to **start** a workflow. `get` constructs a handle to an instance presumed to exist; it does not create one. Starting workflows is a client-level operation.
- **Not** awaitable. There is no result to observe in the parent body—the handle is send-only.
- **Not** a lifecycle handle: no `sigkill`/`sigterm`/`skip`, and no events or streams. Only `channels.send()` is exposed—deliberately, to prevent tight coupling between the two workflows.
- **Not** part of the public `WorkflowInterface`. The `external` map is an **implementation** concern—declared on `.implement({ external: { ... } })`, never on the interface a caller sees.

## Examples

**Declaring the target and messaging it**

```typescript
const coordinator = coordinatorInterface.implement({
  external: { partner: partnerWorkflow },
  steps: { /* … */ },
  async execute(ctx, args) {
    const partner = ctx.external.partner.get(args.partnerKey);
    partner.channels.handoff.send({ orderId: args.orderId });
    // …
  },
});
```

**The handle is send-only**

```typescript
const partner = ctx.external.partner.get("idem-1");
partner.channels.notify.send({ n: 1 });
partner.idempotencyKey; // the key you looked up
// no await, no events, no streams, no lifecycle verbs
```

## Notes

- **Lookup is by identity.** When the target declares an `idempotencyKeyFactory`, call `get(args)`—the engine derives the same key the instance was started under. Otherwise call `get(idempotencyKey)` with the explicit key. Either form returns the handle synchronously; it does not fetch or validate existence at call time.
- **Sends are buffered.** A send to a non-existent instance does not throw in the body—the `send` returns `void`, and a not-found outcome is resolved at the engine level rather than surfaced synchronously to the caller.
- **For a richer handle**, use the client: `client.workflows.<name>.get(...)` (by `args` with a factory, by `idempotencyKey` otherwise) returns a full external handle with status, `wait()`, and operator verbs. The in-body `ForeignWorkflowHandle` is intentionally narrower.
