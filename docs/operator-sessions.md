# Operator sessions

Operator-facing reads and writes against durable engine state run inside an explicit **session**. A session is the unit of work the storage driver provides: snapshot reads, queries, mutations, and (when the backend supports it) atomic batches of those operations together.

Construct a client with a **storage driver**. The driver defines what `session.raw` is (for example, an open database transaction on Postgres) and advertises **capabilities** on each session.

## Quick start

```typescript
import { createWorkflowClient } from "natalia";
import { postgresDriver } from "./postgres-driver"; // your driver package

const client = createWorkflowClient({ orderWorkflow }, postgresDriver);

await client.session(async (session) => {
  const halted = await client.workflows.order.find(
    session,
    ({ status }) => eq(status, "halted"),
    { fields: { id: true, args: true }, limit: 50 },
  );

  for (const wf of halted) {
    await wf.skip(session, { orderId: wf.row.args.orderId, status: "expired" });
  }
});
```

Every **snapshot / command** operator call in that callback receives the same `session` as its **first argument**. The driver opens the session before the callback runs and finalizes it when the callback completes or throws.

## Obtaining a session

| Entry | When to use |
|-------|-------------|
| `client.session(fn)` | Normal operator scripts. The driver owns acquire and finalize. |
| `client.adoptSession(raw)` | Natalia IO inside a **foreign transaction** you already started. You own finalize; Natalia does not commit or roll back an adopted session. |

**Adopt** requires an **already-started transaction** (or the driver’s equivalent). Pass the same handle you use for other work in that unit:

```typescript
await appDb.transaction(async (foreignTx) => {
  const session = client.adoptSession(foreignTx);

  await nataliaHandle.fetchRow(session, { fields: { status: true } });
  await appDb.insert(auditTable).values({ ... });

  // foreignTx commits here — session.raw === foreignTx throughout
});
```

## Session shape

```typescript
interface OperatorSession<TRaw> {
  readonly capabilities: {
    readonly atomic: boolean;   // multi-op batches behave as one unit
    readonly isolated: boolean; // reads share a consistent snapshot
  };
  readonly origin: "engine" | "adopted";
  readonly raw: TRaw; // driver handle for the open scope; present for the whole session
}
```

Query `session.capabilities` when operator logic depends on backend semantics. Weaker drivers may report `atomic: false` while still exposing the same API.

Use `session.raw` for side SQL or driver calls that must share the same scope as Natalia IO inside `client.session` or an adopted session.

## Two classes of operator IO

### Snapshot / command — session required (first argument)

Short-lived durable access: point reads, queries, counts, mutations.

```typescript
await handle.fetchRow(session, { fields: { status: true } });
await client.workflows.order.find(session, ({ status }) => eq(status, "running"));
await handle.skip(session, result, { strategy: "sigkill" });
await handle.streams.metrics.readNowait(session, 0);
await handle.channels.approval.send(session, { approved: true });
await client.workflows.order.start(session, { idempotencyKey: "k-1", args });
await deadLetter.retry(session);
await request.resolve(session, response);
```

`.get(id)` on namespaces is synchronous identity grounding only — no session.

Handler-runtime namespaces inside workflow and queue/request callbacks (`ctx.attempts`, `info.attempts`, …) do not take a session; the engine owns storage scope there.

### Watch — no session

Long-lived waits: block until state appears or the instance reaches a terminal disposition. Pass **`signal`** only (native `AbortSignal` helpers).

```typescript
await handle.streams.metrics.read(offset, { signal: AbortSignal.timeout(60_000) });
await handle.events.orderReady.wait({ signal });
await handle.wait({ signal });
```

Watch IO performs a short snapshot, releases any transactional scope, waits on the driver’s notification path, then reads again to deliver the result. Do not wrap tail-follow loops in `client.session` — iterate with watch `read` calls instead.

## Read-decide-act

Keep inspection and mutation in one `client.session` callback so they share one session:

```typescript
await client.session(async (session) => {
  const blocks = await order.compensations.steps.bookHotel.find(
    session,
    ({ status }) => eq(status, "halted"),
    { fields: { args: true } },
  );

  for (const block of blocks) {
    await block.skip(session, { kind: "abandoned" });
  }

  await order.skip(session, { orderId: "…", status: "force-cleared" }, {
    strategy: "sigkill",
  });
});
```

## Workflow body

Workflow `execute` and compensation `undo` do not take a session. The engine schedules their buffered writes inside its own durable batch commit.

## Related primitives

- [Streams](./primitives/streams.md) — `readNowait(session, offset)` for snapshots; blocking `read(offset, { signal })` for watch
- [Events](./primitives/events.md) — `isSet(session)` for snapshots; `wait({ signal })` for watch
- [Queues](./primitives/queues.md) — dead-letter operator actions
- [Requests](./primitives/requests.md) — manual resolution and compensation operator actions
- [Resolving requests asynchronously](./resolving-requests-asynchronously.md) — atomic resolution with foreign transactions via `adoptSession`
