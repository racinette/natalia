# Streams

## What it is

Treat each **running workflow instance** as the sole owner of its execution state. **Streams** are **named, typed, append-only logs** attached to that instance. While the workflow runs, its body **appends records** in a fixed order; later, **readers** that hold an appropriate **handle** can walk or jump within that history. Nothing about a stream write reaches back into the workflow’s private variables: it only extends the public tape for that instance and stream name.

Inside `execute` you record facts with `ctx.streams.<name>.write(...)`. Outside, consumers use the handle’s `streams.<name>` reader (`read` by offset, `iterator`, async iteration—per your client surface). Replays reproduce the same sequence of writes in the same order, so the tape is part of the durable story of the run.

## Why it exists

Long-running work often needs a **durable, ordered transcript**—training metrics, audit lines, token chunks, deployment steps—without exposing the whole internal state machine. Streams give that transcript a first-class name and schema per instance, so operators, UIs, and integrations can follow progress **after the fact** or **while it is still running**, using the same ordering guarantees the engine relies on for replay. The mental model is intentionally close to **Kafka’s commit log**: producers append in order, consumers read by offset—only here the “partition” is scoped to **this** workflow instance rather than a shared cluster topic.

## What it is NOT

- **Not** in-place edits: you only **append**; earlier offsets are history, not cells you rewrite.
- **Not** request/response: `write` does not carry back an answer from whoever reads the stream.
- **Not** one global tape shared by every instance: each instance owns its own partitions for the stream names you declared.
- **Not** a single “latest value” abstraction: if you only care about one current field and how it changes, you're looking for an `attributes` instance; streams are for **ordered sequences** of records.

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
  ctx.streams.metrics.write({ step: 0, loss: 1.0 });
  ctx.streams.audit.write({ at: new Date(ctx.timestamp).toISOString(), message: "started" });
}
```

**Random access read from a handle** (offset is per stream; result tells you `received` vs end / missing)

```typescript
const got = await runHandle.streams.metrics.read(0);
if (got.ok && got.status === "received") {
  const { step, loss } = got.data;
}
```

**Iterating from a handle**

```typescript
for await (const row of runHandle.streams.metrics) {
  // each appended record, in order
}
```
