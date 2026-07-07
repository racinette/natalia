# Streams

## What it is

Treat each **running workflow instance** as the sole owner of its execution state. **Streams** are **named, typed, append-only logs** attached to that instance. While the workflow runs, its body **appends records** in a fixed order; later, **readers** that hold an appropriate **handle** can walk or jump within that history. Nothing about a stream write reaches back into the workflow’s private variables: it only extends the public tape for that instance and stream name.

Inside `execute` you record facts with `ctx.streams.<name>.write(...)`, which returns the **assigned offset** for that record. Outside, consumers use the handle’s `streams.<name>` reader. Replays reproduce the same sequence of writes in the same order, so the tape is part of the durable story of the run.

## Why it exists

Long-running work often needs a **durable, ordered transcript**—training metrics, audit lines, token chunks, deployment steps—without exposing the whole internal state machine. Streams give that transcript a first-class name and schema per instance, so operators, UIs, and integrations can follow progress **after the fact** or **while it is still running**, using the same ordering guarantees the engine relies on for replay. The mental model is intentionally close to **Kafka’s commit log**: producers append in order, consumers read by offset—only here the “partition” is scoped to **this** workflow instance rather than a shared cluster topic.

## What it is NOT

- **Not** in-place edits: you only **append**; earlier offsets are history, not cells you rewrite.
- **Not** request/response: `write` does not carry back an answer from whoever reads the stream.
- **Not** one global tape shared by every instance: each instance owns its own partitions for the stream names you declared.
- **Not** a single “latest value” abstraction: if you only care about one current field and how it changes, you're looking for an `attributes` instance; streams are for **ordered sequences** of records.
- **Not** readable from inside the workflow body: `ctx.streams` is **write-only**; external handles own all reads.

## Examples

**Declaring streams on a workflow**

```typescript
const trainingRun = defineWorkflow({
  name: "training-run",
  streams: {
    metrics: z.object({ step: z.number(), loss: z.number() }),
    audit: z.object({ at: z.string(), message: z.string() }),
  },
  async execute(ctx, args) {
    // …
  },
});
```

**Writing from inside the workflow**

```typescript
async execute(ctx) {
  const offset = ctx.streams.metrics.write({ step: 0, loss: 1.0 });
  ctx.streams.audit.write({ at: new Date(ctx.timestamp).toISOString(), message: "started" });
}
```

**Blocking read at an offset**

Waits until the record is committed. When the instance has reached a **terminal state** and `offset` is at or beyond the append length, resolves immediately with `{ ok: false, status: "never" }` — no further records will appear at that instance.

```typescript
const got = await runHandle.streams.metrics.read(0);
if (got.ok && got.status === "received") {
  const { step, loss } = got.data;
  const { offset } = got;
}
```

**Bounding a wait with an abort signal**

External reads accept `signal` only (no numeric timeout on the API). Use native `AbortSignal` helpers; abort rejects with `AbortError`.

```typescript
const got = await runHandle.streams.metrics.read(nextOffset, {
  signal: AbortSignal.timeout(5_000),
});
```

**Non-blocking read**

```typescript
const snap = await runHandle.streams.metrics.readNowait(0);
// received | not_found (not yet committed) | never (terminal, offset won't exist)

const withDefault = await runHandle.streams.metrics.readNowait(99, {
  step: -1,
  loss: 0,
}); // returns default instead of not_found
```

**Reading a range of offsets**

Loop over offsets with `read(n)` so each step accepts `signal` and `txOrConn`.

```typescript
for (let n = 0; n < 100; n++) {
  const got = await runHandle.streams.metrics.read(n, { txOrConn: tx });
  if (!got.ok) break; // never — terminal, offset won't exist
  renderChart(got.data);
}
```

**Tail-following while the instance runs**

Advance one offset at a time until `read` resolves `{ status: "never" }`.

```typescript
let n = 0;
for (;;) {
  const got = await runHandle.streams.metrics.read(n, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!got.ok) break;
  renderChart(got.data);
  n++;
}
```

Compensation block instances declare their own stream slots on `defineStep.compensation`; external reads use the same reader surface on `compHandle.streams.<name>`.
