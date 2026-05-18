# Queues

## What it is

A **queue** is a **global competing-consumer work queue**. Workflows **enqueue typed messages** as a synchronous buffered operation; workers **register handlers** on the client to process messages exactly once.

`defineQueue` declares a **name** and **message** schema. Workflows reference the definition in `queues: { slot: myQueue }` and call **`ctx.queues.<slot>.enqueue(payload, opts?)`**. The client exposes **`client.queues.<definitionName>`** (keyed by the queue definition's `name`, not the workflow-local slot).

## Workflow enqueue

`enqueue` returns **`void`** — do not `await` it. The engine records the operation in the workflow's durable batch commit.

Options include **`priority`**, **`ttlSeconds`**, and scheduled delivery via **`ScheduledDeliveryOptions`** (`delaySeconds` or `scheduledAt`, mutually exclusive).

```typescript
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Hello" },
  { priority: 0, delaySeconds: 60, ttlSeconds: 3600 },
);
```

## Handler registration

Register on the client queue namespace (not on `defineQueue` at runtime — the definition-level hook is a transitional stub):

```typescript
const unregister = client.queues.notifications.registerHandler(
  async (message, { signal }) => {
    if (!isValid(message)) {
      return DEAD_LETTER;
    }
    await sendEmail(message.userId, message.body, { signal });
  },
  {
    maxConcurrent: 10,
    retryPolicy: { timeoutSeconds: 30, maxAttempts: 5 },
  },
);
```

Handlers receive **decoded** messages (`z.output`). Handler return type is **`void | typeof DEAD_LETTER`**:

- **`return`** (or implicit `void`) — message processed successfully.
- **`return DEAD_LETTER`** — dead-letter immediately; bypass remaining retry attempts (same intentional-outcome pattern as `return MANUAL` on request handlers).
- **Throw** (e.g. `AttemptError` or an ordinary `Error`) — transient failure; retry per `retryPolicy`.

**`MANUAL` is not used** for queue handlers — escalation is dead-letter storage and operator `retry` / `purge`, not manual resolution. **`UnrecoverableError` is for topic consumers only** (topics are unchanged for now).

Handler registration does **not** accept `txOrConn?`.

## Dead letters

Search via **`client.queues.<name>.deadLetters`** using the unified query API (`findMany`, `findUnique`, `count`, `get`). Search returns **handles**; actions are on the handle:

```typescript
const matches = client.queues.notifications.deadLetters.findMany(
  ({ reason }) => eq(reason, "max_attempts"),
  { fields: { id: true, payload: true }, limit: 10, txOrConn: tx },
);

for await (const deadLetter of matches) {
  await deadLetter.retry({ txOrConn: tx });
}

const handle = client.queues.notifications.deadLetters.get(deadLetterId);
await handle.fetchRow({ payload: true }, { txOrConn: tx });
```

- **`.get(id)`** — synchronous; branded `DeadLetterId`; no `txOrConn`.
- **`fetchRow`**, **`retry`**, **`purge`**, and namespace query methods — accept optional **`txOrConn?`**.
