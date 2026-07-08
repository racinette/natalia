# Queues

A queue holds typed work items that workflows enqueue and client workers process. Each message is handled once: competing handlers claim eligible messages from a shared pool. Workflows record enqueues in their durable batch; handlers run outside workflow replay.

## Quick start

Define the queue (name, message schema, and optional defaults):

```typescript
const notifications = defineQueue({
  name: "notifications",
  message: z.object({
    userId: z.string(),
    template: z.enum(["welcome", "receipt"]),
    body: z.string(),
  }),
  errors: {
    UnsupportedTemplate: true,
    ProviderRejected: z.object({ code: z.string(), orderId: z.string() }),
  },
  defaultTtl: 3600,
});
```

Declare it on a workflow and enqueue from `execute`:

```typescript
const onboarding = defineWorkflow({
  name: "onboarding",
  queues: { notifications },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    ctx.queues.notifications.enqueue(
      { userId: args.userId, template: "welcome", body: "Welcome!" },
      { priority: 0, delay: 60, ttl: 1800 },
    );
    return { ok: true };
  },
});
```

`enqueue` returns `void`. Do not `await` it — the write commits with the workflow's next durable batch.

Register a handler on the client (keyed by the queue definition's `name`, not the workflow-local slot name):

```typescript
const unregister = client.queues.notifications.registerHandler(
  async (ctx) => {
    if (ctx.message.template === "receipt") {
      throw ctx.errors.UnsupportedTemplate("Receipt emails are not supported", {
        deadLetter: true,
      });
    }
    await sendEmail(ctx.message.userId, ctx.message.body, { signal: ctx.signal });
  },
  {
    maxConcurrent: 10,
    retryPolicy: {
      timeoutSeconds: 30,
      maxAttempts: 5,
      intervalSeconds: 1,
      backoffRate: 2,
      maxIntervalSeconds: 60,
    },
  },
);
```

Call `unregister()` to stop this registration from claiming new messages. Other handlers on the same queue keep competing.

## Enqueueing from workflows

Workflows reference a queue in `queues: { slot: myQueue }` and enqueue with `ctx.queues.<slot>.enqueue(payload, opts?)`.

The workflow slot (`notifications` in the example above) is only for `ctx.queues`. The client namespace uses `defineQueue`'s `name` field — often the same string, but only `name` is guaranteed on `client.queues`.

Enqueue is also available in compensation `undo` callbacks when the compensation block declares the queue:

```typescript
compensation: {
  queues: { notifications },
  async undo(ctx, args, info) {
    if (info.status === "completed") {
      ctx.queues.notifications.enqueue({
        userId: args.userId,
        template: "welcome",
        body: "Your order was cancelled",
      });
    }
  },
},
```

See [steps.md](./steps.md) for compensation declaration rules.

### Delay and expiry

Per-enqueue options control when a message becomes claimable and when it expires:

```typescript
ctx.queues.notifications.enqueue(
  { userId: "u1", template: "welcome", body: "Hello" },
  { priority: 0, delay: 60, ttl: 1800 },
);
```

A numeric `delay` is seconds from commit (replay-stable). A `Date` delay is an absolute eligible time. Omit `delay` or pass `0` for immediate eligibility.

A numeric `ttl` is a processing window measured from eligibility, not from enqueue. With `{ delay: 3600, ttl: 1800 }`, the message becomes eligible after one hour and expires thirty minutes after that. A `Date` ttl is an absolute expiry time. Pass `ttl: null` for a message that never expires.

If the queue definition omits `defaultTtl`, every enqueue must pass `ttl`.

At commit the engine persists `eligible_at` and `expires_at`. Numeric `ttl` resolves against `eligible_at`. Replays reuse the timestamps from the first commit. Enqueue rejects `eligible_at >= expires_at`.

### Claim ordering

Eligible, unexpired messages are claimed in order:

`priority ASC, eligible_at ASC, id ASC`

Lower `priority` values are more urgent. Priority is preserved when a dead-lettered message is retried.

## Handling messages

Handlers register with `client.queues.<definitionName>.registerHandler(handler, options)`. The handler receives a single `ctx` with `message`, `signal`, and `errors`. Payloads that fail schema decode are dead-lettered as `invalid_payload` before the handler runs. A normal return marks the message processed.

Declare an optional `errors` map on `defineQueue` to get typed throw helpers on `ctx.errors`:

```typescript
// errors: { UnsupportedTemplate: true }
throw ctx.errors.UnsupportedTemplate("Receipt emails are not supported", {
  deadLetter: true,
});

// errors: { ProviderRejected: schema }
throw ctx.errors.ProviderRejected(
  "SMTP timed out",
  { code: "SMTP_TIMEOUT", orderId: "o-1" },
  { deadLetter: false },
);
```

Every `ctx.errors` call requires `{ deadLetter }`. `deadLetter: true` dead-letters immediately. `deadLetter: false` records a failed attempt and retries per `retryPolicy`. An ordinary unhandled throw also records a failed attempt and retries.

`retryPolicy` is required. Set `maxAttempts` to a number to cap retries before dead-lettering, or `null` to retry until the handler succeeds, the message ttl expires, or the handler dead-letters via `ctx.errors`.

```typescript
client.queues.notifications.registerHandler(handler, {
  retryPolicy: { maxAttempts: 5, timeoutSeconds: 30 },
  retentionPolicy: async (ctx) => {
    if (ctx.status === "processed") return 86400;
    if (ctx.reason === "invalid_payload") return 3600;
    const attempts = await ctx.attempts.find();
    return attempts.length > 5 ? 86400 * 90 : 86400 * 30;
  },
});
```

`retentionPolicy` runs once when a message reaches a terminal state (`processed` or `dead_lettered`). Return seconds to keep the row, or `null` to keep it indefinitely. The callback receives the decoded message, terminal status, dead-letter reason (if any), and a parent-scoped `attempts` read namespace.

See [error-model.md](../error-model.md) for how queue handler errors relate to workflow errors.

## Dead letters

Messages that cannot be processed successfully are dead-lettered. Query and act on them inside `client.session`:

```typescript
await client.session(async (session) => {
  const matches = await client.queues.notifications.deadLetters.find(
    session,
    ({ reason }) => eq(reason, "max_attempts"),
    { fields: { id: true, payload: true }, limit: 10 },
  );

  for (const deadLetter of matches) {
    await deadLetter.retry(session);
  }

  const handle = client.queues.notifications.deadLetters.get(deadLetterId);
  await handle.fetchRow(session, {
    fields: { payload: true, reason: true },
  });

  const attemptHandles = await handle.attempts.find(session, {
    sort: [{ path: "attemptNumber", direction: "desc" }],
    limit: 1,
    fields: { code: true, message: true, details: true },
  });
  const last = attemptHandles[0]?.row;
  if (last?.code === "ProviderRejected" && last.details?.ok === true) {
    const { orderId } = last.details.result;
  }

  await handle.purge(session);
});
```

`retry` puts the message back on the queue with its priority and persisted expiry unchanged. `purge` deletes the dead-letter row.

Dead-letter ids are branded per queue definition name.

## Reference

### Message lifecycle

| Phase | Meaning |
|-------|---------|
| Pending | Enqueued, waiting until `eligible_at`. |
| Processing | Claimed; handler running under `retryPolicy`. |
| Processed | Handler returned successfully. |
| Dead-lettered | Terminal failure (see reasons below). |

After a terminal transition, `retentionPolicy` (if registered) sets `retention_deadline_at` for eventual row deletion.

### Handler outcomes

| Action | Outcome |
|--------|---------|
| Normal return | Processed. |
| `throw ctx.errors.X(..., { deadLetter: true })` | Dead-letter (`handler_reject`). |
| `throw ctx.errors.X(..., { deadLetter: false })` | Failed attempt; retry per policy. |
| Unhandled throw | Failed attempt with `code: null`; retry per policy. |

### Attempt records

Failed tries are persisted. Successful handling does not create attempt rows.

```typescript
type QueueHandlerAttemptDetails<T> =
  | { ok: true; status: "serialized"; result: T }
  | { ok: false; status: "serialization_error"; error: BaseError }
  | { ok: false; status: "unspecified" };
```

Unhandled throws use `code: null`, optional `message` and `type`, and `details.status: "unspecified"`. Narrow on `attempt.code` first, then on `attempt.details.ok` for schema-backed codes.

### Dead-letter reasons

| Reason | When |
|--------|------|
| `max_attempts` | `retryPolicy.maxAttempts` exhausted. |
| `ttl_expired` | `expires_at` passed before success. |
| `invalid_payload` | Payload failed schema decode before the handler ran. |
| `handler_reject` | Handler threw `ctx.errors.X(..., { deadLetter: true })`. |
