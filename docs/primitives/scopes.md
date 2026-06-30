# Scopes

## What it is

A **scope** is the **structured-concurrency boundary** inside a workflow body. You open one with `ctx.scope(name, entries, callback)`: a **named** scope, a **top-level object of dispatched entries** (steps, requests, child workflows—singly, in arrays/tuples, or in maps), and an inline async **body** that runs with a typed mirror of those entries as **handles**. The body observes outcomes selectively with `ctx.join` (and iterates completions with `ctx.match`); the scope **owns the lifecycle** of everything dispatched into it for the duration of that body.

```typescript
await ctx.scope(
  "fan-out",
  {
    normalize: ctx.steps.normalize({ orderId }),
    approval: ctx.requests.approval({ orderId }),
  },
  async (ctx, handles) => {
    const normalized = await ctx.join(handles.normalize);
    const approval = await ctx.join(handles.approval);
    return { normalized, approval };
  },
);
```

The body itself stays a single sequential script—concurrency exists **between** the dispatched entries, not inside the body. `ctx.scope(...)` returns an **awaitable entry** whose value is the body’s return value, so a scope composes like any other entry: you can `await` it, or nest it inside another scope.

## Why it exists

Workflow bodies are durable and replayed, so concurrency must have **bounded lifetime and deterministic structure**—otherwise it could not be recorded and replayed identically, and children could be orphaned across a crash. A scope gives dispatched work a structural owner: nothing escapes the scope, and the convenience combinators **compensate entries left unconsumed** rather than leaking them.

The **name** is load-bearing. It contributes to a **scope path**—the ordered lineage of scope names—used for determinism and introspection, and it guards against accidental reuse: a literal scope name that collides with an ancestor’s name is a **compile error**. (Widening a name to `string` is allowed but forfeits that check.)

Structured concurrency also clarifies **observation vs. lifecycle**. Joining an entry observes its outcome; it does not, by itself, cancel anything. A join timeout tells you “I gave up waiting,” not “the work is dead”—you can join the same handle again later. The scope, not the individual join, is what bounds the work.

## The surface

### `ctx.scope(name, entries, callback)`

- **`name`** — a string literal. Reusing an ancestor scope’s literal name fails to type-check.
- **`entries`** — a top-level **object** whose properties are dispatched entries, or arrays/tuples of entries, or maps of entries. Plain async closures and detached/foreign handles are **rejected**; the entries must be joinable.
- **`callback(ctx, handles)`** — the body. It receives a scope-scoped context (the full workflow context minus `schedule`, with the scope path extended) and **`handles`**, a structural mirror of `entries` where each entry becomes a handle you can `join`.
- **Returns** `AwaitableEntry<R>`, where `R` is the body’s return type.

### `ctx.join(handle, opts?)`

Observe one handle’s outcome.

- A **step** or **request** handle joins to its success payload directly (or a success-or-timeout union if that entry was dispatched with `{ timeout }`).
- A **child workflow** handle joins to `{ ok: true; result } | { ok: false; status: "failed"; error }`.
- Passing `{ timeout }` to `join` adds `{ ok: false; status: "join_timeout" }`—an **observation** timeout that does not cancel, fail, or compensate the underlying work. You may join the same handle again afterward.

There are **two distinct timeouts**, and they compose. A **join timeout** (`ctx.join(handle, { timeout })`) bounds *your wait* and leaves the entry running. An **execution deadline**, set at the entry’s own call site (e.g. `ctx.childWorkflows.X(args, { deadlineSeconds })`), bounds *the work itself*: when it fires the entry is terminated and settles as `{ ok: false; status: "timeout" }`. A single join can surface either, and they are distinguishable by status (`"timeout"` vs `"join_timeout"`).

### Convenience combinators

Each takes a scope name and a top-level entry object, dispatches them, and resolves an aggregate. They are awaitable entries in their own right.

- **`ctx.all(name, entries)`** — wait for **every** entry. Resolves `{ ok: true; result }` (the input structure with each entry replaced by its success value) or `{ ok: false; error }` (`SomeEntriesFailed`, carrying the keyed failures and completions).
- **`ctx.first(name, entries)`** — the **first** entry to complete, keyed. Resolves `{ ok: true; result }` (a single `{ key, value }`) or `{ ok: false; error }` (`NoEntryCompleted`).
- **`ctx.atLeast(name, count, entries)`** — a **quorum**. Resolves `{ ok: true; result }` (at least `count` keyed successes) or `{ ok: false; error }` (`QuorumNotMet`, with `required`/`got`/failures/completions).
- **`ctx.atMost(name, count, entries)`** — up to `count` successes; **no failure case** (resolves a keyed-success array). Entries left unconsumed are **compensated**.
- **`ctx.some(name, entries)`** — whatever succeeds; **no failure case** (resolves a keyed-success array).

`first` and `atMost` are the helpers that explicitly **compensate** entries the result did not consume—the structured-concurrency guarantee that surplus work is rolled back rather than orphaned.

An entry that hits its own **execution deadline** settles as a failure, so it is treated like any other failed entry: in `all` / `atLeast` it lands in the failure bucket (`SomeEntriesFailed` / `QuorumNotMet`), and in `first` it does **not** count as a completion.

### `ctx.match(handles)`

An async iterable of completions, **keyed** by top-level property. Tuple entries carry an `index`; map entries carry a `mapKey`. Use it to react to entries as they finish, in completion order, instead of joining each by hand. (`match` has no handler-map form; it is purely an iterable.)

## What it is NOT

- **Not** a thread spawner: the body is sequential. Only the dispatched entries run concurrently.
- **Not** a place for arbitrary async work: inline closures are not valid scope entries, and neither are `externalWorkflows` starts (an `ExternalWorkflowHandle` is send-only, not joinable).
- **Not** a separate error mode: the scope body uses the workflow’s own `ctx.errors`; there is no scope-local failure channel.
- **Not** a cancellation mechanism via `join`: a join timeout is observation-only.

## Examples

**Basic scope: dispatch, join, return**

```typescript
const result = await ctx.scope(
  "fan-out",
  {
    normalize: ctx.steps.normalize({ orderId }),
    approval: ctx.requests.approval({ orderId }),
  },
  async (ctx, handles) => {
    const normalized = await ctx.join(handles.normalize);
    const approval = await ctx.join(handles.approval, { timeout: 30 });
    if (!approval.ok) {
      // approval.status === "join_timeout" — the work is still running; we just stopped waiting
    }
    return normalized;
  },
);
```

**`ctx.all` — every entry, structure preserved**

```typescript
const all = await ctx.all("collect", {
  inventory: ctx.steps.reserveInventory({ sku }),
  pricing: ctx.steps.quote({ sku }),
});
if (all.ok) {
  all.result.inventory; // reserve result
  all.result.pricing; // quote result
} else {
  all.error.code; // "SomeEntriesFailed"
}
```

**`ctx.first` — race, keyed winner**

```typescript
const first = await ctx.first("race", {
  fast: ctx.steps.quote({ vendor: "a" }),
  slow: ctx.steps.quote({ vendor: "b" }),
});
if (first.ok) {
  first.result.key; // "fast" | "slow"
}
```

**Quorum: `atLeast` (failable) and `some` (best-effort)**

```typescript
const quorum = await ctx.atLeast("acks", 2, {
  a: ctx.steps.replicate({ node: "a" }),
  b: ctx.steps.replicate({ node: "b" }),
  c: ctx.steps.replicate({ node: "c" }),
});
if (!quorum.ok) {
  quorum.error.code; // "QuorumNotMet" — details.required / got / failures
}

const best = await ctx.some("gather", {
  a: ctx.steps.fetch({ src: "a" }),
  b: ctx.steps.fetch({ src: "b" }),
}); // keyed-success array, no failure case
```

**Messaging a child workflow while it runs**

Inside a scope, a child-workflow entry’s handle gains a `channels.<name>.send(...)` surface—the only way to message a child workflow mid-flight. This is the relay pattern: the parent receives on its own channel and forwards onto the child’s.

```typescript
await ctx.scope(
  "cancelable-order",
  { order: ctx.childWorkflows.processOrder({ orderId: "o-1" }) },
  async (ctx, { order }) => {
    const fromOutside = await ctx.channels.operatorCancel.receive();
    order.channels.cancel.send({ reason: fromOutside.reason });
    return ctx.join(order);
  },
);
```

**Iterating completions with `ctx.match`**

```typescript
await ctx.scope(
  "quotes",
  { quotes: [ctx.steps.quote({ vendor: "a" }), ctx.steps.quote({ vendor: "b" })] },
  async (ctx, handles) => {
    for await (const event of ctx.match(handles)) {
      // event.key === "quotes"; tuple entries carry event.index
    }
  },
);
```
