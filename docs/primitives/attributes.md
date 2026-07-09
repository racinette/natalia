# Attributes

## What it is

An **attribute** is a named, schema-typed, **observable single current value** bound to one workflow instance. The body **overwrites** it as state advances; external observers **read** the current value or long-poll for the next change. It is the “latest value” member of the per-instance family: channels are inbound, streams are outbound append-only logs, events are write-once flags, and an attribute is a **mutable single value**—the current progress, the current phase, the current revision.

```typescript
attributes: { progress: z.object({ percent: z.number(), phase: z.enum(["queued", "running", "done"]) }) }
```

Inside the body you **set** an attribute (`ctx.attributes.progress.set(...)`); you never read it back. From outside, a handle holder **gets** it: the current value plus a monotonically increasing **version**, or long-polls for a value newer than one they have already seen.

## Why it exists

Long-running work usually has *one current fact* an observer cares about—how far along it is, what phase it is in, which document revision is live. Modelling that with a stream forces every reader to scan to the tail to find “now,” and retains a full history nobody asked for. Modelling it with an event is impossible, because the value changes. The attribute is the primitive that fits: **last-write-wins**, no history, cheap to read, cheap to watch.

Each `set` **replaces** the prior value and bumps the version. External observers can pass the last version they saw and block until something newer is written, which gives a clean long-poll without busy-waiting and without a thundering herd. When the workflow terminates, observers waiting for a newer value are released with a terminal `never` result, so a watcher never hangs after the instance is gone.

Contrast with its neighbors:

- **vs. streams (append-only):** a stream is an ordered log; earlier offsets are immutable history. An attribute keeps **only the latest value**—each set discards the prior. If you care about the sequence of changes, use a stream; if you care about the current value, use an attribute.
- **vs. events (write-once):** an event is a valueless latch set at most once. An attribute is multi-write and carries a typed payload plus a version.
- **vs. channels (inbound):** a channel delivers messages *into* the body; an attribute flows the current value *out* to observers.

## What it is NOT

- **Not** append-only history: there are no offsets and no past values—only the current value and its version. For a timeline, use a **stream**.
- **Not** readable from inside the workflow body: attributes are **set-only** internally. The body is the writer; it does not consult its own attributes.
- **Not** writable from outside: external callers **read** (`get` / `getNowait`); they do not set. The body is the only writer.
- **Not** write-once or valueless—that is an **event**.
- **Not** shared across instances: each attribute is keyed to a single instance’s row. Cross-instance fan-out is a **topic**.

## Examples

**Declaring an attribute and setting it from the body**

```typescript
const indexingRun = defineWorkflow({
  name: "indexing-run",
  args: z.undefined(),
  attributes: {
    progress: z.object({
      percent: z.number(),
      phase: z.enum(["queued", "running", "done"]),
    }),
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.attributes.progress.set({ percent: 0, phase: "queued" }); // void, buffered, not awaited
    // … work …
    ctx.attributes.progress.set({ percent: 0.5, phase: "running" });
    // … work …
    ctx.attributes.progress.set({ percent: 1, phase: "done" });
    return { ok: true };
  },
});
```

**Reading the current value from a handle (non-blocking)**

Operator snapshot reads run inside `client.session`:

```typescript
await client.session(async (session) => {
  const now = await handle.attributes.progress.getNowait(session);
  if (now.status === "ok") {
    // now.value.percent, now.version
  } else {
    // now.status === "not_set" — never written
  }
});
```

**Long-polling for the next change**

Pass the last version you observed; the call blocks until a newer value is written, or the workflow terminates. Watch IO does not take a session — pass `signal` only:

```typescript
const result = await handle.attributes.progress.get({ afterVersion: 3, signal });
if (result.status === "ok") {
  // result.version > 3, result.value is the newer value
} else {
  // result.status === "never" — the workflow ended; no newer value will arrive
}
```

**Setting an attribute from a compensation block**

A step’s `compensation` block can declare and write its own attributes to make rollback progress observable. These live in the compensation block’s own namespace, separate from the workflow body’s attributes.

```typescript
const chargeCard = defineStep({
  name: "chargeCard",
  args: z.object({ customerId: z.string(), amount: z.number() }),
  result: z.object({ chargeId: z.string() }),
  compensation: {
    attributes: { undoProgress: z.object({ percent: z.number() }) },
    async undo(ctx, args, info) {
      ctx.attributes.undoProgress.set({ percent: 0.5 });
      // …
    },
  },
  async execute(args, { signal }) {
    // …
  },
});
```
