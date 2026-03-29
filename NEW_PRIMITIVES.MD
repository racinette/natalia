# New Primitives — Implementation Plan

> **This document is not authoritative.** It represents the current best understanding of the design, arrived at through iterative discussion. Several sections contain known open questions and unresolved implementation concerns, collected in the [Open Questions](#open-questions-and-implementation-concerns) section at the end. Before beginning implementation of any part, review the open questions for that section. Assume that unmarked decisions are tentative unless they have been explicitly confirmed through additional discussion or prototype work.

## Overview

This document describes primitives and corrections to be added to the public API of the durable workflow engine. It is written as a task description for an implementing agent.

The changes are:

1. **Queues** — global competing-consumer work queues
2. **Requests** — global typed request-response with external handler resolution
3. **Topics** — global ordered per-topic append logs with named consumers
4. **Attributes** — workflow-instance-bound observable single current value
5. **Streams extension** — non-blocking read variant on the external handle
6. **Search query refactoring** — generalize `WorkflowSearchQueryBuilder` into a namespace-parameterized `SearchQuery<TNamespaces>` type
7. **Compensation model correction** — eager compensation trigger on caught failures
8. **AttemptAccessor refactoring** — rename `StepErrorAccessor` → `AttemptAccessor`, make `count()` async, rename `errors` → `attempts` on `StepCompensationResult`
9. **Scheduled delivery** — `delay`/`scheduledAt` option on queue message publish and workflow starts

---

## Motivation

### The instance-bound limitation

Every existing primitive is scoped to a specific workflow instance. Channels receive messages sent to a known instance. Streams write output for a specific instance. Events are flags on a specific instance. This is appropriate for most workflow coordination, but it creates a hard boundary: workflows cannot participate in system-wide coordination without knowing each other's identities.

This boundary becomes a problem for two emerging classes of use cases.

**Agentic workloads.** An agent workflow may reach a point where it genuinely cannot proceed without external input — human intervention, a specialized service, or another agent. Today, the only way to model this is via channels (the caller must know the agent's instance ID and send a message directly) or via steps (the workflow owns the implementation). Neither fits. Channels require tight coupling between caller and agent. Steps require the workflow author to know and own the implementation, which defeats the purpose of delegation.

What is needed is a primitive where a workflow can post a typed request into a shared resolution space and block until whoever can fulfill it does so, without knowing or caring who that is.

**Cross-workflow event streaming.** Today, streams are per-instance output logs. There is no way for multiple workflows to publish to a shared ordered log, and no way for external consumers to subscribe to a filtered stream of events across all instances. This matters for audit trails, event sourcing, and triggering downstream systems without direct coupling.

### Why existing primitives do not cover these cases

| Need | Why existing primitives fall short |
|---|---|
| Global work queue | Channels are instance-bound; you must know the target. No competing-consumer semantics exist. |
| Delegated typed request-response | Steps require the workflow author to own the implementation. Foreign workflow channels require knowing the target instance and cannot return a typed response. |
| Global ordered event log | Streams are per-instance. No multi-producer, multi-consumer, offset-tracked log exists. |
| Observable current value | Streams retain full history (expensive). Events are write-once flags with no value. Nothing models "current state" with change notification. |

### Why the compensation model needs correction

The current compensation model defers all callbacks to the LIFO unwind that happens during workflow failure or termination. A successfully completing workflow never triggers compensation.

This is incorrect for one important class of case: a step (or request) that was attempted but failed, where the failure was caught with `.failure()` or `.timeout()`. Consider a POST endpoint that processes the request and records the side effect, but fails to send a response and returns 500. The step is marked failed from the workflow's perspective. The workflow catches the failure with `.failure(() => null)` and continues. The external system has the side effect. The workflow completes successfully. The compensation callback never runs.

This leaves ghost side effects that are never cleaned up in successful workflows. The fix is that compensation must be triggered eagerly at failure time, not only deferred to workflow termination. The public API is unchanged — `.compensate(cb)` is the same builder. Only the engine's trigger logic changes.

---

## Part 1: Search Query Refactoring

### Goal

The existing `src/types/search-query.ts` implements a typed query AST parameterized over two hardcoded namespaces: `engine` (workflow-specific DB fields) and `meta` (user-supplied metadata predicates). This hardcoding is the only thing preventing the same machinery from being reused for topic metadata filters, dead-letter payload filters, dead-letter record field filters, and any future query surfaces.

### Task

Generalize `WorkflowSearchQueryBuilder` and `WorkflowSearchQueryNode` into namespace-parameterized types. The generalized forms take a `TNamespaces` map where each key is a namespace name and each value is the record type of fields in that namespace:

```typescript
// Generalized types (new)
type SearchQueryNode<TNamespaces extends Record<string, SearchMetadataRecord>>
type SearchQuery<TNamespaces extends Record<string, SearchMetadataRecord>>

// Existing types become instantiations (updated, not removed)
type WorkflowSearchQueryNode<TMeta extends SearchMetadataRecord> =
  SearchQueryNode<{ engine: WorkflowSearchEngineFields; meta: TMeta }>

type WorkflowSearchQueryBuilder<TMeta extends SearchMetadataRecord> =
  SearchQuery<{ engine: WorkflowSearchEngineFields; meta: TMeta }>
```

The `SearchQuery<TNamespaces>` builder exposes one sub-builder per namespace key, each using the existing predicate machinery (`eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`, `containsAny`, `containsAll`) typed to that namespace's field record. The `and`, `or`, `not` combinators are top-level on the builder as before.

The existing `WorkflowSearchQueryNode` and `WorkflowSearchQueryBuilder` are kept as aliases so no existing call sites break.

### Usage

**Topics** — filter is over the topic's `metadata` schema:

```typescript
// registerTopicConsumer filter type:
SearchQuery<{ metadata: TMetadata }>

// example:
filter: (q) => q.metadata.type.eq("booking.confirmed")
```

When a topic definition has no `metadata` schema, `TMetadata` resolves to `Record<string, never>` and TypeScript omits the `filter` property from the consumer options type entirely.

**Dead-letter API** — filter spans both the message payload and dead-letter record fields:

```typescript
// DeadLetterHandle filter type:
SearchQuery<{ payload: TMessage; record: DeadLetterRecordFields }>

// DeadLetterRecordFields:
interface DeadLetterRecordFields {
  createdAt: Date;
  deadLetteredAt: Date;
  reason: "max_attempts" | "ttl_expired";
  attemptCount: number;
}

// example:
filter: (q) => q.and(
  q.record.reason.eq("max_attempts"),
  q.record.createdAt.gte(new Date("2026-01-01")),
  q.payload.userId.eq("u1"),
)
```

This allows dead-letter queries to span both the message content and the record-level fields in a single typed expression.

---

## Part 2: Queues

### Purpose

A global competing-consumer work queue. Any workflow can publish a typed message to a named queue. Any registered worker (in any process) can consume from it. Messages are processed exactly once via `SELECT FOR UPDATE SKIP LOCKED`. `ORDER BY id ASC` with `SKIP LOCKED` produces insertion-order processing under no contention, but this is not guaranteed under concurrent workers and should not be relied upon. The name "queue" communicates "messages wait for a consumer," not "messages are processed in strict insertion order."

### Definition

Add `defineQueue` to the public exports:

```typescript
const notificationsQueue = defineQueue({
  name: "notifications",                              // globally unique, stable string
  message: z.object({ userId: z.string(), body: z.string() }),
  defaultTTL: 3600,                                   // optional; seconds before unclaimed message expires
  retention: {                                        // RetentionSetter<"processed" | "deadLettered">
    processed: 86400,                                 // seconds; null = never delete
    deadLettered: 86400 * 30,                         // seconds; null = never delete
  },
});
```

- `name` — the queue's DB namespace. Must be globally unique across all `defineQueue` calls registered with an engine instance.
- `message` — Zod schema for the payload. Input type used for publishing (encoded to JSONB); output type delivered to handler (decoded).
- `defaultTTL` — optional. Seconds after publish time before an unclaimed message is swept to `status = 'dead_lettered'` with `dead_letter_reason = 'ttl_expired'`. If absent, TypeScript **requires** an explicit `ttl` on every `publish` call (see TTL semantics below).
- `retention.processed` — how long rows with `status = 'processed'` are retained before the sweeper deletes them. `null` means never delete. Uses `RetentionSetter<"processed" | "deadLettered">`.
- `retention.deadLettered` — how long rows with `status = 'dead_lettered'` are retained before the sweeper deletes them. `null` means never delete.

### TTL semantics

`ttl` controls how long a message may remain unclaimed before it is swept to `status = 'dead_lettered'` with `dead_letter_reason = 'ttl_expired'`.

- `ttl: number` — the message expires N seconds from publish time.
- `ttl: null` — the message never expires, regardless of `defaultTTL`.

**TypeScript enforcement:** When `defaultTTL` is not specified on the definition, `ttl` is a required field on every `publish` call (`ttl: number | null`). When `defaultTTL` is specified, `ttl` is an optional override (`ttl?: number | null`).

### Scheduling semantics

`delay` and `scheduledAt` control when a message becomes eligible for consumption. Before that point, the message exists in the table with `status = 'pending'` but is invisible to consumer claim queries.

- `delay: number` — the message becomes eligible N **seconds** from publish time. Stored as `scheduled_at = NOW() + interval 'N seconds'`.
- `scheduledAt: Date` — the message becomes eligible at the given absolute timestamp.

Both are optional. If neither is provided, the message is eligible immediately (`scheduled_at = NULL`).

**Interaction with `ttl`:** `expires_at` is always computed from publish time, not from `scheduled_at`. If `delay >= ttl` (or `scheduledAt >= expires_at`), the message would expire before it ever becomes eligible. The engine validates this at publish time and raises an error.

**Ordering:** Once eligible (`scheduled_at <= NOW()`), a message joins the normal pending pool. The claim query orders by `COALESCE(scheduled_at, created_at) ASC, id ASC` — a scheduled message that fires late takes its natural position relative to other eligible messages based on its intended eligible time, not its creation time.

### Workflow-internal API

Add `queues` to `WorkflowContext`, `CompensationContext`, and their concurrency variants.

```typescript
// When defaultTTL is set on the definition — ttl is an optional override
await ctx.queues.notifications.publish({ userId: "u1", body: "Hello" });
await ctx.queues.notifications.publish({ userId: "u1", body: "Urgent" }, { ttl: 300 });
await ctx.queues.notifications.publish({ userId: "u1", body: "Permanent" }, { ttl: null });

// When defaultTTL is NOT set on the definition — ttl is required
await ctx.queues.ephemeralQueue.publish({ ... }, { ttl: 60 });
await ctx.queues.ephemeralQueue.publish({ ... }, { ttl: null }); // never expires; satisfies the requirement

// Scheduled delivery — eligible after a delay
await ctx.queues.notifications.publish({ userId: "u1", body: "Reminder" }, { delay: 3600 });       // 1 hour from now
await ctx.queues.notifications.publish({ userId: "u1", body: "Scheduled" }, {
  scheduledAt: new Date("2027-01-01T09:00:00Z"),                                                   // specific time
});

// Combined — schedule + explicit TTL
await ctx.queues.notifications.publish({ userId: "u1", body: "Time-sensitive" }, {
  delay: 300,    // eligible in 5 minutes
  ttl: 600,      // expires 10 minutes from now (must be > delay)
});
```

- Tier 3 — `DirectAwaitable<void>`
- Workflow can only publish to queues, never read from them.
- Available in both `WorkflowContext` and `CompensationContext` — publishing during compensation is a valid pattern (e.g. audit notification on rollback).
- Publish is durable: the message insert is colocated in the same transaction as the workflow's checkpoint record. On replay, the engine detects the existing checkpoint and skips the re-insert, giving exactly-once publish semantics.

Add `queues` to `defineWorkflow` definition:

```typescript
defineWorkflow({
  queues: { notifications: notificationsQueue },
  // ...
});
```

The queue definitions in the workflow declare which queues the workflow interacts with. They do not register handlers — that is a separate client concern.

### Client registration API

Add `registerQueueHandler` to the client class:

```typescript
const unregister = client.registerQueueHandler(
  notificationsQueue,
  async (message) => {
    // message is z.output<typeof notificationsQueue.message>
    await sendEmail(message.userId, message.body);
  },
  {
    timeout: 30,                               // seconds, per-attempt handler timeout
    retryPolicy: {
      maxAttempts: 5,                          // dead-letter after N failures
      intervalMs: 2000,
      backoffRate: 2,
      maxIntervalMs: 60_000,
    },
  },
);

unregister(); // deregisters and stops consuming
```

- Each worker process registers one handler per queue definition. Multiple worker processes each registering a handler for the same queue compete for pending messages — this is the standard horizontal scaling model, the same as RabbitMQ competing consumers or HTTP servers behind a load balancer.
- `maxAttempts` is meaningful for queues: after exhaustion, the message is moved to `status = 'dead_lettered'` with `dead_letter_reason = 'max_attempts'`.
- If no handler is registered for a queue, messages remain pending until a handler is registered or their TTL expires.

### Dead-letter client API

Dead-lettered messages are rows with `status = 'dead_lettered'` in `queue_messages`. They are accessible via `client.deadLetters(def)` which returns a `DeadLetterHandle<TMessage>`.

**`DeadLetteredMessage<T>`:**

```typescript
type DeadLetteredMessage<T> = {
  id: string;
  payload: T;                           // z.output<typeof queue.message>
  reason: "max_attempts" | "ttl_expired";
  deadLetteredAt: Date;
  createdAt: Date;
  originalExpiresAt: Date | null;       // the expires_at value set at publish time, if any
  attempts: AttemptAccessor;            // lazy proxy; no DB query until a method is called
};
```

`attempts` is an `AttemptAccessor` (see Part 8). It provides access to per-attempt error records stored in `queue_message_attempt`. The accessor is a pure lazy proxy — constructing `DeadLetteredMessage` issues no DB queries for attempt history. All queries are deferred until a method on the accessor is called.

**`DeadLetterSort<TMessage>`:**

A sort descriptor consistent with the filter namespace structure. Sorted pages are required for the cursor to be meaningful:

```typescript
type DeadLetterSort<TMessage> =
  | { namespace: "record"; path: keyof DeadLetterRecordFields; direction: "asc" | "desc" }
  | { namespace: "payload"; path: string; direction: "asc" | "desc" };
```

**`DeadLetterCursor<TMessage>`:**

A branded string that encodes the current page position. Branded to the queue's message type so that a cursor from one queue definition cannot accidentally be used with another:

```typescript
declare const deadLetterCursorBrand: unique symbol;
type DeadLetterCursor<TMessage> = string & { readonly [deadLetterCursorBrand]: TMessage };
```

**`DeadLetterHandle<TMessage>`:**

```typescript
type Unsubscribe = () => void;

interface DeadLetterHandle<TMessage extends SearchMetadataRecord> {
  list(opts?: {
    limit?: number;
    cursor?: DeadLetterCursor<TMessage>;
    sort?: ReadonlyArray<DeadLetterSort<TMessage>>;
    filter?: (q: SearchQuery<{ payload: TMessage; record: DeadLetterRecordFields }>) => SearchQueryNode;
  }): Promise<{ messages: DeadLetteredMessage<TMessage>[]; nextCursor?: DeadLetterCursor<TMessage> }>;

  count(opts?: {
    filter?: (q: SearchQuery<{ payload: TMessage; record: DeadLetterRecordFields }>) => SearchQueryNode;
  }): Promise<number>;

  redrive(opts: {
    ids: string[];
    ttl?: number | null;
  }): Promise<void>;

  redriveAll(opts?: {
    filter?: (q: SearchQuery<{ payload: TMessage; record: DeadLetterRecordFields }>) => SearchQueryNode;
    ttl?: number | null;
  }): Promise<void>;

  discard(opts: { ids: string[] }): Promise<void>;

  discardAll(opts?: {
    filter?: (q: SearchQuery<{ payload: TMessage; record: DeadLetterRecordFields }>) => SearchQueryNode;
  }): Promise<void>;

  listen(
    handler: (message: DeadLetteredMessage<TMessage>) => void | Promise<void>,
    opts?: {
      filter?: (q: SearchQuery<{ payload: TMessage; record: DeadLetterRecordFields }>) => SearchQueryNode;
    },
  ): Unsubscribe;
}
```

**`redrive` / `redriveAll` TTL behavior:** On redrive, `status` resets to `'pending'` and `attempt_count` resets to zero. For `expires_at`: if `ttl` is provided, `expires_at = NOW() + ttl`; if `ttl: null`, `expires_at = NULL` (never expires); if `ttl` is omitted, the queue's `defaultTTL` is re-applied from now. This ensures a previously `ttl_expired` message is not immediately re-expired on redrive.

**`filter` on dead-letter operations:** The `filter` callback receives a `SearchQuery` builder with two namespaces: `payload` (typed to the queue's message schema) and `record` (the dead-letter record fields: `createdAt`, `deadLetteredAt`, `reason`, `attemptCount`). Predicates in a single filter expression can span both namespaces freely.

**`list` pagination:** `sort` must be provided for cursor-based pagination to be meaningful — the cursor encodes position within the chosen sort order. When `sort` is omitted, results are ordered by `record.id` ascending by default.

**`listen`:** Backed by `LISTEN/NOTIFY`. When a message row transitions to `status = 'dead_lettered'`, the engine performs a `SELECT` for new records since the last seen position, applies the `filter` at the DB level, and delivers matching messages to the handler callback one at a time. The callback may be async. Cancellation is via the returned `Unsubscribe` function — calling it stops delivery and tears down the underlying connection. `listen` itself is synchronous and registers intent immediately; the underlying `LISTEN` command is established asynchronously in the background.

**Usage:**

```typescript
const dl = client.deadLetters(notificationsQueue);

// Inspect — filter spans payload fields and record fields
const { messages, nextCursor } = await dl.list({
  sort: [{ namespace: "record", path: "deadLetteredAt", direction: "desc" }],
  filter: (q) => q.and(
    q.record.reason.eq("max_attempts"),
    q.record.createdAt.gte(new Date("2026-01-01")),
    q.payload.userId.eq("u1"),
  ),
});

// Per-message attempt history — all lazy, no query until called
const accessor = messages[0].attempts;
const all = await accessor.all();
const last = await accessor.last();
const n = await accessor.count();
for await (const err of accessor) { ... }          // oldest first
for await (const err of accessor.reverse()) { ... } // newest first

// React to new dead-letters in real time
const unsubscribe = dl.listen(
  async (msg) => {
    await dl.redrive({ ids: [msg.id], ttl: 3600 });
  },
  {
    filter: (q) => q.record.reason.eq("max_attempts"),
  },
);
// later:
unsubscribe();

// Bulk redrive / discard
await dl.redriveAll({ filter: (q) => q.record.reason.eq("max_attempts"), ttl: 3600 });
await dl.redrive({ ids: ["123"], ttl: null });      // never-expire on redrive
await dl.discardAll({ filter: (q) => q.record.reason.eq("ttl_expired") });
```

### Postgres implementation

**`queue_messages` table:**

```sql
CREATE TABLE queue_messages (
  id                                BIGSERIAL PRIMARY KEY,
  queue_name                        TEXT NOT NULL,
  payload                           JSONB NOT NULL,
  status                            TEXT NOT NULL DEFAULT 'pending',
  attempt_count                     INT NOT NULL DEFAULT 0,
  dead_letter_reason                TEXT,
  scheduled_at                      TIMESTAMPTZ,
  expires_at                        TIMESTAMPTZ,
  claimed_at                        TIMESTAMPTZ,
  dead_lettered_at                  TIMESTAMPTZ,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_retention_deadline_at   TIMESTAMPTZ,
  dead_letter_retention_deadline_at TIMESTAMPTZ,

  CONSTRAINT chk_status CHECK (
    status IN ('pending', 'claimed', 'processed', 'dead_lettered')
  ),
  CONSTRAINT chk_dead_letter_reason CHECK (
    dead_letter_reason IS NULL OR dead_letter_reason IN ('max_attempts', 'ttl_expired')
  ),
  CONSTRAINT chk_schedule_before_expiry CHECK (
    scheduled_at IS NULL OR expires_at IS NULL OR scheduled_at < expires_at
  )
);
```

**`queue_message_attempt` table:**

```sql
CREATE TABLE queue_message_attempt (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES queue_messages(id) ON DELETE CASCADE,
  attempt     INT NOT NULL,
  error       TEXT NOT NULL,
  error_type  TEXT,
  details     JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at   TIMESTAMPTZ NOT NULL
);
```

`ON DELETE CASCADE` ensures attempt rows are automatically removed when the message row is deleted by the sweeper. No separate cleanup step is required.

**Consumer claim query:**

```sql
SELECT * FROM queue_messages
WHERE queue_name = $1
  AND status = 'pending'
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (scheduled_at IS NULL OR scheduled_at <= NOW())
ORDER BY COALESCE(scheduled_at, created_at) ASC, id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

**On handler success:** set `status = 'processed'`, set `processed_retention_deadline_at = NOW() + processed_retention_duration`.

**On handler failure:** insert a row into `queue_message_attempt`, increment `attempt_count`, release lock. If `attempt_count >= maxAttempts`: set `status = 'dead_lettered'`, `dead_letter_reason = 'max_attempts'`, `dead_lettered_at = NOW()`, `dead_letter_retention_deadline_at = NOW() + dead_letter_retention_duration`.

**Sweeper:** Runs on a configurable interval following the same pattern as workflow GC (`gcIntervalSeconds`). Performs three sweeps:

```sql
-- TTL expiry — only fires on messages that have become eligible (scheduled_at passed or unset)
UPDATE queue_messages
SET status = 'dead_lettered',
    dead_letter_reason = 'ttl_expired',
    dead_lettered_at = NOW(),
    dead_letter_retention_deadline_at = NOW() + $dead_letter_retention_duration
WHERE status = 'pending'
  AND expires_at IS NOT NULL
  AND expires_at < NOW()
  AND (scheduled_at IS NULL OR scheduled_at <= NOW());

-- Processed retention cleanup
DELETE FROM queue_messages
WHERE status = 'processed'
  AND processed_retention_deadline_at < NOW();

-- Dead-letter retention cleanup
DELETE FROM queue_messages
WHERE status = 'dead_lettered'
  AND dead_letter_retention_deadline_at < NOW();
```

---

## Part 3: Requests

### Purpose

A global typed request-response primitive. A workflow posts a typed request and blocks until a registered handler (in any process, potentially human-mediated) returns a typed response. The workflow does not know and does not need to know who or what handles the request. This is the primary primitive for the "agent asking for help from whoever can help" pattern.

This is distinct from:
- **Steps**: the workflow owns the implementation. Requests delegate to an external handler.
- **Channels**: the workflow receives inbound messages from known senders. Requests post outbound tasks and await a response.
- **Child workflows**: heavyweight, lifecycle-managed, require knowing the implementation. Requests are lightweight and implementation-agnostic.

### Definition

```typescript
const humanReview = defineRequest({
  name: "humanReview",
  request: z.object({ context: z.string(), data: z.unknown() }),
  response: z.object({ decision: z.enum(["approve", "reject"]), note: z.string() }),
  retention: {                                        // RetentionSetter<"resolved" | "timedOut" | "cancelled">
    resolved:   86400,                                // seconds; null = never delete
    timedOut:   86400 * 7,
    cancelled:  3600,
  },
});
```

### Workflow-internal API

Requests are **Tier 1** — they must be resolved via `.resolve(ctx)`. However, they are **not** `StepCall` instances. `StepCall` exposes `.failure()`, `.retry()`, and `.complete()` — none of which apply to requests. Requests have their own parallel call types that extend `DeterministicAwaitable` directly with a request-specific builder chain.

The concrete call type depends on whether `timeout` is specified in the options:

```typescript
// Parallel to StepCall — new types, not StepCall variants
interface UntimedRequestCall<TResponse, TFinal = TResponse, HasCompensation extends boolean = false, Tctx = unknown>
  extends DeterministicAwaitable<TFinal, ExecutionRoot> {
  compensate(
    cb: (ctx: Tctx, result: RequestCompensationResult<TResponse>) => Promise<void>
  ): UntimedRequestCall<TResponse, TFinal, true, Tctx>;
  complete<R>(
    cb: (data: TResponse) => R
  ): UntimedRequestCall<TResponse, Awaited<R>, HasCompensation, Tctx>;
}

interface TimedRequestCall<TResponse, TTimeout = never, TFinal = TResponse, HasCompensation extends boolean = false, Tctx = unknown>
  extends DeterministicAwaitable<TFinal | TTimeout, ExecutionRoot> {
  compensate(
    cb: (ctx: Tctx, result: RequestCompensationResult<TResponse>) => Promise<void>
  ): TimedRequestCall<TResponse, TTimeout, TFinal, true, Tctx>;
  timeout<R>(cb: () => R): TimedRequestCall<TResponse, Awaited<R>, TFinal, HasCompensation, Tctx>;
  complete<R>(
    cb: (data: TResponse) => R
  ): TimedRequestCall<TResponse, TTimeout, Awaited<R>, HasCompensation, Tctx>;
}
```

Both types are proper Tier 1: they carry the `ExecutionRoot` brand and require `.resolve(ctx)`. Neither has `.failure()` or `.retry()`. `.complete()` transforms the response before it propagates into the calling workflow — analogous to `.complete()` on `StepCall`, but applied only on the success path (not the timeout path).

`timeout` is a **required** option. Passing `null` means the request waits indefinitely and returns `UntimedRequestCall`; passing a number returns `TimedRequestCall`.

The return type of `ctx.requests.X(payload, { timeout: null })` is `UntimedRequestCall`; `ctx.requests.X(payload, { timeout: N })` returns `TimedRequestCall`.

**Without timeout — `UntimedRequestCall<TResponse>`**

Available builders: `.compensate()` and `.complete()`. The request waits indefinitely. There is no `.timeout()` on the type.

```typescript
const result = await ctx.requests
  .humanReview({ context: "...", data: signals }, { timeout: null })
  .compensate(async (ctx, result) => {
    // result: RequestCompensationResult<TResponse>
    if (result.status === "complete") {
      await ctx.requests.revokeDecision({ context: "..." }, { timeout: null }).resolve(ctx);
    } else {
      // result.status === "attempted"
      await ctx.requests.cancelPendingReview({ context: "..." }, { timeout: null }).resolve(ctx);
    }
  })
  .resolve(ctx);
// result: TResponse — always, waits indefinitely
```

**With timeout — `TimedRequestCall<TResponse>`**

Available builders: `.compensate()`, `.timeout()`, and `.complete()`. `.timeout()` builder is present ONLY when `timeout` is specified in the options. If `.timeout()` is not chained despite a timeout being specified, and the timeout fires, the workflow auto-terminates (consistent with unchained `.failure()` on steps).

```typescript
const result = await ctx.requests
  .humanReview(
    { context: "...", data: signals },
    { timeout: 300 },
  )
  .compensate(async (ctx, result) => { /* same as above */ })
  .timeout(() => null)               // fires if 300s pass with no response
  .complete((r) => r.decision)       // transform the success result
  .resolve(ctx);
// result: "approve" | "reject" | null
```

- The `timeout` option is **required** (`number | null`). `null` means wait indefinitely; a number sets the deadline in seconds. This is the ONLY execution parameter the caller controls. Retry behavior is entirely the handler's concern.
- `.timeout(cb)` receives no arguments — there is no "failure reason" to communicate. Timeout is the only non-success outcome.
- `.complete(cb)` transforms only the response value; the timeout path value is unaffected.
- Each worker process registers one handler per request definition. Multiple worker processes each registering a handler for the same definition compete — any process can fulfill the request. If different fulfillment paths are needed (e.g. automated vs. human), use separate request definitions.

**Available in `CompensationContext`** — requests during compensation are valid (e.g. post a "cancel this review" task). A request posted in `CompensationContext` cannot itself register a compensation (no `.compensate()` builder on `CompensationContext`) — the nesting stops.

Add `requests` to `defineWorkflow` definition:

```typescript
defineWorkflow({
  requests: { humanReview },
  // ...
});
```

### Compensation semantics

The compensation callback signature:

```typescript
.compensate(async (ctx, result: RequestCompensationResult<TResponse>) => { ... })
```

`RequestCompensationResult<TResponse>`:

```typescript
type RequestCompensationResult<TResponse> =
  | { status: "complete"; data: TResponse }  // a result was produced and delivered to the workflow
  | { status: "attempted" }                  // a handler claimed the request but no response arrived
```

**Trigger rules (engine-level, not public API):**

| Scenario | Compensation triggered? | When | result.status |
|---|---|---|---|
| Resolved (any source) + workflow succeeds | No | — | — |
| Resolved (any source) + workflow fails/terminates | Yes | LIFO unwind | `"complete"` |
| Timeout + request was ever claimed | Yes | Eagerly at timeout time | `"attempted"` |
| Timeout + never claimed + never resolved | No | — | Row deleted |
| Admin-direct-resolve within timeout window | As "resolved" case | — | — |
| Admin-direct-resolve after timeout already fired | No (already settled) | — | — |

"Resolved" means any party (handler or admin panel direct-set) delivered a response to the workflow before the timeout fired.

Note: a request can be resolved without any handler attempts — an admin can directly set the result. This counts as "resolved" for compensation purposes. The `{ status: "complete", data }` path in the compensation callback handles it identically to a handler-resolved request.

### Retry policy at handler registration

The workflow caller does NOT control retry behavior. The caller controls only: payload and timeout (overall deadline). Retry policy is entirely the handler's concern.

For requests, `maxAttempts` is intentionally absent from the handler retry policy. A handler failure releases the lock and makes the request row eligible for any other matching worker to pick up. The request does not "die" after N handler failures — it waits for the next eligible worker within the caller's timeout window. Capping attempts at the handler level would be semantically incorrect for requests (unlike queues, where messages should eventually dead-letter).

### Client registration API

```typescript
const unregister = client.registerRequestHandler(
  humanReview,
  async (request) => {
    // request is z.output<typeof humanReview.request>
    const decision = await routeToHumanUI(request);
    return { decision, note: "reviewed by operator" };
    // return value must match z.input<typeof humanReview.response>
  },
  {
    timeout: 60,                           // seconds, per-attempt handler execution timeout
    retryPolicy: {
      // No maxAttempts — failed attempts re-queue the request row
      intervalMs: 5000,
      backoffRate: 2,
      maxIntervalMs: 120_000,
    },
  },
);

unregister();
```

### Postgres implementation

**`requests` table:**

```sql
CREATE TABLE requests (
  id                      BIGSERIAL PRIMARY KEY,
  request_name            TEXT NOT NULL,
  payload                 JSONB NOT NULL,
  response                JSONB,
  status                  TEXT NOT NULL DEFAULT 'pending',
  claimed_at              TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  timed_out_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_deadline_at   TIMESTAMPTZ,

  CONSTRAINT chk_status CHECK (
    status IN ('pending', 'claimed', 'resolved', 'timedOut', 'cancelled')
  )
);
```

**`request_attempt` table:**

```sql
CREATE TABLE request_attempt (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  attempt     INT NOT NULL,
  error       TEXT NOT NULL,
  error_type  TEXT,
  details     JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at   TIMESTAMPTZ NOT NULL
);
```

`ON DELETE CASCADE` ensures attempt rows are removed when the request row is swept.

**Compensation trigger:** `EXISTS (SELECT 1 FROM request_attempt WHERE request_id = $id)`. If no attempt rows exist, the request was never claimed or only failed input validation — no side effect can have occurred, so compensation is skipped.

**Args-validation failure behaviour:** If a worker determines the request payload fails input validation before entering user code, it does NOT write a `request_attempt` row. It releases the lock and records the request ID in local process memory as non-retryable for this process. Other workers may still claim and succeed. On worker restart (e.g. after a code update that fixes the schema), the in-memory record is gone and the worker will attempt again.

**On handler success:** set `response`, `status = 'resolved'`, `resolved_at = NOW()`, `retention_deadline_at = NOW() + retention.resolved`, notify the waiting workflow via the resolved `workflow_promise`.

**On handler failure:** insert a `request_attempt` row, release lock. The row returns to `status = 'pending'` and is re-eligible after backoff.

**On workflow timeout:** set `status = 'timedOut'`, `timed_out_at = NOW()`, `retention_deadline_at = NOW() + retention.timedOut`. Check `EXISTS (SELECT 1 FROM request_attempt ...)` to decide whether to trigger compensation.

**On SIGKILL / cancellation:** set `status = 'cancelled'`, `cancelled_at = NOW()`, `retention_deadline_at = NOW() + retention.cancelled`. Same compensation check.

**Admin direct-set:** update `response`, set `status = 'resolved'`, `resolved_at = NOW()`, notify workflow — same path as handler success.

**Sweeper:**

```sql
DELETE FROM requests
WHERE retention_deadline_at IS NOT NULL
  AND retention_deadline_at < NOW();
```

Attempt rows cascade-delete automatically.

---

## Part 4: Topics

### Purpose

A global ordered append log per topic, with named independent consumers and optional metadata filtering. Multiple workflows can publish to the same topic. Multiple named consumers independently track their own read position (offset). This is the primitive for cross-workflow audit trails, event sourcing, and triggering downstream systems.

This is distinct from workflow-instance `streams`: streams are per-instance output logs. Topics are global, multi-producer, and have persistent consumer offset tracking.

### Definition

```typescript
const auditTopic = defineTopic({
  name: "auditEvents",
  record: z.object({ type: z.string(), payload: z.unknown() }),
  metadata: z.object({ tenantId: z.string(), type: z.string() }), // optional but typical
});
```

### Workflow-internal API

```typescript
// Tier 3 — DirectAwaitable<void>
await ctx.topics.auditEvents.publish(
  { type: "booking.confirmed", payload: { orderId: "o1" } },
  { metadata: { tenantId: "acme", type: "booking.confirmed" } },
);
```

- Workflows can only publish to topics, never consume from them.
- Available in both `WorkflowContext` and `CompensationContext`.

Add `topics` to `defineWorkflow`:

```typescript
defineWorkflow({
  topics: { auditEvents: auditTopic },
  // ...
});
```

### Client registration API

Named consumers track independent offsets. Consumer identity is enforced via a session-level Postgres advisory lock (described below).

```typescript
// Error types for topic consumer registration
type TopicConsumerAlreadyActiveError = {
  type: "consumer_already_active";
  consumerName: string;
  topicName: string;
};

type RegisterTopicConsumerError = TopicConsumerAlreadyActiveError;  // union — extendable

// Registration options
interface RegisterTopicConsumerOpts {
  filter?: (q: SearchQuery<{ metadata: TopicMetadata }>) => SearchQueryNode;
  timeout?: number;
  retryPolicy?: {
    intervalMs: number;
    backoffRate?: number;
    maxIntervalMs?: number;
  };
  // Controls how the engine retries advisory lock acquisition if another process already holds it.
  // Each failed attempt fires onError. When maxAttempts is exhausted the subscription goes
  // permanently inactive — call unregister() to clean up.
  registrationRetry?: {
    intervalMs: number;
    backoffRate?: number;
    maxIntervalMs?: number;
    maxAttempts?: number;       // omit for indefinite retrying
  };
  onError?: (error: RegisterTopicConsumerError) => void;
}

const unregister = client.registerTopicConsumer(
  auditTopic,
  "analyticsConsumer",   // stable consumer name — globally unique per topic
  async (record) => {
    // record is z.output<typeof auditTopic.record>
    await ingestToWarehouse(record);
  },
  {
    filter: (q) => q.metadata.type.eq("booking.confirmed"),
    timeout: 10,
    retryPolicy: {
      intervalMs: 1000,
      backoffRate: 2,
      maxIntervalMs: 30_000,
    },
    registrationRetry: {
      intervalMs: 5000,
      backoffRate: 1.5,
      maxIntervalMs: 60_000,
      // maxAttempts omitted — retries indefinitely until the lock is acquired
    },
    onError: (error) => {
      // error is RegisterTopicConsumerError — currently only TopicConsumerAlreadyActiveError
      logger.warn("Topic consumer lock conflict", error);
      // fires on every failed lock attempt; call unregister() to stop retrying
    },
  },
);

unregister(); // stops consuming and cancels any pending registration retries
```

- Multiple `registerTopicConsumer` calls for the same topic with different consumer names are fully independent. Each has its own offset. Overlapping filters between named consumers are intentional — each consumer processes matching records independently.
- Multiple `registerTopicConsumer` calls for the same topic with the SAME consumer name, from different processes, are prevented by the advisory lock. Only one active instance per named consumer is permitted at a time. Lock acquisition failures are surfaced to the `onError` callback and retried according to `registrationRetry`.

### Consumer identity and exclusive locking

Implement a `topic_consumers` table:

```sql
CREATE TABLE topic_consumers (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  topic_name TEXT NOT NULL,
  UNIQUE (topic_name, name)
);
```

On `registerTopicConsumer`:
1. Upsert a row for `(topic_name, consumer_name)` to get the consumer's `id`.
2. Attempt to acquire a **session-level** advisory lock unique to this (topic, consumer) pair. This lock is held for the lifetime of the connection. If the process dies, the connection closes, the lock releases, and another process can take over.
3. If the lock cannot be acquired (another process holds it), a `TopicConsumerAlreadyActiveError` is emitted to the `onError` callback and the acquisition is retried according to `registrationRetry`. The call itself returns the `Unsubscribe` function immediately — lock acquisition proceeds asynchronously in the background.

Consumer offsets are stored in a `topic_consumer_offsets` table:

```sql
CREATE TABLE topic_consumer_offsets (
  consumer_id BIGINT REFERENCES topic_consumers(id),
  last_id     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (consumer_id)
);
```

### Insert ordering guarantee

Topic records must be visible to consumers in insertion order. Plain `BIGSERIAL` allocation under concurrent inserts creates a visibility hazard: a transaction can allocate an ID early but commit late, causing a consumer to advance its cursor past a not-yet-committed record and miss it permanently when it later commits.

A per-topic transaction-scoped advisory lock eliminates this hazard by serializing commits for the same topic. Because transaction B for topic X cannot commit until transaction A for topic X has committed, a consumer querying `WHERE id > $last_id` will always see A before B.

For every topic insert:
1. `BEGIN`
2. Acquire a transaction-scoped advisory lock keyed to the topic name — blocks any concurrent insert for the same topic until this transaction commits
3. `INSERT INTO topic_records (topic_name, payload, metadata) VALUES ($1, $2, $3)`
4. `COMMIT` — lock released automatically

Inserts across different topics are fully concurrent. The lock is for visibility ordering only — the `BIGSERIAL id` values may have gaps (from other topics or rolled-back transactions) and that is expected and correct.

### Postgres implementation

```sql
CREATE TABLE topic_records (
  id          BIGSERIAL PRIMARY KEY,
  topic_name  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON topic_records (topic_name, id);
```

Consumer polling:
```sql
SELECT * FROM topic_records
WHERE topic_name = $1
  AND id > $last_id
  AND ($filter IS NULL OR metadata @> $filter)
ORDER BY id ASC
LIMIT $batch_size;
```

Update position after processing:
```sql
UPDATE topic_consumer_offsets SET last_id = $new_id WHERE consumer_id = $id;
```

Cleanup: a background coroutine (configurable interval, default hourly) deletes records where all registered consumers for the topic have advanced past the record's `id`, and the record is older than the configured retention window.

---

## Part 5: Attributes

### Purpose

An observable single current value on a workflow instance. Externally readable, workflow-writable. Distinct from:
- **Streams**: append-only with full history. Attributes retain only the latest value. Use when current state is needed without history overhead.
- **Events**: write-once flags with no value. Attributes are multi-settable with a typed value.
- **Channels**: inbound to the workflow. Attributes are outbound observable state.

### Workflow definition

```typescript
defineWorkflow({
  attributes: {
    progress: z.object({ percent: z.number(), phase: z.string() }),
    status: z.enum(["idle", "running", "done"]),
  },
  // ...
});
```

Attributes appear in `PublicWorkflowHeader` so external clients are correctly typed.

### Workflow-internal API

```typescript
// Tier 3 — DirectAwaitable<void>
await ctx.attributes.progress.set({ percent: 0.75, phase: "finalizing" });
```

- Available in both `WorkflowContext` and `CompensationContext`.
- Workflows can only set attributes, never read them back.

### External handle API

Add `attributes` to `WorkflowHandleExternal`.

**Blocking get:**

```typescript
get(options?: { afterVersion?: number; signal?: AbortSignal }): Promise<
  | { status: "ok"; value: T; version: number }
  | { status: "never" }  // workflow ended without setting the attribute (or advancing past afterVersion)
>
```

- Without `afterVersion`: blocks until a value is set for the first time (or returns immediately if already set).
- With `afterVersion`: blocks until `version > afterVersion`. May skip intermediate values — only the newest value at the time of unblocking is returned.
- `signal` cancels the wait and rejects with `AbortError`.
- `{ status: "never" }` is returned when the workflow terminates without ever setting the attribute (mirroring `event.wait()` returning `{ status: "never" }`). This prevents infinite blocking on dead workflows.

**Non-blocking get:**

```typescript
getNowait(): Promise<{ status: "ok"; value: T; version: number } | { status: "not_set" }>
getNowait(defaultValue: D): Promise<{ status: "ok"; value: T; version: number } | { status: "not_set"; value: D }>
```

Returns immediately with the current value if set, or `{ status: "not_set" }` / default if never set.

**Usage pattern (long-poll change tracking):**

```typescript
let result = await handle.attributes.progress.get({ signal });
if (result.status === "never") return;

while (true) {
  console.log(result.value); // process current value
  const next = await handle.attributes.progress.get({ afterVersion: result.version, signal });
  if (next.status === "never") break;
  result = next;
}
```

### Postgres implementation

```sql
CREATE TABLE workflow_attributes (
  workflow_id    TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  value          JSONB NOT NULL,
  version        BIGINT NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, attribute_name)
);
```

On `ctx.attributes.X.set(value)`: upsert with `version = version + 1`.

For `get(afterVersion)`: long-poll via `LISTEN/NOTIFY`. The engine sends `NOTIFY workflow_attribute_changed, '<workflow_id>:<attribute_name>'` on every set. The waiting client re-queries when notified.

---

## Part 6: Streams Extension

### `readNowait` on external handle

Add a non-blocking read variant to `WorkflowHandleExternal.streams.*`:

```typescript
readNowait(offset: number): Promise<StreamReadResult<T> | { status: "not_found" }>
readNowait(offset: number, defaultValue: D): Promise<StreamReadResult<T> | { status: "not_found"; value: D }>
```

Returns immediately with the entry at `offset` if it exists, or `not_found` / default if it has not been written yet. Mirrors `receiveNowait()` on channels and `getNowait()` on attributes.

This is useful for polling patterns where a consumer wants to speculatively check whether the next expected stream offset is available before deciding to block on `.read(offset, { signal })`.

---

## Part 7: Compensation Model Correction

### Problem

Under the current model, compensation callbacks only run during workflow failure or termination (LIFO unwind). A successfully completing workflow never triggers any compensation.

This is incorrect for steps (and requests) where the operation was ATTEMPTED but FAILED, and the failure was caught with `.failure()` or `.timeout()`. A flaky POST endpoint may process the request on the server side and record the side effect, but fail to send a response and return 500. The step is marked failed. The workflow catches the failure and continues. The workflow completes successfully. The compensation callback — which would call the cancellation endpoint — never runs. The external system has a ghost side effect forever.

### Fix

The engine must trigger compensation **eagerly at failure time** for any operation that was attempted and failed (regardless of whether the failure is caught). This is in addition to the existing deferred LIFO unwind on workflow failure.

**Trigger rules (corrected):**

| Event | Compensation triggered? | Timing |
|---|---|---|
| Step attempted + step failed (caught or not) | Yes | Eagerly, at failure time |
| Step succeeded + workflow fails/terminates | Yes | Deferred, LIFO unwind |
| Step succeeded + workflow succeeds | No | — |
| Request resolved + workflow fails/terminates | Yes | Deferred, LIFO unwind |
| Request timeout + ever claimed | Yes | Eagerly, at timeout time |
| Request timeout + never claimed + never resolved | No | Row deleted |

The compensation callback is idempotent by contract (existing requirement). If a step fails and its compensation runs eagerly, and then the workflow also fails — the LIFO unwind may attempt the same compensation again. Idempotency handles this correctly.

### Public API impact

None. The `.compensate(cb)` builder is unchanged. The callback shape is unchanged. `CompensationContext` is unchanged. This is an engine-level correctness fix. Developers do not need to update any code — they define counter-actions; the engine decides when to invoke them.

---

## Part 8: AttemptAccessor Refactoring

### Summary

This is a breaking rename of an existing type and field. No new runtime behavior is introduced.

### Changes

**Rename `StepErrorAccessor` → `AttemptAccessor`**

`AttemptAccessor` is now the shared interface for lazy access to per-attempt error records, used by both step executions and queue dead-lettered messages. The name `StepErrorAccessor` was over-specific — the `status: "complete"` variant of `StepCompensationResult` also carries the accessor to surface errors from prior failed attempts before the eventual success, making "error accessor" a misleading name in that context.

**`count` property → `count()` async method**

The previous `readonly count: number` implied the count was pre-fetched at accessor construction time, which contradicted the otherwise fully lazy interface. Making it `count(): Promise<number>` is consistent with all other methods on the accessor. Implementations may optimize internally using a cached value from the parent row, but this is invisible to the caller.

**Rename `errors` → `attempts` on `StepCompensationResult`**

`attempts` is accurate in all variants. `errors` was accurate only for the failure cases.

### Updated interface

```typescript
interface AttemptAccessor {
  last(): Promise<StepExecutionError>;
  all(): Promise<StepExecutionError[]>;
  count(): Promise<number>;
  [Symbol.asyncIterator](): AsyncIterableIterator<StepExecutionError>;
  reverse(): AsyncIterable<StepExecutionError>;
}
```

### Updated `StepCompensationResult`

```typescript
type StepCompensationResult<T> =
  | { status: "complete"; data: T; attempts: AttemptAccessor }
  | { status: "failed"; reason: "attempts_exhausted" | "timeout"; attempts: AttemptAccessor }
  | { status: "terminated" }
```

### Implementation notes

- All existing usages of `.errors` on compensation callbacks must be updated to `.attempts`.
- All existing usages of `.errors.count` (sync property access) must be updated to `await .attempts.count()`.
- The `StepErrorAccessor` export is removed. No deprecation alias is required given the absence of a backwards compatibility constraint.

---

## Part 9: Scheduled Delivery

### Purpose

Both queue messages and workflow starts can be deferred to a future point in time. Until the scheduled time is reached, the entity (message or workflow) is created in the database with `status = 'pending'` and is invisible to consumers and the engine's execution dispatcher.

### `ScheduleOptions` type

A type parallel to `DeadlineOptions`, using the same seconds-based convention for the relative form:

```typescript
export type ScheduleOptions =
  | { delaySeconds: number; scheduledAt?: never }
  | { scheduledAt: Date; delaySeconds?: never }
  | { delaySeconds?: undefined; scheduledAt?: undefined };
```

Both collapse to an absolute `scheduled_at TIMESTAMPTZ` stored in the DB. The engine computes `scheduled_at = NOW() + interval 'N seconds'` for `delaySeconds`, or stores `scheduledAt` directly.

### Queue messages

Described in Part 2 (Scheduling semantics). The `publish` opts accept `delay: number` (seconds) or `scheduledAt: Date` as mutually exclusive options. Note the naming difference from `ScheduleOptions`: queue publish uses `delay` (not `delaySeconds`) to match `ttl` — the queue-level opts do not use the `Seconds` suffix convention. Both are stored as seconds in the DB.

### Workflow starts

`ScheduleOptions` is intersected into `StartWorkflowOptions` (client-level `start`/`execute`) and `ChildWorkflowStartOptions` (which covers both `AttachedChildWorkflowStartOptions` and `DetachedStartOptions`):

```typescript
// Updated type definitions (not new types — extend existing ones)
type ChildWorkflowStartOptions<W> = WorkflowInvocationBaseOptions<...> & DeadlineOptions & ScheduleOptions;
type StartWorkflowOptions<...>    = WorkflowInvocationBaseOptions<...> & { retention? } & DeadlineOptions & ScheduleOptions;
```

`CompensationChildWorkflowStartOptions` intentionally does NOT receive `ScheduleOptions` — compensation must proceed promptly and deterministically.

**Client-level:**

```typescript
// Schedule an absolute start time
const handle = await client.workflows.order.start({
  idempotencyKey: "order-jan-2027",
  scheduledAt: new Date("2027-01-10T08:00:00Z"),
  args: { destination: "Paris", customerId: "cust-123" },
});
// handle is immediately valid — execution.wait() will block until the workflow completes

// Relative delay
await client.workflows.reminder.execute({
  idempotencyKey: "reminder-7d",
  delaySeconds: 604800,  // 7 days
  args: { userId: "u1" },
});
```

**Workflow-internal (`startDetached`):**

```typescript
// Fire-and-forget, starts tomorrow
const childHandle = await ctx.childWorkflows.followUp.startDetached({
  idempotencyKey: "follow-up-next-day",
  delaySeconds: 86400,
  args: { parentId: ctx.instanceId },
});
// childHandle is a ForeignWorkflowHandle — channels are usable immediately;
// the child won't begin executing until its scheduled_at is reached
```

**Attached child workflows** support scheduling too. The parent blocks until the child completes; the wait simply starts later:

```typescript
const result = await ctx.childWorkflows.audit
  .call({ idempotencyKey: "audit-eod", delaySeconds: 3600, args: { ... } })
  .resolve(ctx);
```

### Interaction with `deadlineSeconds` / `deadlineUntil`

The deadline clock starts from **creation time**, not from the scheduled start. If `delaySeconds >= deadlineSeconds` (or `scheduledAt >= deadlineAt`), the workflow would time out before it ever starts. The engine validates this at call time and raises an error.

### Postgres implementation

Add `scheduled_at TIMESTAMPTZ` to the `workflows` table. The engine's workflow pickup query gains:

```sql
AND (scheduled_at IS NULL OR scheduled_at <= NOW())
```

No new status is required. The workflow row uses the existing `'pending'` status and simply waits until it becomes eligible.

A DB-level constraint mirrors the queue approach:

```sql
CONSTRAINT chk_schedule_before_deadline CHECK (
  scheduled_at IS NULL OR deadline_at IS NULL OR scheduled_at < deadline_at
)
```

---

## Summary of Public API additions

### `defineWorkflow` additions

```typescript
defineWorkflow({
  queues:     { [name: string]: QueueDefinition<M> },
  requests:   { [name: string]: RequestDefinition<Req, Res> },
  topics:     { [name: string]: TopicDefinition<R, Meta> },
  attributes: { [name: string]: ZodSchema },
});
```

### `WorkflowContext` / `CompensationContext` additions

| Addition | Tier | Notes |
|---|---|---|
| `ctx.queues.X.publish(payload, opts?)` | Tier 3 | Both contexts. `opts.ttl` required when queue has no `defaultTTL`. `opts.delay` / `opts.scheduledAt` for deferred delivery. |
| `ctx.requests.X(payload, opts?)` | Tier 1 | `WorkflowContext` and `CompensationContext`; no `.compensate()` in `CompensationContext` |
| `ctx.topics.X.publish(payload, opts?)` | Tier 3 | Both contexts |
| `ctx.attributes.X.set(value)` | Tier 3 | Both contexts |

### `WorkflowHandleExternal` additions

| Addition | Notes |
|---|---|
| `handle.attributes.X.get(opts?)` | Blocking; `{ afterVersion?, signal? }` |
| `handle.attributes.X.getNowait(default?)` | Non-blocking |
| `handle.streams.X.readNowait(offset, default?)` | Non-blocking |

### New client registration methods

All subscription methods are **synchronous**. They register intent in the current process and return an `Unsubscribe` callback immediately. The underlying engine work (polling, lock acquisition, `LISTEN/NOTIFY` setup) proceeds asynchronously in the background.

| Method | Returns |
|---|---|
| `client.registerQueueHandler(def, handler, opts?)` | `Unsubscribe` |
| `client.registerRequestHandler(def, handler, opts?)` | `Unsubscribe` |
| `client.registerTopicConsumer(def, consumerName, handler, opts?)` | `Unsubscribe` |

`Unsubscribe = () => void`. Calling it stops delivery, cancels pending registration retries, and tears down any underlying subscriptions.

### New client management methods

| Method | Returns | Notes |
|---|---|---|
| `client.deadLetters(def)` | `DeadLetterHandle<TMessage>` | Queue dead-letter inspection and management |

### New top-level exports

- `defineQueue`
- `defineRequest`
- `defineTopic`
- `SearchQueryNode` (type) — replaces `MetadataQueryNode`
- `SearchQuery` (type) — replaces `MetadataQueryBuilder`
- `DeadLetterRecordFields` (type)
- `DeadLetterSort` (type)
- `DeadLetterCursor` (branded type)
- `DeadLetteredMessage` (type)
- `DeadLetterHandle` (type)
- `RequestCompensationResult` (type)
- `AttemptAccessor` (type) — replaces `StepErrorAccessor`
- `Unsubscribe` (type) — `() => void`; returned by all subscription methods
- `RegisterTopicConsumerError` (type) — union of logical consumer registration errors
- `TopicConsumerAlreadyActiveError` (type)
- `ScheduleOptions` (type) — `delaySeconds` / `scheduledAt` for deferred workflow starts
- `IWorkflowConnection` (type) — opaque checked-out DB connection for caller reuse
- `IWorkflowTransaction` (type) — opaque active transaction handle for caller enlistment
- `RetentionSetter` (generic type) — replaces `RetentionSettings`; parameterized over status union

### Breaking changes

- `StepErrorAccessor` renamed to `AttemptAccessor`. Export removed.
- `StepCompensationResult.errors` renamed to `StepCompensationResult.attempts`.
- `StepErrorAccessor.count` (sync property) replaced by `AttemptAccessor.count()` (async method).
- `MetadataQueryNode` and `MetadataQueryBuilder` are not introduced. The generalized `SearchQuery` / `SearchQueryNode` replace them.
- `SubscriptionHandle` removed. Registration methods return synchronous `Unsubscribe` callbacks.
- `retryPolicy` interval fields renamed from `intervalSeconds` / `maxIntervalSeconds` to `intervalMs` / `maxIntervalMs` (milliseconds, consistent with TypeScript's convention).
- `RetentionSettings` renamed to `RetentionSetter<TStatus extends string>`. All existing usages become `RetentionSetter<"complete" | "failed" | "terminated">`. The `setRetention` method on `WorkflowHandleExternal` is updated accordingly.
- `ctx.requests.X(payload)` (no options) is no longer valid. `timeout: number | null` is now required.

### Connection and transaction model

**Implementation goal — not a blocking question.**

Introduce two opaque types:

```typescript
type IWorkflowConnection;    // a checked-out DB connection (may or may not be in a transaction)
type IWorkflowTransaction;   // a connection that is inside an active transaction block
```

Client and engine-level APIs that perform simple CRUD — `startWorkflow`, `start`, `execute`, queue/topic/request publish, dead-letter `redrive`/`redriveAll`/`discard`/`discardAll`, and read queries — accept an optional `txOrConn?: IWorkflowTransaction | IWorkflowConnection` parameter. This allows callers to:

- Enlist engine operations into an **existing transaction** (`IWorkflowTransaction`) for all-or-nothing semantics alongside their own DB writes.
- Reuse an **already-checked-out connection** (`IWorkflowConnection`) from their own pool to avoid holding two connections simultaneously (which can cause pool exhaustion deadlocks under concurrent load).

**Strict boundary: workflow logic is entirely exempt.**

`WorkflowContext` and `CompensationContext` APIs (`ctx.queues.X.publish`, `ctx.requests.X`, `ctx.topics.X.publish`, `ctx.attributes.X.set`, etc.) do NOT accept `txOrConn`. Workflow logic runs inside the engine's own durable execution transaction — the caller has no visibility into, and must not interfere with, that internal transaction. This is an absolute boundary, not a soft recommendation.

**Blocking operations are also exempt.**

Operations that wait for external state — `attribute.get(afterVersion)`, `channel.receive()`, request response polling — must NOT accept `txOrConn`. Holding a transaction or connection open across an unbounded wait is a deadlock risk against the pool. These operations always use their own internally managed connection.

**Subscription connections are a separate concern.**

`registerQueueHandler`, `registerTopicConsumer`, `DeadLetterHandle.listen`, etc. are long-lived polling/listening processes. They manage their own dedicated connection internally and have no relationship to `IWorkflowTransaction` or `IWorkflowConnection`. There is no API surface for the caller to inject a connection into a subscription.

---

## Open Questions and Implementation Concerns

### Topics

**Q1. Consumer stuck on a failing record.**
If a topic consumer handler keeps failing on a specific record (e.g. a malformed payload that always causes the handler to throw), the consumer's offset never advances. The consumer is permanently stuck. The `retryPolicy` has no `maxAttempts` for topic consumers. There needs to be either: a `maxAttempts` option with a dead-letter path for the record, or explicit documentation that this is the user's responsibility (write defensive handlers). The current document is silent.

**Q2. Delivery guarantee semantics.**
The document implies at-least-once delivery for topic consumers (failed handlers retry). It does not explicitly state the delivery guarantee or whether exactly-once processing is achievable or a goal. This should be stated explicitly.

**Q3. Topic retention independent of consumer progress.**
The cleanup job deletes records only when all registered consumers for the topic have advanced past them. If one consumer is permanently offline, records accumulate indefinitely regardless of retention config. Should there be a max retention window independent of consumer progress? If so, what happens to consumers that are behind the retention window when they reconnect — do they resume from the oldest available record, or is the gap a terminal error?

**Q4. Advisory lock key stability for consumer identity.**
The session-level advisory lock used for exclusive consumer identity must use a key that (a) does not collide with advisory locks used elsewhere in the engine and (b) is stable across restarts. The specific key construction strategy is an implementation concern left to the implementor.

**Q5. Behavior when `registrationRetry.maxAttempts` is exhausted.**
When `maxAttempts` is set on `registrationRetry` and all attempts fail (all fire `onError`), the subscription becomes permanently inactive without being explicitly unregistered. Is there a final terminal notification to the caller? Currently `onError` fires on each attempt including the last — the user must track attempt count themselves if they want to know they've hit the ceiling. Consider whether a distinct `onMaxAttemptsExhausted` callback or a final `onError` call with an `isTerminal: true` flag would improve ergonomics, or whether documenting that the user should call `unregister()` in `onError` when they want to stop is sufficient.

---

### Attributes

**Q6. Version number at initial state.**
The SQL schema specifies `version BIGINT NOT NULL DEFAULT 1` but the initial "never set" state conceptually has no version. The `get()` API should treat version 0 as "not yet set" and version >= 1 as "set at least once." This needs to be consistent between the schema, the `get()` return type, and the `afterVersion` semantics. Currently there is a potential inconsistency in the document.

**Q7. Attribute cleanup on workflow termination.**
The document does not specify whether attribute rows are deleted when the workflow terminates, or retained for the duration of the workflow's retention period (consistent with streams and events). This needs an explicit decision. Retaining them through the retention window is likely the correct choice for consistency.

**Q8. Concurrent `set()` calls from parallel branches.**
If two concurrent workflow branches both call `ctx.attributes.X.set()` simultaneously, the outcome is last-write-wins based on transaction commit order. This is probably acceptable, but it means the `version` counter may not reflect "number of logical updates" if both increments race. The behavior should be stated explicitly in the documentation so developers know what to expect.

**Q9. `LISTEN/NOTIFY` scalability.**
The `get(afterVersion)` implementation relies on `LISTEN/NOTIFY` for instant change delivery. Under high concurrency (many external clients watching many attributes simultaneously) this can become a bottleneck at the Postgres side. This is a known limitation of the approach and worth documenting. An alternative (polling with exponential backoff) could be offered as a fallback.

**Q10. `never` detection mechanism.**
The `get()` call must return `{ status: "never" }` when the workflow terminates without setting the attribute. Implementing this requires the external client to detect workflow termination while blocked on a `LISTEN/NOTIFY` wait. The mechanism for this (e.g. subscribe to a workflow-completed notification alongside the attribute notification, or poll workflow status alongside) is not specified and is non-trivial to implement correctly.

---

### Compensation Model Correction

**Q11. This section is the most uncertain part of the document.**
The "eager compensation at failure time" model represents a meaningful behavioral change to the engine's execution model. The following sub-questions are all unresolved:

- **Ordering**: When a step fails and is caught with `.failure()`, at what point exactly does the eager compensation execute? Before the `.failure()` callback runs? After? The ordering matters because the compensation callback may itself use `ctx` operations that interact with subsequent workflow code.

- **LIFO stack interaction**: After eager compensation runs for a failed step, is that step's compensation callback removed from the LIFO stack? If yes, it will not run again if the workflow subsequently fails. If no, it runs twice (eagerly and during unwind). Both have implications. Idempotency of compensation callbacks handles the "runs twice" case, but the correct behavior should be an explicit engine decision, not an accident of implementation.

- **Scope exit behavior interaction**: The existing scope exit table says branches with compensated steps are compensated on scope exit. If a step inside a scope fails and is caught (triggering eager compensation), does the scope exit behavior also try to compensate it? This creates potential double-compensation. The interaction needs to be explicitly resolved.

- **Virtual event loop interaction**: The existing virtual event loop interleaves concurrent compensation callbacks. Does eager compensation use the same mechanism, or is it executed inline and synchronously relative to the workflow's execution thread?

- **Steps with zero attempts**: If a step times out before making a single attempt (e.g. `deadlineUntil` already passed), no work was done. Should compensation run? The "attempted" principle suggests no, but the engine needs to track attempt count to know this.

- **This section should be treated as a starting point for a separate focused design discussion, not as a complete specification.**

---

### Steps

**Q12. Infinite retries and the `.failure()` builder.**
A step configured with no `maxAttempts` (infinite retries) and no `deadlineSeconds` can never reach an exhausted state. The `.failure()` builder is always present on `StepCall` but is unreachable in this configuration — a silent dead code path. The type system does not currently model this distinction. Options: (a) make `.failure()` only available when `maxAttempts` is finite or `deadlineSeconds` is set, requiring the retry policy to be part of the `StepCall` type; (b) require that a step definition or call-site policy must specify either `maxAttempts` or a deadline before `.failure()` is chainable; (c) document the limitation and provide a lint/runtime warning. Option (a) would be the most type-safe but adds significant complexity to the call type machinery.
