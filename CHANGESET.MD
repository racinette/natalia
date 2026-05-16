# Public API proposals (CHANGESET)

This document records **proposed** changes and open questions for the **public** surface. It is **not** a changelog. Authoritative “what we’re building” lives in **`REFACTOR.MD`** and the **`src/types`** tree; here we only keep work that is still **ahead of us** or **undecided**. Occasional **baseline** one-liners exist solely so a proposal isn’t read in a vacuum — they are not a substitute for the spec.

---

## Main themes (informal backlog)

3. OTel integration — needs exploratory analysis first.
4. **Client vs engine** — different connection sources. Does the client accept a pool in the constructor, or does every method accept a connection? How do we stay generic over backend type?
5. A way to **pause** a workflow.
6. **Forking** a workflow from a specific point in time — likely requires richer introspection over workflow state, steps, and scopes. Concurrent branches make semantics an open problem.
7. Client-driven **rollback** — signal a running workflow (`sigterm` / etc.) and wait for compensation, _or_ force rollback after completion. (Operator verbs and `WorkflowResult` are taking shape in the type layer; runtime wiring is still ahead.)
8. New primitive: **stream aggregator** (working name) — denormalized aggregate over a stream, possibly related to long-running workflows, topic consumption, continue-as-new, etc. Use cases and global-state concerns are still fuzzy.
9. **Real cron-like workflow starts** — external scheduling that creates new instances (see §19). Distinct from in-workflow `ctx.schedule()` ticks.
10. **List / browse ergonomics** for operators — see §20.
11. introduce scope hierarchies. effectively `{scope1: { scope11: true, scope12: { scope121: true } }, scope2: true }`
12. add "aborted" flag to attempt. this is to track whether a per-attempt timeout was triggered for the attempt in question.
13. `ctx.children.attached.processOrder({ args: {...} })` - is this really the syntax? args should be the first argument then.

If we land the above coherently, the public API is close to “feature complete” for the product vision.

---

## 20. List / browse ergonomics (introspection)

### Baseline (for reading this proposal only)

The **target** shape in the type system today (runtime still largely stubbed) is:

- Per-workflow accessors on engine/client: `start`, `execute`, `get(idempotencyKey)`, `findUnique`, `findMany`, `count`.
- Predicates and sorts use the generalized **`SearchQuery<TNamespaces>`** machinery; workflows use **`WorkflowQueryNamespaces`** (flat `row` columns plus JSONB namespaces such as `args`, `result`, `metadata`, `error`), not legacy workflow-only search aliases.
- **`findMany`** returns **`FindManyResult<THandle>`** — dual `PromiseLike` + `AsyncIterable` — rather than an explicit “search page” DTO. Pagination is an implementation detail behind that surface.
- Each row is addressed through a typed handle; **`fetchRow(fields?)`** (with field masks / **`WorkflowRow`**) is the projection path for “what columns do I need on this instance?”.

So the old idea of a dedicated minimal **`WorkflowSearchItem`** type is **superseded** by: **handle + query + optional row projection**. This section proposes what might still be **missing** for operator UX on top of that baseline.

### Proposals

1. **Summary-friendly defaults**  
   For dashboards and multi-project scans, we may want either:
   - documented **recommended field masks** for `fetchRow` in list contexts, and/or
   - an optional **higher-level “summary” view** (still to be designed) that avoids N+1 round-trips without abandoning the handle-centric model.

2. **Rich enough row semantics**  
   Ensure the **persistence model + `WorkflowRow`** (and related halt / termination types) expose everything operators need at a glance: status, key timestamps, failure vs termination vs halt, compensation progress — aligned with **`WorkflowResult`**, halt records, and schema types, rather than inventing parallel DTOs.

3. **Pagination contract**  
   **`FindManyResult`** intentionally hides cursor encoding. Proposal: specify **ordering defaults** (e.g. `createdAt` descending), **stable sort keys**, and **behavior under concurrent writes** for implementers; document any **page-size** or **back-pressure** knobs once the wire format exists.

4. **Sorting**  
   Keep the goal: default “newest first”; allow overrides via the existing sort types on the query builder, tied to **`WorkflowQueryNamespaces`** (not a parallel sort API).

---

## 19. Cron workflow starts (external scheduling)

**Baseline:** `ctx.schedule()` addresses **recurring work inside** an already-running workflow.

**Proposal:** first-class **engine/client schedule registry** that **starts new workflow instances** on a cron (or similar), e.g. nightly cleanup.

### Proposed API

```typescript
// Register a cron schedule
const scheduleHandle = await client.schedules.create({
  name: "nightly-cleanup",
  workflow: orderCleanup,
  expression: "0 0 * * *", // standard cron
  timezone: "America/New_York", // optional, default UTC
  args: { daysToKeep: 30 }, // workflow args (InferInput)
  metadata: { team: "ops" }, // optional metadata
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

## Add-ons

- We **most probably** need a logger wrapper to support multiple logging backends.
- We **may** want a clean abstraction over a storage client instead of hard-coding Postgres everywhere — likely converges with item 4 above as the engine solidifies.
