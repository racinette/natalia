# Channels

## What it is

Treat each **running workflow instance** as an **actor**: private state, no shared memory with other instances or callers, coordination **only by sending messages**. **Channels** are the typed, named mailboxes on that actor—what you declare on the workflow and address per instance.

Code **inside** the actor reads with `ctx.channels` (wait, poll, iterate, or multiplex with `ctx.listen`). Anyone with a **handle** to that instance **sends** with `channels.<name>.send(...)`. **From outside the actor, channels are the only way to send a message the body can await when choosing what to do next**—no shared variables, no silent cross-instance mutation.

## Why it exists

The actor picture keeps orchestration honest: no hidden globals, no “just write into the other workflow’s variables.” Channels make the contract explicit:

- **which** messages exist,
- **what** shape they carry,
- **how** they are used internally by the workflow logic.

That matches durable execution: the body records waits and replays them the same way it records other suspension points.

## What it is NOT

- **Not** a global or anonymous work queue.
- **Not** request/response (`send` does not return the receiver’s reply).
- **Not** publish–subscribe or fan-out: each `send` reaches **one** instance—the one your handle identifies—not a topic or “everyone listening.”
- **Not** shared mutable state between instances.

## Examples

**Declaring channels on a workflow**

```typescript
const orderWorkflow = defineWorkflow({
  name: "order",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  channels: {
    cancel: z.object({ reason: z.string() }),
    nudge: z.object({ at: z.string(), note: z.string().optional() }),
    operatorCancel: z.object({ reason: z.string() }),
  },
  async execute(ctx) {
    // …
    return undefined;
  },
});
```

**Blocking until a message arrives**

```typescript
async execute(ctx) {
  const cancel = await ctx.channels.cancel.receive();
  // use cancel.reason
}
```

**Multiplexing: whichever channel delivers next**

```typescript
async execute(ctx) {
  const inbox = ctx.listen({
    cancel: ctx.channels.cancel,
    nudge: ctx.channels.nudge,
  });

  for await (const event of inbox) {
    if (event.key === "cancel") {
      // event.message — cancel payload
    } else {
      // nudge payload
    }
  }
}
```

**Sending from a caller that holds a handle** (inside `client.session`)

```typescript
await client.session(async (session) => {
  await agent.channels.humanReply.send(session, { text: "Ship it." });
});
```

**Relay (proxy): parent receives on its own channel, forwards to a child workflow** (`ctx.scope` + `join`)

Callers with a handle to **this** instance send on `operatorCancel`. While `processOrder` runs as a child workflow, the parent waits on that mailbox and **relays** the payload onto the child’s `cancel` channel—two actors, two inboxes, one hop in the middle.

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
