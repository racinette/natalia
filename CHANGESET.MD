## Main points

3. OTel integration. nuff said, needs exploratory analysis first.
7. client vs engine: different connection sources. does client accept a pool in the constructor? or does every client method accept a pool? how to make it generic over the type of the backend?
8. a way to pause a workflow.
10. forking a workflow from a specific place in time. essentially this forces us to introduce an api to introspect a workflow and its steps as well as scopes. Why? because forking doesn't really work that nicely in case of concurrent branches - and it's an open question of how this is supposed to really work. 
13. client should have the ability to rollback any workflow. this means that they should be able to send a sigint / sigterm, in case the workflow is alive and wait for the workflow to compensate. OR if the workflow is complete, they should be able to revert its effects nonetheless by simply forcing the rollback to happen.
18. we need a new primitive, a "stream aggregator" - i dunno what to call it. Basically it sits atop of some stream and aggregates the incoming messages into a "denormalized" json. It's an amalgamation of a consumer and a workflow with the workflow creating the initial state (if needed) and the consumer picking up the new pieces of data to modify on top of the thing. It should be able to start from some offset (a callback returning an offset after the consumer rights have been acquired). What would also be interesting is adding these kinds of stream aggregators dynamically. Maybe this is semantically close to an infinitely running workflow that updates an attribute. This could solve the entire issue. But we'd need a continue-as-new if we let it run infinitely and prevent it from growing infinitely large. However, this would only be possible if we let workflows consume the topics, which is a questionable capability, since it's globally stateful. workflow-as-an-object seems like a concept similar to distributed objects in restate. for now I cannot find a compelling use-case. however, the streams are effectively a way to collect some event stream into a single logical unit, so maybe this is actually what really is needed.
19. real cron-like workflows. I feel like outside 
    - see sketch below.
20. search result completeness.
21. force the compensation context to explicitly handle `.failure` and `.timeout`. This HAS to be forced before a `.resolve` can happen. Currently we leak errors into workflow compensation logic: this is really bad design, as we can force the dev to follow the API strictly by encoding the constraint into the types themselves.

I guess if I do all of this the public API will be feature complete.

---

## 20. Search result completeness

`WorkflowSearchItem` is currently a minimal placeholder (`idempotencyKey` + `metadata`). Search results need to be operationally useful — when scanning multiple projects at a glance, you need status, timing, and error context without hitting individual workflow handles.

### Proposed `WorkflowSearchItem` structure

```typescript
interface WorkflowSearchItem<TMeta = unknown> {
  readonly idempotencyKey: string;
  readonly metadata: TMeta;
  readonly status: "running" | "complete" | "failed" | "terminated" | "halted";
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly failedAt: Date | null;
  readonly terminatedAt: Date | null;
  readonly haltedAt: Date | null;

  /** Populated when status is "failed". */
  readonly error: WorkflowFailureInfo | null;

  /** Populated when status is "terminated". */
  readonly terminationReason: WorkflowTerminationReason | null;

  /** Populated when status is "halted". */
  readonly haltInfo: {
    readonly stepName: string;
    readonly errorMessage: string | null;
    readonly errorType: string | null;
  } | null;

  /** Whether compensation has run / is running / hasn't started. */
  readonly compensationStatus: "pending" | "running" | "complete" | "failed" | "not_applicable" | null;

  /** Deadline if set. */
  readonly deadlineAt: Date | null;
}
```

Key decisions:
- Terminal timestamps are mutually exclusive (one is set based on status), but all are present for uniform access.
- `error` uses the existing `WorkflowFailureInfo` discriminated union — no new types.
- `haltInfo` is minimal: which step halted and the captured error. Full halt inspection (stacktrace, step args) requires hitting the workflow handle.
- `compensationStatus` gives a quick read on whether cleanup has run.
- Search results should support pagination (cursor-based, consistent with `DeadLetterCursor`).

### Search result ordering

Default sort should be `createdAt DESC` (newest first). Sortable fields: `createdAt`, `completedAt`, `status`. Custom sort via the existing `SearchQuery` builder.



---

## 19. Cron workflow starts (external scheduling)

`ctx.schedule()` handles recurring work *within* a running workflow. But the common need is "start a new instance of `OrderCleanup` every day at midnight" — recurring workflow *creation* at the engine level.

### Proposed API

```typescript
// Register a cron schedule
const scheduleHandle = await client.schedules.create({
  name: "nightly-cleanup",
  workflow: orderCleanup,
  expression: "0 0 * * *",       // standard cron
  timezone: "America/New_York",   // optional, default UTC
  args: { daysToKeep: 30 },       // workflow args (InferInput)
  metadata: { team: "ops" },      // optional metadata
  // idempotencyKey is auto-derived: `schedule:{name}:{tick_timestamp}`
  // guarantees exactly one workflow per scheduled tick
});

// List schedules
const schedules = await client.schedules.list();

// Pause / resume
await scheduleHandle.pause();
await scheduleHandle.resume();

// Delete
await scheduleHandle.delete();

// Get schedule info
const info = await scheduleHandle.get();
// { name, workflow, expression, timezone, status, lastTickAt, nextTickAt, createdAt }
```

### How it works

The engine runs a lightweight scheduler loop (one per cluster, leader-elected via advisory lock). Each tick:

1. Compute all schedules whose `nextTickAt <= now`.
2. For each, call `client.workflows.X.start()` with the derived idempotency key.
3. Idempotency key = `schedule:{name}:{tick_iso}` — guarantees exactly-once per tick even if the scheduler restarts.
4. Update `last_tick_at` and compute `next_tick_at`.

### Database sketch

```sql
CREATE TABLE workflow_schedules (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  workflow_name   TEXT NOT NULL,
  expression      TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  args            JSONB,
  metadata        JSONB,
  status          TEXT NOT NULL DEFAULT 'active',
  last_tick_at    TIMESTAMPTZ,
  next_tick_at    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_schedule_status CHECK (status IN ('active', 'paused', 'deleted'))
);
```

### Key decisions

- Schedules are named and unique (no duplicates).
- Idempotency key derivation prevents double-starts on scheduler restart or leader failover.
- `args` and `metadata` are static per schedule — if you need dynamic args, use a workflow that computes them.
- Paused schedules skip ticks silently (no catchup). This is the simplest semantics and avoids a backlog of missed ticks on resume.
- Deleted schedules are soft-deleted (status = 'deleted') for audit.

---

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
