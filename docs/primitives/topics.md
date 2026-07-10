# Topics

## What it is

A **topic** is a **global, ordered, append-only log** with a name and a typed record schema (plus optional typed metadata). Workflows **publish** records into it; **named, independent consumers**—registered on the client—each track their own read offset and process records in order. One published record can be delivered to many consumers, and many different workflows can publish to the same topic. It is pub/sub fan-out: the producer does not know or care who is listening.

```typescript
const auditTopic = defineTopic({
  name: "auditEvents",
  record: z.object({ type: z.string(), payload: z.unknown() }),
  metadata: z.object({ tenantId: z.string(), type: z.string() }),
  retentionSeconds: 86_400 * 7,
});
```

A workflow that declares the topic **publishes** with `ctx.topics.<name>.publish(...)`. Consumption happens entirely **outside** the workflow, on the client: each consumer has a name, a handler, and its own durable cursor over the topic’s history.

## Why it exists

Topics solve **cross-instance, many-to-many event distribution** where the producer is decoupled from the consumers and each consumer wants its own independent cursor over the full ordered history—audit trails, analytics and warehouse ingestion, fan-out to several downstream subscribers that must each see every record.

That is a different shape from the neighboring primitives, and the distinction is the whole point:

- **vs. channels (point-to-point, per-instance):** a channel `send` reaches exactly **one** instance—the one your handle identifies—and is received *inside* that workflow. A topic is global and fans **out** to many external consumers, none of which is the publishing workflow.
- **vs. queues (competing consumers, exactly-once):** a queue message is processed **once**, by **one** worker; consumers compete. A topic fans **out**: every matching consumer independently sees every record. Queues dead-letter a poisoned message; topics signal permanent failure differently (below).
- **vs. streams (instance-scoped log):** a stream is also an ordered append-only log, but its partition is a **single workflow instance**, and it is read by handle. A topic is **global** per topic name and read by **named external consumers**, each with its own offset.

## What it is NOT

- **Not** point-to-point or per-instance—that is a **channel**.
- **Not** exactly-once competing consumption—that is a **queue**. Every matching consumer receives every record.
- **Not** instance-scoped—that is a **stream**. The log is global per topic name.
- **Not** consumable from inside a workflow. Workflows **publish only, never consume**; consumption lives on the client.
- **Not** request/response: `publish` returns no reply and is not awaited.

## Examples

**Defining a topic**

```typescript
const auditTopic = defineTopic({
  name: "auditEvents",
  record: z.object({ type: z.string(), payload: z.unknown() }),
  metadata: z.object({ tenantId: z.string(), type: z.string() }),
  retentionSeconds: 86_400 * 7,
});
```

**Publishing from a workflow**

`publish` is a synchronous **buffered** operation—it returns `void` and is not awaited. The record commits with the workflow’s next durable batch, and replays reproduce it deterministically.

```typescript
const wf = defineWorkflow({
  name: "checkout",
  args: z.object({ orderId: z.string(), tenantId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  topics: { audit: auditTopic },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.topics.audit.publish(
      { type: "booking.confirmed", payload: { orderId: ctx.args.orderId } },
      { metadata: { tenantId: ctx.args.tenantId, type: "booking.confirmed" } },
    );
    return { ok: true };
  },
});
```

**Registering a single-record consumer on the client**

Each named consumer keeps its own offset. Delivery is **at-least-once**; a handler signals a permanent, non-retryable failure by throwing `UnrecoverableError`.

```typescript
const unregister = client.registerTopicConsumer(
  auditTopic,
  "analytics",
  async (record, { signal }) => {
    await ingestToWarehouse(record, { signal });
  },
  {
    filter: (q) =>
      q.and(q.metadata.tenantId.eq("acme"), q.payload.type.eq("booking.confirmed")),
    retryPolicy: { intervalSeconds: 1, backoffRate: 2, maxAttempts: 5 },
    onConsumeError: {
      // attemptsExhausted defaults to "halt" (don't silently drop);
      // offsetExpired defaults to "skip" (records are already gone).
      callback: async (event) => (event.type === "attemptsExhausted" ? "skip" : "halt"),
    },
  },
);
```

**Registering a batch consumer**

```typescript
client.registerBatchTopicConsumer(
  auditTopic,
  "warehouseSync",
  async (records, { signal }) => {
    // records is a non-empty, ordered batch
    await bulkInsert(records, { signal });
  },
  {
    batch: { maxRecords: 500, intervalSeconds: 10 },
    neverExpire: true, // retention won't purge records this consumer hasn't read
  },
);
```

## Notes

- **Independent offsets.** Each named consumer has its own cursor; one consumer falling behind or halting does not affect the others.
- **Ordering.** Records are delivered to a consumer in commit order; a consumer never advances past a record that has not yet committed.
- **Filters skip, they don’t buffer.** A non-matching record advances the consumer’s offset without invoking the handler.
- **`neverExpire` is per-consumer.** It prevents retention from purging records a specific consumer has not yet read—at the cost of unbounded growth if that consumer stays offline. It also makes an expired-offset error impossible by construction.
- **Permanent failure.** Throw `UnrecoverableError` from a handler to stop retrying immediately and route to the `onConsumeError` path. (`UnrecoverableError` is for topic consumers; queues dead-letter instead.)
