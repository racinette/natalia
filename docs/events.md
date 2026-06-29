# Events

## What it is

An **event** is a per-instance, named, **write-once flag** declared on a workflow. It carries **no payload**—the only information it ever holds is *fired* or *not fired (yet)*. Inside the body, code raises it exactly once with `ctx.events.<name>.set()`. From **outside** the actor, anyone holding a **handle** to that instance **observes** it: block until it fires with `events.<name>.wait()`, or take a snapshot with `events.<name>.isSet()`.

Among the per-instance primitives, events are the **outbound, write-once** signal. Channels are inbound mailboxes; streams are append-only logs; attributes are a mutable current value. An event is the simplest of the family: a one-way latch the instance flips to announce that a single milestone has been reached. You declare them as a set of names with no schema:

```typescript
events: { orderReady: true, paid: true }
```

## Why it exists

Long-running work routinely needs to tell an outside observer “this one-time thing has happened”—*ready*, *paid*, *provisioned*, *undo settled*—without shipping a payload, without retaining history, and without a request/response round-trip. An event is the cheapest durable, replay-safe way to express exactly that.

Because `set()` is **idempotent** and recorded as a buffered operation, it is safe under replay: re-executing the body re-issues `set()` harmlessly, and external observers see the flag flip only once the batch commits. The write-once contract is what makes the primitive trivial to reason about—there is no “current value,” no ordering question, no second state transition to account for.

The other reason events exist is the **`never` terminal**: if a workflow reaches a terminal state without ever setting an event, observers are not left blocking forever. `wait()` resolves to a `never` result, and `isSet()` reports `never`. The latch can be *opened* exactly once, and the engine guarantees observers always learn its final disposition.

## What it is NOT

- **Not** a message or payload carrier: there is no schema and no data on `set()`. If you need to convey a value, you want a **channel** (inbound) or an **attribute**/**stream** (outbound).
- **Not** mutable or resettable: once set it stays set. There is no `unset` or `clear`, and a second `set()` is a no-op.
- **Not** awaitable from *inside* the declaring workflow: the in-body accessor exposes **only `set()`**. A workflow cannot `wait()` on its own event—for intra-workflow coordination use channels and scopes. Events flow *outward*.
- **Not** a selectable branch: only channels participate in `ctx.listen`. Events do not appear in the multiplexing surface.
- **Not** cross-instance or pub/sub: an event belongs to one instance. Fan-out to many subscribers is a **topic**.

## Examples

**Declaring events and raising one from the body**

```typescript
const order = defineWorkflow({
  name: "order",
  events: { orderReady: true, paid: true },
  async execute(ctx, args) {
    await ctx.steps.reserveInventory({ sku: args.sku });
    ctx.events.orderReady.set(); // void, buffered, idempotent on replay
    // …
  },
});
```

**Blocking on an event from a handle**

```typescript
const result = await handle.events.orderReady.wait();
if (result.ok) {
  // result.status === "set"
} else {
  // result.status === "never" — the workflow ended without ever setting it
}
```

**Polling without blocking**

```typescript
const check = await handle.events.orderReady.isSet();
// check.status: "set" | "not_set" | "never" | "not_found"
```

**Bounding a wait with an abort signal**

`wait()` has no built-in deadline—it resolves on *set* or on *never*. To cap how long you are willing to block, pass an `AbortSignal`; aborting rejects rather than returning a status.

```typescript
const result = await handle.events.orderReady.wait({
  signal: AbortSignal.timeout(5_000),
});
```

**Observing a child’s event from a parent**

The same external accessor is available on attached and detached child handles, typed to that workflow’s declared events:

```typescript
const r = await childHandle.events.childReady.wait();
```
