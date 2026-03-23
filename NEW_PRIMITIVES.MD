# New Primitives — Implementation Plan

## Overview

This document describes four new primitives to be added to the public API of the durable workflow engine, along with a correction to the existing compensation trigger model. It is written as a task description for an implementing agent.

The changes are:

1. **Queues** — global competing-consumer work queues
2. **Requests** — global typed request-response with external handler resolution
3. **Topics** — global ordered per-topic append logs with named consumers
4. **Attributes** — workflow-instance-bound observable single current value
5. **Streams extension** — non-blocking read variant on the external handle
6. **Search query refactoring** — extract reusable metadata query type system
7. **Compensation model correction** — eager compensation trigger on caught failures

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

The existing `src/types/search-query.ts` already implements a rich typed metadata query AST. It has two namespaces: `engine` (workflow-specific DB fields) and `meta` (user-supplied metadata predicates). The `meta` namespace is entirely generic and can be reused for message routing filters on queues, requests, and topics.

### Task

Extract the following from `search-query.ts` into a shared location (e.g. `src/types/metadata-query.ts`) without modifying the existing workflow search API:

**`MetadataQueryNode<TMetadata extends SearchMetadataRecord>`**

A discriminated union AST with no `engine` namespace. Composed of:
- `{ kind: "and"; nodes: readonly MetadataQueryNode<TMetadata>[] }`
- `{ kind: "or"; nodes: readonly MetadataQueryNode<TMetadata>[] }`
- `{ kind: "not"; node: MetadataQueryNode<TMetadata> }`
- All predicate node kinds from the existing `WorkflowSearchMetaPredicateNode<TMetadata>`: `exists`, `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `contains`, `containsAny`, `containsAll`

**`MetadataQueryBuilder<TMetadata extends SearchMetadataRecord>`**

Mirrors the `meta` branch of the existing `WorkflowSearchQueryBuilder<TMetadata>`, plus `and`, `or`, `not` combinators. No `engine` branch.

The existing `WorkflowSearchQueryNode` and `WorkflowSearchQueryBuilder` should be updated to compose on top of `MetadataQueryNode` and `MetadataQueryBuilder` rather than duplicating the meta predicate logic.

### Usage

All three new global primitives (queues, requests, topics) use `MetadataQueryBuilder<TMetadata>` as the type of the `q` parameter in filter callbacks at handler/consumer registration:

```typescript
{ filter: (q: MetadataQueryBuilder<TMetadata>) => MetadataQueryNode<TMetadata> }
```

When a definition has no `metadata` schema, `TMetadata` resolves to `Record<string, never>` and TypeScript omits the `filter` property from the options type entirely.

---

## Part 2: Queues

### Purpose

A global competing-consumer work queue. Any workflow can publish a typed message to a named queue. Any registered worker (in any process) can consume from it. Messages are processed exactly once via `SELECT FOR UPDATE SKIP LOCKED`. Strict FIFO is not guaranteed and this is acceptable — the name "queue" communicates "messages wait for a consumer," not "messages are processed in strict insertion order."

### Definition

Add `defineQueue` to the public exports:

```typescript
const notificationsQueue = defineQueue({
  name: "notifications",                              // globally unique, stable string
  message: z.object({ userId: z.string(), body: z.string() }),
  metadata: z.object({ channel: z.enum(["email", "sms", "push"]) }), // optional
});
```

- `name` — the queue's DB namespace. Must be globally unique across all `defineQueue` calls registered with an engine instance.
- `message` — Zod schema for the payload. Input type used for publishing (encoded to JSONB); output type delivered to handler (decoded).
- `metadata` — optional Zod schema for routing metadata. If absent, the `filter` parameter is not available at handler registration (enforced by TypeScript).

### Workflow-internal API

Add `queues` to `WorkflowContext`, `CompensationContext`, and their concurrency variants.

```typescript
// Tier 3 — DirectAwaitable<void>
await ctx.queues.notifications.publish(
  { userId: "u1", body: "Hello" },
  { metadata: { channel: "email" } },  // second argument omitted if no metadata schema
);
```

- Workflow can only publish to queues, never read from them.
- Available in both `WorkflowContext` and `CompensationContext` — publishing during compensation is a valid pattern (e.g. audit notification on rollback).

Add `queues` to `defineWorkflow` definition:

```typescript
defineWorkflow({
  queues: { notifications: notificationsQueue },
  // ...
});
```

The queue definitions in the workflow declare which queues the workflow interacts with. They do not register handlers — that is a separate client concern.

### Client registration API

Add `registerQueueHandler` to the client class (separate from `WorkflowEngine`):

```typescript
const handle = await client.registerQueueHandler(
  notificationsQueue,
  async (message) => {
    // message is z.output<typeof notificationsQueue.message>
    await sendEmail(message.userId, message.body);
  },
  {
    filter: (q) => q.channel.eq("email"),     // optional; only available if metadata schema exists
    timeout: 30,                               // seconds, per-attempt handler timeout
    retryPolicy: {
      maxAttempts: 5,                          // dead-letter after N failures
      intervalSeconds: 2,
      backoffRate: 2,
      maxIntervalSeconds: 60,
    },
  },
);

await handle.stop(); // deregisters and stops consuming
```

- Multiple handlers for the same queue definition are permitted. Each has an independent filter. Workers only see and compete for messages matching their filter.
- When filters overlap between handlers, assignment is non-deterministic (SKIP LOCKED determines which eligible worker gets the row). This is documented behavior and the user's design responsibility.
- `maxAttempts` is meaningful for queues: after exhaustion, the message is moved to a dead-letter path.
- If no handler matches a message, it remains in the queue until a matching handler is registered or a retention policy expires it.

### Postgres implementation

- Table: `queue_messages(id SERIAL, queue_name TEXT, payload JSONB, metadata JSONB, status TEXT, attempt_count INT, created_at TIMESTAMPTZ, claimed_at TIMESTAMPTZ, dead_lettered_at TIMESTAMPTZ)`
- Consumers use `SELECT FOR UPDATE SKIP LOCKED WHERE queue_name = $1 AND status = 'pending' AND (metadata @> $filter OR $filter IS NULL)`.
- On handler success: delete row (or mark `status = 'processed'` for audit).
- On handler failure: increment `attempt_count`, release lock (rollback or explicit unlock), re-eligible after backoff delay.
- On `attempt_count >= maxAttempts`: mark `status = 'dead_lettered'`.
- Cleanup background coroutine: delete processed rows past retention window.

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
  metadata: z.object({ category: z.string(), urgency: z.enum(["high", "low"]) }), // optional
});
```

### Workflow-internal API

Requests are **Tier 1** (`DeterministicAwaitable`) — they must be resolved via `.resolve(ctx)`. This allows `.compensate()` and the conditional `.timeout()` builder to be chained.

The return type of the call depends on whether `timeout` is specified in the options. This is enforced at the TypeScript level via overloads:

**Without timeout — `UntimedRequestCall<TResponse>`**

Available builders: `.compensate()` only. The request waits indefinitely. There is no `.timeout()` on the type.

```typescript
const result = await ctx.requests
  .humanReview({ context: "...", data: signals })
  .compensate(async (ctx, result) => {
    // result: RequestCompensationResult<TResponse>
    if (result.status === "complete") {
      await ctx.requests.revokeDecision({ context: "..." }).resolve(ctx);
    } else {
      // result.status === "attempted"
      await ctx.requests.cancelPendingReview({ context: "..." }).resolve(ctx);
    }
  })
  .resolve(ctx);
// result: TResponse — always, waits indefinitely
```

**With timeout — `TimedRequestCall<TResponse>`**

Available builders: `.compensate()` and `.timeout()`. `.timeout()` builder is present ONLY when `timeout` is specified in the options. If `.timeout()` is not chained despite a timeout being specified, and the timeout fires, the workflow auto-terminates (consistent with unchained `.failure()` on steps).

```typescript
const result = await ctx.requests
  .humanReview(
    { context: "...", data: signals },
    { metadata: { category: "fraud", urgency: "high" }, timeout: 300 },
  )
  .compensate(async (ctx, result) => { /* same as above */ })
  .timeout(() => null)  // fires if 300s pass with no response
  .resolve(ctx);
// result: TResponse | null
```

- The `metadata` second argument is required if `metadata` schema exists on the definition, omitted otherwise.
- The `timeout` option specifies how long the workflow waits for any response. It is the ONLY execution parameter the caller controls. Retry behavior is entirely the handler's concern.
- `.timeout(cb)` receives no arguments — there is no "failure reason" to communicate. Timeout is the only non-success outcome.

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

The workflow caller does NOT control retry behavior. The caller controls only: payload, metadata (routing), and timeout (overall deadline). Retry policy is entirely the handler's concern.

For requests, `maxAttempts` is intentionally absent from the handler retry policy. A handler failure releases the lock and makes the request row eligible for any other matching worker to pick up. The request does not "die" after N handler failures — it waits for the next eligible worker within the caller's timeout window. Capping attempts at the handler level would be semantically incorrect for requests (unlike queues, where messages should eventually dead-letter).

### Client registration API

```typescript
const handle = await client.registerRequestHandler(
  humanReview,
  async (request) => {
    // request is z.output<typeof humanReview.request>
    const decision = await routeToHumanUI(request);
    return { decision, note: "reviewed by operator" };
    // return value must match z.input<typeof humanReview.response>
  },
  {
    filter: (q) => q.urgency.eq("high"),  // optional
    timeout: 60,                           // seconds, per-attempt handler execution timeout
    retryPolicy: {
      // No maxAttempts — failed attempts re-queue the request row
      intervalSeconds: 5,
      backoffRate: 2,
      maxIntervalSeconds: 120,
    },
  },
);

await handle.stop();
```

### Postgres implementation

- Table: `requests(id SERIAL, request_name TEXT, payload JSONB, metadata JSONB, response JSONB, status TEXT, ever_claimed BOOLEAN DEFAULT FALSE, claimed_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ)`
- `ever_claimed` is set to `TRUE` the first time any worker acquires the row lock. This is the flag the engine checks for compensation triggering.
- Workers use `SELECT FOR UPDATE SKIP LOCKED WHERE request_name = $1 AND status = 'pending' AND (metadata @> $filter OR $filter IS NULL)`.
- On handler success: set `response`, set `status = 'resolved'`, notify the waiting workflow.
- On handler failure: release lock, increment attempt count if tracked, re-eligible after backoff.
- On workflow timeout: engine checks `ever_claimed`. If `FALSE`, delete row, skip compensation. If `TRUE`, trigger eager compensation.
- Admin direct-set: update `response`, set `status = 'resolved'`, notify the waiting workflow (same path as handler success).

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
const handle = await client.registerTopicConsumer(
  auditTopic,
  "analyticsConsumer",   // stable consumer name — globally unique per topic
  async (record) => {
    // record is z.output<typeof auditTopic.record>
    await ingestToWarehouse(record);
  },
  {
    filter: (q) => q.type.eq("booking.confirmed"),  // optional; DB-level pushdown
    timeout: 10,
    retryPolicy: {
      intervalSeconds: 1,
      backoffRate: 2,
      maxIntervalSeconds: 30,
    },
  },
);

await handle.stop();
```

- Multiple `registerTopicConsumer` calls for the same topic with different consumer names are fully independent. Each has its own offset. Overlapping filters between named consumers are intentional — each consumer processes matching records independently.
- Multiple `registerTopicConsumer` calls for the same topic with the SAME consumer name, from different processes, are prevented by the advisory lock. Only one active instance per named consumer is permitted at a time.

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
2. Acquire `pg_advisory_lock(namespace_hash, consumer_id)` — a **session-level** lock. This lock is held for the lifetime of the connection. If the process dies, the connection closes, the lock releases, and another process can take over.
3. If the lock cannot be acquired immediately (another process holds it), throw an error: "Consumer '{name}' for topic '{topic}' is already active."

Consumer offsets are stored in a `topic_consumer_offsets` table:

```sql
CREATE TABLE topic_consumer_offsets (
  consumer_id BIGINT REFERENCES topic_consumers(id),
  last_offset BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (consumer_id)
);
```

### Sequential offset guarantee

Topic records require gapless sequential offsets per topic to ensure correct consumer progress tracking ("I have processed everything up to offset N" must be a safe statement).

Plain auto-increment sequences under concurrent inserts have gaps (sequence values allocated before commit, transactions committed out of order). Use `pg_advisory_xact_lock` to serialize inserts per topic:

For every topic insert:
1. `BEGIN`
2. `SELECT pg_advisory_xact_lock(hashtext(topic_name))` — blocks any concurrent insert for the same topic; held until commit
3. `INSERT INTO topic_records (topic_name, offset, payload, metadata) VALUES ($1, (SELECT COALESCE(MAX(offset), 0) + 1 FROM topic_records WHERE topic_name = $1), $2, $3)`
4. `COMMIT` — lock released automatically

This guarantees offset N+1 is never committed before offset N for the same topic. Inserts across different topics are fully concurrent.

### Postgres implementation

```sql
CREATE TABLE topic_records (
  id          BIGSERIAL PRIMARY KEY,
  topic_name  TEXT NOT NULL,
  offset      BIGINT NOT NULL,
  payload     JSONB NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (topic_name, offset)
);
```

Consumer polling:
```sql
SELECT * FROM topic_records
WHERE topic_name = $1
  AND offset > $last_offset
  AND ($filter IS NULL OR metadata @> $filter)
ORDER BY offset ASC
LIMIT $batch_size;
```

Update offset after processing:
```sql
UPDATE topic_consumer_offsets SET last_offset = $new_offset WHERE consumer_id = $id;
```

Cleanup: a background coroutine (configurable interval, default hourly) deletes records where all registered consumers for the topic have advanced past the record's offset, and the record is older than the configured retention window.

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
  workflow_id   TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  value         JSONB NOT NULL,
  version       BIGINT NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

## Summary of Public API additions

### `defineWorkflow` additions

```typescript
defineWorkflow({
  queues:     { [name: string]: QueueDefinition<M, Meta> },
  requests:   { [name: string]: RequestDefinition<Req, Res, Meta> },
  topics:     { [name: string]: TopicDefinition<R, Meta> },
  attributes: { [name: string]: ZodSchema },
});
```

### `WorkflowContext` / `CompensationContext` additions

| Addition | Tier | Notes |
|---|---|---|
| `ctx.queues.X.publish(payload, opts?)` | Tier 3 | Both contexts |
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

| Method | Returns |
|---|---|
| `client.registerQueueHandler(def, handler, opts?)` | `Promise<SubscriptionHandle>` |
| `client.registerRequestHandler(def, handler, opts?)` | `Promise<SubscriptionHandle>` |
| `client.registerTopicConsumer(def, consumerName, handler, opts?)` | `Promise<SubscriptionHandle>` |

All return a `SubscriptionHandle` with a single `.stop(): Promise<void>` method.

### New top-level exports

- `defineQueue`
- `defineRequest`
- `defineTopic`
- `MetadataQueryNode` (type)
- `MetadataQueryBuilder` (type)
- `RequestCompensationResult` (type)
