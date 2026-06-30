# Queues

## What it is

A **queue** is a **global competing-consumer work queue**. Workflows **enqueue typed messages** as a synchronous buffered operation; workers **register handlers** on the client to process messages exactly once.

`defineQueue` is **data-only** — it declares a **name**, **message** schema, and optional **`error`** schema (for handler `typed` payloads), plus optional **`defaultDelay`** and **`defaultTtl`**. Handler registration lives on the client, not on the definition.

Workflows reference the definition in `queues: { slot: myQueue }` and call **`ctx.queues.<slot>.enqueue(payload, opts?)`**. The client exposes **`client.queues.<definitionName>`** (keyed by the queue definition's `name`, not the workflow-local slot).

Enqueue is available in workflow `execute` bodies and in compensation `undo` callbacks when the compensation declares the queue dependency.

## Definition

```typescript
const notifications = defineQueue({
  name: "notifications",
  message: z.object({ userId: z.string(), body: z.string() }),
  error: z.object({ code: z.string(), orderId: z.string() }), // optional
  defaultDelay: 0,
  defaultTtl: 3600,
});
```

| Field | Meaning |
|-------|---------|
| `name` | Globally unique queue name (client namespace key). |
| `message` | Standard schema — **input** at enqueue, **output** in handlers. |
| `error` | Optional standard schema for `ctx.error({ typed })`. When omitted, `typed` is absent from `ctx.error`. |
| `defaultDelay` | Default enqueue delay. Omit = `0` (immediate). |
| `defaultTtl` | Default message TTL. Omit = every `enqueue` **must** pass `ttl`. |

**Row retention** (how long processed/dead-lettered DB rows are kept) is not part of the queue definition API yet — deferred.

## Workflow enqueue

`enqueue` returns **`void`** — do not `await` it. The engine records the operation in the workflow's durable batch commit. Exactly-once enqueue: the insert is colocated with the workflow batch; on replay, an existing row is detected and the re-insert is skipped.

```typescript
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Hello" },
  { priority: 0, delay: 60, ttl: 1800 },
);
```

### Options

| Option | Type | Meaning |
|--------|------|---------|
| `priority` | `number` | Lower number = higher urgency. Default `0`. |
| `delay` | `number \| Date \| 0` | When the message becomes **eligible** for claim. Omit or `0` = immediate. `number` = seconds from commit (logical clock, replay-stable). `Date` = absolute eligible time. |
| `ttl` | `number \| Date \| null` | When the message **expires**. Omit = use `defaultTtl` (required on enqueue when the definition has no default). `null` = never expires. |

When the definition omits `defaultTtl`, enqueue **must** pass `ttl` (type-enforced via `HasDefaultTtl`).

### Eligibility and expiry

At commit the engine computes and persists two absolute timestamps:

1. **`eligible_at`** — from `delay`: `created_at + delay` (number), `delay` (Date), or `created_at` if no delay.
2. **`expires_at`** — from `ttl`: `null` (never), the `Date` directly, or **`eligible_at + ttl`** when `ttl` is a number.

**Numeric `ttl` is a processing window after eligibility**, not shelf life from enqueue. Example: `{ delay: 3600, ttl: 1800 }` → eligible in 1h, expires 30m after that.

**`ttl: Date`** is an absolute deadline independent of delay shape — useful for “fire later, but must finish by 5pm.”

**Validation:** `eligible_at < expires_at` at enqueue (reject otherwise).

**Replay:** `eligible_at` and `expires_at` are persisted at first commit and reused on replay (wall-clock for numeric `ttl` is resolved once at commit).

### Claim ordering

Once eligible and not expired, messages are claimed:

`priority ASC, eligible_at ASC, id ASC`

Priority is preserved on dead-letter `retry`.

## Handler registration

Register on **`client.queues.<definitionName>.registerHandler`** only:

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
      maxIntervalSeconds: 60,
    },
  },
);
```

| Registration option | Required | Meaning |
|---------------------|----------|---------|
| `retryPolicy` | **Yes** | Retry strategy + stop condition. |
| `retryPolicy.maxAttempts` | **Yes** | `number` = attempt cap before `max_attempts` dead-letter; `null` = retry forever (still subject to `ttl`, etc.). |
| `maxConcurrent` | No | Cap concurrent handler invocations per consumer instance. |

Handler registration does **not** accept `txOrConn?`.

Handlers receive **decoded** messages (`z.output`) and **`{ signal, error }`**. Return type is **`void`** — failures are **throws**.

### Handler outcomes

| Action | Outcome |
|--------|---------|
| Normal return | Message processed. |
| `throw ctx.error({ deadLetter: true, ... })` | Immediate dead-letter (`handler_reject`). |
| `throw ctx.error({ deadLetter: false, ... })` | Record attempt, retry per policy. |
| Unhandled throw | Safe loose fields on attempt, `typed.status: "unspecified"`, retry. |

**`MANUAL`** and **`UnrecoverableError`** are not used for queue handlers (requests and topics respectively).

See [error-model.md](../error-model.md) for how queue handler errors relate to workflow `ctx.errors`.

### `ctx.error`

```typescript
throw ctx.error({
  deadLetter: boolean,       // required
  typed?: T,                 // only when defineQueue declares `error`
  message?: string | null,
  type?: string | null,
  details?: JsonInput,
});
```

When an **`error`** schema is declared, `typed` is optional and validated before persistence. When omitted from the definition, **`typed` is not a field on `ctx.error`**.

### Attempt records

Failed tries are persisted (successful handling writes the outcome directly). Each attempt has loose fields (`message`, `type`, `details`) plus:

```typescript
type Typed<T> =
  | { ok: true; status: "serialized"; result: T }
  | { ok: false; status: "serialization_error"; error: BaseError }
  | { ok: false; status: "unspecified" };
```

- **`serialized`** — `typed` validated and stored.
- **`serialization_error`** — handler offered `typed` but validation failed; handler disposition unchanged, loose fields preserved.
- **`unspecified`** — no `typed` offered, or queue has no `error` schema.

Use **`attempt.typed.ok`** for a fast path: structured `result` vs generic fallback.

## Dead letters

Dead-letter reasons: **`max_attempts`**, **`ttl_expired`**, **`invalid_payload`** (schema decode before handler runs), **`handler_reject`** (`ctx.error({ deadLetter: true })`).

Search via **`client.queues.<name>.deadLetters`** (`findMany`, `findUnique`, `count`, `get`):

```typescript
const matches = client.queues.notifications.deadLetters.findMany(
  ({ reason }) => eq(reason, "max_attempts"),
  { fields: { id: true, payload: true }, limit: 10, txOrConn: tx },
);

for await (const deadLetter of matches) {
  await deadLetter.retry({ txOrConn: tx });
}

const handle = client.queues.notifications.deadLetters.get(deadLetterId);
await handle.fetchRow({ payload: true, reason: true }, { txOrConn: tx });
const attempts = await handle.attempts();
if (attempts?.status === "unique") {
  const last = await attempts.value.last();
  if (last.typed.ok) {
    // structured error from a prior attempt
  }
}
```

| API | `txOrConn` |
|-----|------------|
| `.get(id)` | No (synchronous branded id lookup) |
| `fetchRow`, `attempts()`, `retry`, `purge`, namespace queries | Optional |

`retry` resets the message to pending, preserves priority, and reuses persisted expiry.
