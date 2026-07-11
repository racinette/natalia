# Topics — PostgreSQL implementation

Postgres schema, queries, locks, and notification wiring for topics. Consumer semantics and the client registration API are documented separately.

---

## Tables

```sql
CREATE TABLE topic_records (
  id          BIGSERIAL PRIMARY KEY,
  topic_name  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON topic_records (topic_name, id);

CREATE TABLE topic_consumers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  topic_name     TEXT NOT NULL,
  last_id        BIGINT NOT NULL DEFAULT 0,
  offset_expired BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at   TIMESTAMPTZ,
  UNIQUE (topic_name, name)
);

CREATE TABLE topic_consumer_attempt (
  id              BIGSERIAL PRIMARY KEY,
  consumer_id     BIGINT NOT NULL REFERENCES topic_consumers(id) ON DELETE CASCADE,
  from_record_id  BIGINT NOT NULL REFERENCES topic_records(id) ON DELETE CASCADE,
  to_record_id    BIGINT NOT NULL REFERENCES topic_records(id) ON DELETE CASCADE,
  attempt         INT NOT NULL,
  error_message   TEXT,
  error_type      TEXT,
  error_details   JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_at       TIMESTAMPTZ NOT NULL
);
```

| Column | Notes |
| --- | --- |
| `topic_records.payload` / `metadata` | Filter predicates compile against these JSONB columns |
| `topic_consumers.last_id` | Durable committed offset; monotonic per consumer |
| `topic_consumer_attempt.from_record_id` / `to_record_id` | Inclusive batch range on failure; equal when batch size is 1 |

---

## Publish commit

Within the workflow durable commit transaction, per append:

1. **Per-topic transaction advisory lock** — serializes commits targeting the same `topic_name` so consumers never observe a higher `id` before a lower one from an in-flight publisher.
2. `INSERT INTO topic_records (...)`.
3. `NOTIFY topic_append_<topic_name>` (channel name is implementation-defined). Payload is append metadata only (topic name, optional new `id`). Payload is not filterable; notifications are transient.

---

## Consumer liveness

One active process per `(topic_name, consumer name)` via a **session-level Postgres advisory lock**. The holder updates `topic_consumers.last_seen_at` periodically.

Lock key derivation is implementation-defined (e.g. hash of `topic_name` and consumer `name` into a 64-bit advisory key).

---

## Multi-consumer fetch (one round trip)

Each scheduler wake issues **one `SELECT`** for all active consumers on a topic.

### Why predicates belong in `WHERE`

A fetch that only used `id > min(last_id)` without per-consumer `OR` disjuncts would return every log row in the window. Most rows would have all `affected_consumers` flags false — wasted I/O. Rows that match **no** consumer's `(cursor, filter)` disjunct are omitted from the result set.

`id > min(last_id)` is not a shared consumer cursor. It seeds the `(topic_name, id)` index scan. Each disjunct carries that consumer's own cursor.

### Worked example

Topic `auditEvents`. Record schema has `payload.type`, `payload.amount`; metadata has `metadata.tenantId`, `metadata.type`.

| Consumer | `last_id` | Authoring filter (for reference) |
| --- | --- | --- |
| `analytics` | 1042 | `tenantId = 'acme'` AND `payload.type = 'booking.confirmed'` |
| `billing` | 1098 | `metadata.type = 'payment'` |

Compiled predicates (identical in `WHERE` disjuncts and `affected_consumers`):

```sql
-- Fa (analytics)
metadata->>'tenantId' = 'acme'
AND payload->>'type' = 'booking.confirmed'

-- Fb (billing)
metadata->>'type' = 'payment'
```

Full fetch:

```sql
SELECT
  id,
  payload,
  metadata,
  jsonb_build_object(
    'analytics',
      (id > 1042
       AND metadata->>'tenantId' = 'acme'
       AND payload->>'type' = 'booking.confirmed'),
    'billing',
      (id > 1098
       AND metadata->>'type' = 'payment')
  ) AS affected_consumers
FROM topic_records
WHERE topic_name = 'auditEvents'
  AND id > 1042
  AND (
    (id > 1042
     AND metadata->>'tenantId' = 'acme'
     AND payload->>'type' = 'booking.confirmed')
    OR
    (id > 1098
     AND metadata->>'type' = 'payment')
  )
ORDER BY id ASC
LIMIT 100;
```

Example result row `id = 2500`, `metadata = {"tenantId":"acme","type":"order"}`, `payload = {"type":"booking.confirmed",...}`:

| Field | Value |
| --- | --- |
| `affected_consumers` | `{"analytics": true, "billing": false}` |

`analytics` buffers the row. `billing` leapfrog-skips to `2500` because the row entered via `analytics`'s disjunct.

### Predicate compilation

Authoring filters compile to boolean SQL over `metadata` and `payload` JSONB. The same expression text is pasted into the matching `WHERE` disjunct and `jsonb_build_object` entry.

| Authoring pattern | Compiled SQL |
| --- | --- |
| `q.metadata.tenantId.eq("acme")` | `metadata->>'tenantId' = 'acme'` |
| `q.payload.type.eq("payment")` | `payload->>'type' = 'payment'` |
| `q.and(A, B)` | `(<A>) AND (<B>)` |
| `q.or(A, B)` | `(<A>) OR (<B>)` |
| `q.payload.amount.gte(100)` | `(payload->>'amount')::numeric >= 100` |

Restrictions (enforced at compile time, not in SQL):

- String equality uses `->>` text extraction and literal comparison.
- Numeric range (`gte`, `lte`, …) only on fields typed as homogeneous numeric in the topic schema; cast via `::numeric`.
- Heterogeneous unions (e.g. `string \| number`) — equality only, no ranges.
- No arbitrary JSON paths; only fields declared on the topic `record` / `metadata` schemas.

Example with `AND`, `OR`, and numeric range — consumer `warehouse`, `last_id = 0`:

```sql
-- Fw: tenant acme AND (confirmed OR cancelled) AND amount >= 100
metadata->>'tenantId' = 'acme'
AND (
  payload->>'type' = 'booking.confirmed'
  OR payload->>'type' = 'booking.cancelled'
)
AND (payload->>'amount')::numeric >= 100
```

---

## Offset advancement on the engine side

The engine keeps, per consumer, a durable `last_id` (mirrored in `topic_consumers`) and an in-memory `scan_through_id` (starts at `last_id` on lock acquisition).

For each returned row `R` in `id` order, for each active consumer `C`:

| Condition | Action |
| --- | --- |
| `R.id <= C.scan_through_id` | Ignore |
| `affected_consumers[C] = true` | Append `R` to `C`'s in-memory batch buffer; `scan_through_id = R.id` |
| `affected_consumers[C] = false` and `R.id > C.scan_through_id` | **Leapfrog skip**: `scan_through_id = R.id`; persist `last_id = R.id` |

The third case covers a row that entered the result set via another consumer's `WHERE` disjunct but does not match `C`'s filter. `C` was not meant to handle `R`, but must still advance past it.

Rows that match **no** `WHERE` disjunct are not returned. A lagging consumer advances past them when a later returned row triggers leapfrog — same effect as a per-consumer `id > last_id AND filter` query jumping to the next match.

On successful batch processing, persist `last_id` to the highest `id` in the batch. On failure, leave `last_id` unchanged and insert `topic_consumer_attempt`.

---

## `LISTEN` / `NOTIFY` and polling

The topic connection `LISTEN`s on the append channel. `NOTIFY` schedules a debounced fetch (coalesces bursts). A fixed **poll interval** runs the same fetch path when notifications are lost or the listener was disconnected.

Both paths execute the identical `SELECT` above.

---

## Failed attempts

```sql
INSERT INTO topic_consumer_attempt (
  consumer_id, from_record_id, to_record_id,
  attempt, error_message, error_type, error_details,
  started_at, failed_at
) VALUES (...);
```

Only failures are recorded. Success advances `last_id` only.

---

## Retention sweeper

Classify consumers as **live** (holds session advisory lock, `last_seen_at` within grace) or **dead**.

Delete `topic_records` row `r` when:

- `now() - r.created_at > topic.retention_seconds`, and
- every **live** consumer has `last_id >= r.id`, and
- no live `never_expire` consumer has `last_id < r.id`

For dead consumers whose `last_id` points at purged rows, set `offset_expired = TRUE`.

`never_expire` is stored per `topic_consumers` row (column name implementation-defined; semantics per consumer registration options).

---

## Invariants

| Invariant | Postgres mechanism |
| --- | --- |
| Publish ordering per topic | Transaction-scoped advisory lock on commit |
| One active consumer instance | Session advisory lock |
| Filters evaluated once, in SQL | Predicates in `WHERE` and `affected_consumers` |
| No fetch of universally irrelevant rows | `OR` of per-consumer `(id > cursor AND filter)` disjuncts |
| Lagging consumer skip over gaps | Leapfrog on returned rows |
| At-least-once handler delivery | `last_id` advances only after successful batch commit |
