# Queues

## What it is

A **queue** is a **global competing-consumer work queue**. Workflows **enqueue typed messages** as a synchronous buffered operation; workers **register handlers** on the client to process messages exactly once.

`defineQueue` declares a **name**, **message** schema, and optional **`error`** schema (enables `ctx.error({ typed })` when declared), plus optional **`defaultDelay`** and **`defaultTtl`**. Workflows reference the definition in `queues: { slot: myQueue }` and call **`ctx.queues.<slot>.enqueue(payload, opts?)`**. The client exposes **`client.queues.<definitionName>`** (keyed by the queue definition's `name`, not the workflow-local slot).

## Workflow enqueue

`enqueue` returns **`void`** — do not `await` it. The engine records the operation in the workflow's durable batch commit.

Options include **`priority`**, **`delay`** (`number | Date | 0`), and **`ttl`** (`number | Date | null`). When the definition omits `defaultTtl`, enqueue **must** pass `ttl`.

```typescript
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Hello" },
  { priority: 0, delay: 60, ttl: 3600 },
);
```

## Handler registration

Register on the client queue namespace only:

```typescript
const unregister = client.queues.notifications.registerHandler(
  async (message, ctx) => {
    if (!isValid(message)) {
      throw ctx.error({
        deadLetter: true,
        type: "InvalidPayload",
        message: "Message failed validation",
      });
    }
    await sendEmail(message.userId, message.body, { signal: ctx.signal });
  },
  {
    maxConcurrent: 10,
    retryPolicy: {
      timeoutSeconds: 30,
      maxAttempts: 5,
      intervalSeconds: 1,
      backoffRate: 2,
    },
  },
);
```

Handlers receive **decoded** messages (`z.output`). Handler return type is **`void`** — failures are **throws**:

- **Normal return** — message processed successfully.
- **`throw ctx.error({ deadLetter: true, ... })`** — dead-letter immediately (`handler_reject`).
- **`throw ctx.error({ deadLetter: false, ... })`** — record attempt, retry per policy.
- **`typed`** — only when the queue declares an `error` schema on `defineQueue`; validated against that schema. Queues without `error` have no `typed` field on `ctx.error`.
- **Unhandled throw** — safe loose fields, `typed.status: "unspecified"`, retry.

`retryPolicy` is **required**. Set **`maxAttempts: null`** for no attempt cap (still subject to message `ttl`, etc.).

**`MANUAL` is not used** for queue handlers. **`UnrecoverableError` is for topic consumers only** (topics unchanged for now).

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
const attempts = await handle.attempts();
const last = attempts ? await attempts.last() : undefined;
```

Dead-letter reasons: **`max_attempts`**, **`ttl_expired`**, **`invalid_payload`**, **`handler_reject`**.

- **`.get(id)`** — synchronous; branded `DeadLetterId`; no `txOrConn`.
- **`fetchRow`**, **`attempts()`**, **`retry`**, **`purge`**, and namespace query methods — accept optional **`txOrConn?`**.
