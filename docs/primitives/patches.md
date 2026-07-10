# Patches

## What it is

A **patch** is a named, deterministic **branch point** you declare on a workflow so you can change a durable body without breaking the histories that are already in flight. You list patches on the definition, then read one in the body with `await ctx.patches.<name>`—which resolves to a `boolean`—and take the new code path or the legacy one accordingly.

```typescript
patches: { antifraud: true, legacyRetry: false }
```

The boolean **in the definition** is the **rollout state** of the patch, not a per-instance value:

- **`true` — active.** New executions take the patched (new) code path.
- **`false` — deprecated.** New executions take the legacy path, but histories that already entered the patched branch keep replaying it.

The boolean you read in the body (`await ctx.patches.antifraud`) is the **recorded decision** for *this* instance: the engine persists each patch check, so replay observes the same answer it observed the first time.

## Why it exists

Workflow bodies are **durable and replayed**: the engine requires that replaying the same code reaches the same recorded operations, in the same order, observing the same recorded results. That guarantee is what makes a half-finished workflow resumable—but it is also what makes naive edits dangerous. Change the body of a workflow that has live instances, and replay can diverge from the recorded history, breaking the instance.

A patch is the escape hatch. It turns “I edited the code” into a **recorded, deterministic decision**: a brand-new execution sees the patch as active and runs the new branch; an old history that already committed the legacy branch continues down the legacy branch on replay. Both replay deterministically because the decision was written into history at the patch check, not re-derived from the current source.

The intended **lifecycle** is three-step:

1. **Introduce** the patch as `true`. New runs adopt the new behavior; in-flight runs keep their recorded decision.
2. **Deprecate** to `false` once no live history still needs the legacy branch. New runs stop taking the patched path.
3. **Remove** the patch and the legacy branch entirely when nothing references it.

## What it is NOT

- **Not** “patch + replay,” the operator workflow for resolving a halt by deploying fixed code and replaying. That reuses the word *patch* for a redeploy-and-resume operation; the `ctx.patches` primitive is a versioning gate inside the body. Keep them distinct.
- **Not** a per-instance runtime flag you toggle from a client or set from inside the body. The accessor is **read-only**—there is no setter. The definition boolean is the only control surface, and it governs rollout, not individual instances.
- **Not** a suspending or dispatched operation. Reading a patch is an **awaitable read**: it flushes the buffer, then resolves immediately with a boolean. It does not wait on anything external.
- **Not** schema-typed like channels, streams, attributes, or events. Patch values are plain booleans.

## Examples

**Declaring patches**

```typescript
const flight = defineWorkflow({
  name: "flight",
  args: z.object({ flightId: z.string() }),
  metadata: z.undefined(),
  result: z.void(),
  patches: {
    antifraud: true,    // active: new runs take the patched path
    legacyRetry: false, // deprecated: only replaying histories take it
  },
  steps: { fraudCheck },
  async execute(ctx) {
    // …
    return undefined;
  },
});
```

**Branching on a patch in the body**

```typescript
if (await ctx.patches.antifraud) {
  const result = await ctx.join(ctx.steps.fraudCheck({ flightId: ctx.args.flightId }));
  // new behavior, only on executions started after the patch went active
} else {
  // legacy path, preserved for histories already in flight
}
```

**Reading a patch inside a scope**

The accessor is available wherever the body runs, including inside a `ctx.scope` callback:

```typescript
await ctx.scope("checkout", { /* entries */ }, async (ctx, handles) => {
  if (await ctx.patches.antifraud) {
    // new
  } else {
    // legacy
  }
});
```

> **Note on replay semantics.** The *intent*—new runs follow the definition boolean, in-flight histories keep their recorded decision—is the contract. The precise engine rule for how flipping a patch from `true` to `false` interacts with a replaying instance that has *not yet* reached the patch check is governed by the execution model rather than this primitive’s surface; treat the lifecycle above as the authoritative behavior to design against.
