# Compensation Reformation — A Vision Document for the Next Iteration of `NEW_PRIMITIVES.MD`

## 0. Framing

`NEW_PRIMITIVES.MD` is a buffer of changes against the current codebase. This document is a **second buffer**: a reformation of the compensation portions of `NEW_PRIMITIVES.MD` itself. The "before" snippets below quote `NEW_PRIMITIVES.MD` as it currently stands; the "after" snippets sketch where the reformation lands. Once folded in, `NEW_PRIMITIVES.MD` remains the authoritative document and this one is retired.

The reformation is concentrated in: Part 2 (compensation model), Part 3 (halt model — compensation half), Part 4 (error model — compensation half), Part 5 (chain ordering), Part 6 (context splitting), Part 8 (database schema — compensation tables), Part 11 (requests — compensation handler shape), Part 13 (attributes — handle exposure for per-instance attributes), Part 18 (`defineStep` shape), and the Summary tables. Parts 1, 7, 9, 10, 12, 14–17, and the execution-side passages of Parts 3 and 4, are conceptually untouched.

## 1. The Driving Insight

Every primitive in `NEW_PRIMITIVES.MD` is constructed against the goal of making invalid states unrepresentable. Compensation is the lone holdout: a compensation block is currently an inline closure registered against a step or workflow call, and JavaScript's lexical-scope semantics let that closure read execution-side bindings, mutate them, and accidentally couple itself to in-flight workflow state. The semantic guarantee the engine provides (separate VELs, separate state) is invisible at the call site.

The canonical "before" — straight from `compensation-hooks.example.ts` — is a closure that reads outer-scope `args`:

```typescript
async execute(ctx, args) {
  await ctx.steps
    .bookFlight(args.destination, args.customerId)
    .compensate(async (ctx) => {
      // `args` here is captured from execute's lexical scope.
      // Anything else in scope — mutable counters, partial results,
      // intermediate computation — is just as freely reachable.
      const result = await ctx.steps
        .cancelFlight(args.destination, args.customerId)
        .retry({ maxAttempts: 15, intervalSeconds: 10 })
        .resolve(ctx);
    })
    .resolve(ctx);
}
```

The reformation begins from one observation: **the syntactic shape of compensation must reflect its semantic isolation**. Once that is taken seriously, a chain of follow-on simplifications becomes available, because much of the prior compensation surface existed to paper over the closure problem.

## 2. Compensation Becomes a Property of the Operation

Compensation stops being a separate first-class entity and becomes a **property** of the operation it undoes. A step *is or is not* compensable. A request *is or is not* compensable. There is no longer a `compensations` registry on the workflow, no longer a `.compensate(...)` builder method on call sites, no longer `ctx.registerCompensation(...)` or `ctx.compensateEagerly(...)` APIs. The compensation logic for a step lives inside that step's definition; the same applies to requests via a `compensation: true` flag on the request definition plus a separately-registered `client.registerRequestCompensationHandler(...)`.

The motivating intuition: **a single action has a single way to revert itself**. Allowing the call site to attach an arbitrary compensation per invocation invites two kinds of bugs — one call site forgets to attach the compensation (forgotten undo), or different call sites attach different compensations (inconsistent undo). Tying compensation to the step's definition closes both gaps. It also kills the structural-compatibility-of-schemas problem an earlier iteration of this discussion struggled with: there are no two schemas to reconcile, only one — the step's own.

### Type sketch

```typescript
interface CompensableStepDefinition<TArgs, TResult, TCompPrim, TCompDeps, TCompResult = void> {
  name: string;
  args: TArgs;                        // JsonSchemaConstraint
  result: TResult;                    // JsonSchemaConstraint
  execute: (
    ctx: { signal: AbortSignal },
    args: InferOutput<TArgs>,
  ) => Promise<InferInput<TResult>>;
  retryPolicy?: RetryPolicyOptions;
  compensation: StepCompensation<TArgs, TResult, TCompPrim, TCompDeps, TCompResult>;
}

interface StepCompensation<TArgs, TResult, TPrim, TDeps, TCompResult> {
  // Per-instance primitives — each invocation gets its own private set.
  channels?:   { [name: string]: JsonSchemaConstraint };
  streams?:    { [name: string]: JsonSchemaConstraint };
  events?:     { [name: string]: true };
  attributes?: { [name: string]: JsonSchemaConstraint };

  // Declared dependencies — namespaces filtered by IsStepCompensable / IsRequestCompensable (see §9).
  steps?:          { [name: string]: NonCompensableStepDefinition };
  requests?:       { [name: string]: NonCompensableRequestDefinition };
  queues?:         { [name: string]: QueueDefinition };
  topics?:         { [name: string]: TopicDefinition };
  childWorkflows?: { [name: string]: WorkflowDefinition };

  // Optional outcome schema. Default: void.
  result?: TCompResult;

  undo: (
    ctx:  CompensationContext<TPrim, TDeps>,
    args: InferOutput<TArgs>,
    info: CompensationInfo<InferOutput<TResult>>,
  ) => Promise<InferInput<TCompResult>>;
}
```

The signature `undo(ctx, args, info)` separates the two distinct things compensation cares about:

- **`args`** — the original input. Always present, never status-dependent. For most undos, this is enough to do the job (e.g., "cancel this hotel reservation by guest details").
- **`info`** — the engine-level outcome of the step. Only consulted when the undo logic actually needs to branch on what happened (success vs. uncertain attempt). See §3.

### Before

```typescript
const bookHotel = defineStep({
  name: "bookHotel",
  args: z.object({ /* ... */ }),
  result: z.object({ confirmationId: z.string() }),
  execute: async ({ signal }, args) => { /* ... */ },
});

await ctx.steps
  .bookHotel(args)
  .timeout({ maxAttempts: 3 }, () => null)
  .compensate(async (ctx, result) => {
    if (result.status !== "complete") return;
    await ctx.steps
      .cancelHotelStep({ confirmationId: result.data.confirmationId })
      .resolve(ctx);
  })
  .resolve(ctx);
```

### After — minimal shorthand

When the `result` of the completed step carries the id you need, the undo is a single line. No per-instance primitives, no dependency declarations beyond the cancel step.

```typescript
const cancelHotelStep = defineStep({
  name: "cancelHotelStep",
  args: z.object({ confirmationId: z.string() }),
  result: z.void(),
  execute: async ({ signal }, args) => { /* ... */ },
});

const bookHotel = defineStep({
  name: "bookHotel",
  args: z.object({
    firstName: z.string(),
    lastName:  z.string(),
    checkIn:   z.string(),
    checkOut:  z.string(),
  }),
  result: z.object({ confirmationId: z.string() }),
  execute: async ({ signal }, args) => {
    return { confirmationId: await hotelAPI.book(args, { signal }) };
  },

  compensation: {
    steps: { cancelHotelStep },
    undo: async (ctx, args, info) => {
      if (info.status === "completed") {
        // We have the confirmationId — cancel directly.
        await ctx.steps.cancelHotelStep({
          confirmationId: info.result.confirmationId,
        }).resolve(ctx);
        return;
      }
      // Uncertain outcomes are handled in §3's expanded example.
    },
  },
});
```

The call site loses `.compensate(...)` entirely:

```typescript
await ctx.steps.bookHotel(args).resolve(ctx);
// No .compensate(...). The compensation is part of bookHotel's definition.
```

## 3. The Compensation Outcome Doctrine

The `info` parameter to `undo` describes the engine's view of *what happened to the forward step*. It is independent of `args`, which is always present.

```typescript
type CompensationInfo<TResult> =
  | { readonly status: "completed";  readonly result: TResult;
      readonly attempts: AttemptAccessor }
  | { readonly status: "timed_out";  readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: AttemptAccessor }
  | { readonly status: "terminated", readonly attempts: AttemptAccessor };
```

A critical correction over the prior iteration of this document: **`timed_out` and `terminated` do not mean "no work was done."** They mean "the engine never observed completion." Whether the side effect actually occurred is a separate, often unknowable, question.

The canonical example: a flaky third-party API. The workflow POSTs to `/reservations`. The remote service writes the row to its database, then crashes while serialising the response (invalid JSON in some optional field). The HTTP client gets a 500. The engine retries. Eventually the boundary fires and `info.status` is `"timed_out"`. **The reservation almost certainly exists.** Returning early on `timed_out` would leave a dangling booking forever.

The defensive posture for compensation is therefore: "every attempt that reached the I/O boundary is a candidate for having succeeded." Compensation has to look. The `attempts` accessor is the tool:

```typescript
type CompensationInfo<TResult> = /* as above */;

interface AttemptAccessor {
  count(): Promise<number>;
  list(opts?: { offset?: number; limit?: number }): Promise<readonly Attempt[]>;
  // ... (Part 15 — unchanged)
}
```

The `terminated` status means that while the step was running, the workflow was killed.

If a step has never been attempted to be executed (the engine hasn't had the chance to), **the compensation won't run**. 

### Expanded example — completed shorthand + timed-out lookup

Now the example uses the `findHotelReservation` lookup *only* on the path where it is genuinely needed: the timed-out branch where we don't have a `confirmationId` and at least one attempt may have succeeded silently.

```typescript
const findHotelReservation = defineStep({
  name: "findHotelReservation",
  args: z.object({
    firstName: z.string(),
    lastName:  z.string(),
    checkIn:   z.string(),
    checkOut:  z.string(),
  }),
  result: z.union([z.object({ confirmationId: z.string() }), z.null()]),
  execute: async ({ signal }, args) => { /* ... */ },
});

const bookHotel = defineStep({
  // ... args, result, execute as in §2 ...

  compensation: {
    steps: { findHotelReservation, cancelHotelStep },
    undo: async (ctx, args, info) => {
      if (info.status === "completed") {
        await ctx.steps
          .cancelHotelStep({ confirmationId: info.result.confirmationId })
          .resolve(ctx);
        return;
      }

      if (info.status === "terminated") {
        // The step never ran. Nothing to undo.
        return;
      }

      // info.status === "timed_out".
      // At least one attempt was made — the booking may exist on the remote
      // side even though we never got a confirmation. Look it up by guest
      // details and cancel if found.
      const attemptCount = await info.attempts.count();
      if (attemptCount === 0) return;  // boundary fired before any I/O — safe to skip.

      const found = await ctx.steps
        .findHotelReservation(args)
        .timeout({ maxAttempts: 5 }, () => null)
        .resolve(ctx);

      if (found === null) return;  // genuinely no booking exists.

      await ctx.steps
        .cancelHotelStep({ confirmationId: found.confirmationId })
        .resolve(ctx);
    },
  },
});
```

## 4. Compensation Block Instances as First-Class Entities

While compensation is *defined* as part of a step, each *invocation* of compensation produces a distinct, durable, externally-observable **compensation block instance**. The instance is the entity. It has its own per-instance primitive state — channels, streams, events, attributes declared on the step's `compensation` field. Two invocations of `bookHotel` produce two compensation block instances when their compensations run, each with its own private state, each addressable independently, each settling independently.

This per-instance materialisation is what makes the model honest. Without it, the "isolation" of compensation is only nominal — two invocations of the same compensation would share state and we would be back where we started. With it, every undo is a self-contained durable object. There is no shared scratch space between two cancellations of two different hotels; if they need to coordinate, they must do so via global primitives (queues, topics, requests), which forces the coordination to be explicit and typed.

### Before

Compensation primitives in `NEW_PRIMITIVES.MD` today are workflow-level. Channels declared on `defineWorkflow.compensation` are shared among *all* compensation closures that ever run. The current example demonstrates the limitation directly:

```typescript
defineWorkflow({
  compensation: {
    channels: {
        operatorResolution: OperatorResolution,
    },
  },
  // ...
  async execute(ctx, args) {
    await ctx.steps.bookFlight(...).compensate(async (ctx) => {
      for await (const r of ctx.channels.operatorResolution) { /* ... */ }
    }).resolve(ctx);

    await ctx.steps.bookHotel(...).compensate(async (ctx) => {
      // Same channel. If both compensations run, they race on every message.
      for await (const r of ctx.channels.operatorResolution) { /* ... */ }
    }).resolve(ctx);
  },
});
```

There is no way for an external operator to address one compensation specifically.

### After — a compensation that genuinely uses every declared primitive

The "uncertain timed-out" path needs human input when an automatic lookup is ambiguous. Each declared primitive has a real, distinct purpose:

- `attributes.lookupSummary` — the latest assessment of "what we know so far," readable by the dashboard.
- `streams.audit` — a tail-able log the operator can follow live.
- `channels.operatorDecision` — the operator's binding decision, sent to *this instance* specifically.
- `events.compensationSettled` — fires once, the moment this instance reaches a terminal outcome; external observers can `wait` on it.

```typescript
const OperatorDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm-no-booking") }),
  z.object({ action: z.literal("cancel-by-id"), confirmationId: z.string() }),
]);

const bookHotel = defineStep({
  // ... args, result, execute as before ...

  compensation: {
    attributes: {
      lookupSummary: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("waiting") }),
        z.object({ kind: z.literal("found"), confirmationId: z.string() }),
        z.object({ kind: z.literal("not-found") }),
        z.object({ kind: z.literal("ambiguous"), candidates: z.array(z.string()) }),
      ]),
    },
    streams: {
      audit: z.object({ msg: z.string(), ts: z.number() }),
    },
    channels: {
      operatorDecision: OperatorDecision,
    },
    events: {
      compensationSettled: true,
    },

    steps: { findHotelReservation, cancelHotelStep },

    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("compensated"), confirmationId: z.string() }),
      z.object({ kind: z.literal("verified-no-op") }),
      z.object({ kind: z.literal("operator-confirmed") }),
    ]),

    undo: async (ctx, args, info) => {
      const settle = <T extends { kind: string }>(value: T): T => {
        ctx.events.compensationSettled.set();
        return value;
      };

      ctx.streams.audit.write({ msg: `undo started (${info.status})`, ts: ctx.timestamp });

      if (info.status === "completed") {
        ctx.attributes.lookupSummary.set({
          kind: "found", confirmationId: info.result.confirmationId,
        });
        await ctx.steps
          .cancelHotelStep({ confirmationId: info.result.confirmationId })
          .resolve(ctx);
        return settle({ kind: "compensated", confirmationId: info.result.confirmationId });
      }

      // info.status === "timed_out" — uncertain.
      ctx.attributes.lookupSummary.set({ kind: "waiting" });

      const found = await ctx.steps
        .findHotelReservation(args)
        .timeout({ maxAttempts: 5 }, () => null)
        .resolve(ctx);

      if (found === null) {
        ctx.attributes.lookupSummary.set({ kind: "not-found" });
        ctx.streams.audit.write({ msg: "no reservation found", ts: ctx.timestamp });
        return settle({ kind: "verified-no-op" });
      }

      // Found something. We could just cancel it, but the safer pattern when
      // the booking system is known-flaky is to surface the candidate to an
      // operator and ask for confirmation.
      ctx.attributes.lookupSummary.set({
        kind: "found", confirmationId: found.confirmationId,
      });
      ctx.streams.audit.write({
        msg: `awaiting operator decision for ${found.confirmationId}`,
        ts: ctx.timestamp,
      });

      const decision = await ctx.channels.operatorDecision.receive();
      if (decision.action === "confirm-no-booking") {
        ctx.attributes.lookupSummary.set({ kind: "not-found" });
        return settle({ kind: "operator-confirmed" });
      }

      await ctx.steps
        .cancelHotelStep({ confirmationId: decision.confirmationId })
        .resolve(ctx);

      return settle({ kind: "compensated", confirmationId: decision.confirmationId });
    },
  },
});
```

Every declared primitive earns its place. The instance has a status (`pending | running | completed | halted | skipped`); membership and naming are provisional and may be refined during the public API design pass.

## 5. The Query-Grounding Handle Pattern

External callers need to address compensation block instances. The model deliberately mirrors how `WorkflowHandle` already works in the codebase: a handle is an **identity grounding** for subsequent queries, not a fetched record. Queries are evaluated lazily, against the database, when an actual operation is requested on the handle.

### Type sketch

```typescript
type CompensationBlockStatus =
  "pending" | "running" | "completed" | "halted" | "skipped";

declare const InstanceIdBrand: unique symbol;
type CompensationBlockInstanceId =
  string & { readonly [InstanceIdBrand]: "compensation_block" };

// All operations that reach the database return a discriminated result.
// "Nothing throws." Absence, singleton, ambiguity are explicit.
type FindUniqueResult<T> =
  | { readonly status: "unique"; readonly value: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly count: number };

interface CompensationBlockNamespace<TArgs, TResult, TPrim> {
  findUnique(query: (q: SearchQuery<{ args: TArgs; metadata: BlockMetadata }>) => SearchQueryNode):
    CompensationBlockUniqueHandle<TArgs, TResult, TPrim>;
  findUnique(id: CompensationBlockInstanceId):
    CompensationBlockUniqueHandle<TArgs, TResult, TPrim>;
  findMany(query: (q: SearchQuery<{ args: TArgs; metadata: BlockMetadata }>) => SearchQueryNode):
    CompensationBlockSubsetHandle<TArgs, TResult, TPrim>;
}
```

The unique handle exposes per-instance reads (only meaningful over a single row), and writes that fan out to one row. Naming for attributes/streams/events follows the established APIs (`attributes.X.get`/`getNowait` from Part 13, `streams.X.read`/`readNowait`/`tail` from Part 14, `events.X.wait` from the events part):

```typescript
interface CompensationBlockUniqueHandle<TArgs, TResult, TPrim> {
  status(): Promise<FindUniqueResult<CompensationBlockStatus>>;
  result(): Promise<FindUniqueResult<TResult | null>>;  // null while not yet completed
  args():   Promise<FindUniqueResult<TArgs>>;
  skip():   Promise<
    | FindUniqueResult<{ skipped: true }>
    | { readonly status: "already_terminal";
        readonly current: "completed" | "skipped" }
  >;

  attributes: {
    [K in keyof TPrim["attributes"]]: {
      // Identical shape to handle.attributes.X.get / getNowait from Part 13,
      // wrapped in FindUniqueResult to express absence/ambiguity at the row level.
      get(opts: { afterVersion?: number; signal?: AbortSignal }):
        Promise<FindUniqueResult<{ value: InferOutput<TPrim["attributes"][K]>; version: number }
                              | { status: "never" }>>;
      getNowait():
        Promise<FindUniqueResult<{ value: InferOutput<TPrim["attributes"][K]>; version: number }
                              | { status: "not_set" }>>;
    };
  };

  streams: {
    [K in keyof TPrim["streams"]]: {
      readNowait(opts?: { afterRecordId?: string; limit?: number }): Promise<...>;
      tail(opts?: { afterRecordId?: string; signal?: AbortSignal }): AsyncIterable<...>;
    };
  };

  events: {
    [K in keyof TPrim["events"]]: {
      wait(opts?: { signal?: AbortSignal }): Promise<FindUniqueResult<true | { status: "never" }>>;
    };
  };

  channels: {
    [K in keyof TPrim["channels"]]: {
      send(payload: InferInput<TPrim["channels"][K]>):
        Promise<FindUniqueResult<{ delivered: true }>>;
    };
  };
}
```

The subset handle deliberately omits per-instance reads — their meaning over multi-cardinality is undefined. It exposes only operations whose semantics are well-defined over `N >= 0` rows:

```typescript
interface CompensationBlockSubsetHandle<TArgs, TResult, TPrim> {
  count(): Promise<number>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{
    items: readonly {
      id: CompensationBlockInstanceId;
      status: CompensationBlockStatus;
      args: TArgs;
    }[];
    cursor: string | null;
  }>;
  skip(): Promise<{ affected: number }>;

  channels: {
    [K in keyof TPrim["channels"]]: {
      // Fan-out INSERT — one channel_message row per matched instance.
      send(payload: InferInput<TPrim["channels"][K]>):
        Promise<{ affected: number }>;
    };
  };
}
```

Forcing the caller to commit to a single instance for reads is intentional. It pushes ambiguity-handling to where it belongs: the predicate.

### Usage

```typescript
// "Bob's hotel cancellation is awaiting operator input. Tell it to cancel the candidate."
await workflowInstance.compensations.bookHotel
  .findUnique(q => q.args.firstName.eq("Bob"))
  .channels.operatorDecision.send({
    action: "cancel-by-id",
    confirmationId: "rsv_abc",
  });
// → { status: "unique"; value: { delivered: true } }
//   { status: "missing" }
//   { status: "ambiguous"; count: 3 }

// Dashboard polling.
const summary = await workflowInstance.compensations.bookHotel
  .findUnique(q => q.args.firstName.eq("Bob"))
  .attributes.lookupSummary.getNowait();
// → { status: "unique"; value: { value: { kind: "found"; ... }; version: 4 } }
//   { status: "missing" }
//   { status: "ambiguous"; count: 3 }

// "Skip every halted hotel-cancellation across this workflow."
const halted = workflowInstance.compensations.bookHotel
  .findMany(q => q.metadata.status.eq("halted"));
await halted.skip();   // → { affected: 7 }
```

## 6. Failure Semantics: Return, Don't Throw

In the prior iteration of `NEW_PRIMITIVES.MD`, the compensation context inherits a parallel `terminalErrors` mechanism. The reformation deletes this surface.

Throws are panic-shaped semantics in this library: nearly every primitive returns discriminated unions to be pattern-matched, and throws are reserved for the moral equivalent of Go's panic — replay divergence, halts, programmer error. With per-instance isolation, there is also nothing meaningful to terminate at compensation level — a single block instance can fail; that failure does not naturally cascade to anything else.

### Before

```typescript
defineWorkflow({
  compensation: {
    terminalErrors: {
      RefundFailed: z.object({ chargeId: z.string(), reason: z.string() }),
    },
  },
});

.compensate("cancel-booking", async (ctx, result) => {
  if (refundFailed) {
    throw ctx.terminalErrors.RefundFailed("Refund could not be processed", {
      chargeId: result.data.chargeId, reason: "...",
    });
  }
});

// Externally:
type CompensationFailureInfo<T> = ErrorValue<T>;
const failure = await handle.compensation.wait();
```

### After

`defineWorkflow.compensation` is gone. `ctx.terminalErrors` is gone from compensation contexts. A compensation reports its outcome as a typed return value via the optional `result` schema on its definition (see §4's example). Early `return` is the explicit short-circuit. Throws are reserved for halts (§7).

Aggregate workflow-level compensation status reads (`handle.compensation.wait()`, `CompensationFailureInfo`) are gone too. Per-instance reads via `findUnique(...).result()` and `findUnique(...).events.compensationSettled.wait()` (when defined by the step) replace them. If the developer wants an aggregate, they build it explicitly out of `findMany` counts.

## 7. Halts in Compensation Are Skippable

The execution VEL's halt semantics are unchanged: an unexpected exception in workflow code halts the workflow, and the only resolution paths are patch-and-replay or SIGKILL. There is no skip mechanism for execution halts because workflow code accumulates mutable in-memory state between durable steps; skipping would leave that state inconsistent.

In compensation, the situation is structurally different. With per-instance isolation, a halted block instance has no shared state to leave inconsistent. The other in-flight compensations are independent. The halt can therefore be **skipped**.

### Before

`NEW_PRIMITIVES.MD` Part 3:

> There is no "skip" mechanism. Skipping a halted block would leave state inconsistent — subsequent code may depend on mutations the skipped block was supposed to perform. **This applies equally to execution and compensation halts.**

### After

The Part 3 halt model forks. Execution halts remain unskippable. Compensation halts are skippable per-instance:

```typescript
// One stuck cancellation among many.
const halted = workflowInstance.compensations.bookHotel
  .findUnique(q => q.args.firstName.eq("Bob"));
const outcome = await halted.skip();
// → { status: "unique"; value: { skipped: true } }
//   { status: "missing" }
//   { status: "ambiguous"; count: number }
//   { status: "already_terminal"; current: "completed" | "skipped" }

// Bulk skip — fan-out UPDATE.
const allStuck = workflowInstance.compensations.bookHotel
  .findMany(q => q.metadata.status.eq("halted"));
await allStuck.skip();   // → { affected: number }
```

Implementation note (provisional): the Part 8 `halt` table likely splits into `workflow_halt` and `compensation_block_halt`, with the latter carrying a `skipped` status the former does not.

## 8. The Single Compensation VEL, Reframed

The two-VEL-per-workflow structure from Part 2 is preserved. There is one execution VEL and one compensation VEL per workflow. The compensation VEL still processes invocations as units of work in the established eager-FIFO + LIFO-unwind order. Mirror scopes still exist for unconsumed branches.

What changes is the *unit*: each unit of work in the compensation VEL spawns a compensation block instance with its own per-instance state. The VEL runs that instance's `undo` callback; the instance settles; the VEL takes the next unit. Halts on one instance no longer block the VEL because the skip mechanism allows administrative progress.

Step-record evolution:

```
ordinal 1: { type: "start_step",                       definition_name: "bookHotel" }
ordinal 2: { type: "register_compensation_instance",   definition_name: "bookHotel",
             instance_id: "cbi_..." }
ordinal 3: { type: "await_promise",                    promise_id: 42 }
-- timeout fires --
ordinal 4: { type: "promote_compensation_instance",    instance_id: "cbi_..." }
-- compensation VEL eagerly schedules cbi_... --
```

The `register_compensation` step type from Part 2 is replaced by `register_compensation_instance` (carries the instance id); the `eager_compensation` step type is replaced by `promote_compensation_instance` (references the instance id rather than a closure name). Both remain synchronous buffered operations.

## 9. Type-Level Discrimination Without a Separate Type

A step with a `compensation` field is a "compensable step." A request with `compensation: true` is a "compensable request." These are not separate type families; they are properties on the existing `StepDefinition` and `RequestDefinition` types, discoverable via type-level helpers:

```typescript
type IsStepCompensable<S>    = S extends { compensation: object } ? true : false;
type IsRequestCompensable<R> = R extends { compensation: true }   ? true : false;

type NonCompensableSteps<TSteps> = {
  [K in keyof TSteps as IsStepCompensable<TSteps[K]> extends true ? never : K]: TSteps[K];
};

type NonCompensableRequests<TRequests> = {
  [K in keyof TRequests as IsRequestCompensable<TRequests[K]> extends true ? never : K]: TRequests[K];
};
```

The reason for the distinction: **compensable operations cannot be invoked from inside a compensation `undo` callback**. Permitting recursion would unravel the per-instance isolation that makes everything else clean. The library refuses to model it.

### Before

`NEW_PRIMITIVES.MD` Part 6 says compensation closures see the full step namespace, including any step that itself attaches a compensation closure via `.compensate(...)`. With anonymous closures this is just sloppy; once compensation is intrinsic, it becomes a real semantic problem.

### After

The compensation context's `steps` and `requests` namespaces are filtered to non-compensable variants:

```typescript
interface CompensationContext<TPrim, TDeps> {
  steps:    { [K in keyof TDeps["steps"]]:    StepCallFactory<TDeps["steps"][K]> };
  requests: { [K in keyof TDeps["requests"]]: RequestCallFactory<TDeps["requests"][K]> };
  // ... queues, topics, childWorkflows, etc.

  // Per-instance primitives:
  channels:   { [K in keyof TPrim["channels"]]:   ChannelHandle<...> };
  streams:    { [K in keyof TPrim["streams"]]:    StreamHandle<...> };
  events:     { [K in keyof TPrim["events"]]:     EventHandle };
  attributes: { [K in keyof TPrim["attributes"]]: AttributeHandle<...> };

  // No terminalErrors. No compensations. No compensateEagerly. No registerCompensation.
  // No `.compensate(...)` on any call type.
}
```

`TDeps["steps"]` is constrained at the `defineStep` boundary to `{ [name: string]: NonCompensableStepDefinition }` — so `findHotelReservation` (no compensation) is allowed; `bookHotel` (has compensation) is not. The error surfaces at the `defineStep` call, not at use.

This restriction does *not* apply to child workflows. Each child workflow has its own internal compensation lifecycle; spawning one from inside compensation is fine.

## 10. Request Compensation: The Necessary Asymmetry

Steps are author-side definitions. Requests are different: a request's handler is registered separately via `client.registerRequestHandler(definition, fn, options)` on a worker, and may have *no handler at all* if the request is intended to be resolved manually. This is the entire point of the request primitive's distinction from the step primitive (Part 11, "Use cases" 1–4).

Request compensation inherits the asymmetry. The request's *definition* declares only the intent to be compensable (`compensation: true`); the actual undo logic, when it exists, is registered separately via `client.registerRequestCompensationHandler(definition, fn, options)`. And exactly as with the request itself, **it is acceptable for no compensation handler to exist** — the compensation invocation transitions to a manual-resolution state and an administrator resolves it from the admin panel. There is no engine-startup validation requiring a handler.

### Before

```typescript
const refundCharge = defineRequest({
  name: "refundCharge",
  request: z.object({ chargeId: z.string() }),
  response: z.object({ refundId: z.string() }),
});

await ctx.requests
  .refundCharge({ chargeId: "ch_1" })
  .timeout(60, () => null)
  .compensate(async (ctx, result) => { /* closure with all the §1 problems */ })
  .resolve(ctx);
```

### After — definition

```typescript
const refundCharge = defineRequest({
  name: "refundCharge",
  request: z.object({ chargeId: z.string() }),
  response: z.object({ refundId: z.string() }),
  compensation: true,    // renamed from `requiresCompensation` for consistency.
});
```

### After — handler registration

Modeled directly after `client.registerRequestHandler` (Part 11), with the same `({ signal }, payload)` callback shape, the same options-object structure, the same `MANUAL` sentinel for "I cannot resolve this; let an external actor handle it," and the same `onExhausted` fallback story. The only difference is the additional `info` parameter carrying the original request's outcome:

```typescript
type RequestCompensationInfo<TResponse> =
  | { readonly status: "completed";  readonly response: TResponse;
      readonly attempts: AttemptAccessor }
  | { readonly status: "timed_out";  readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: AttemptAccessor }
  | { readonly status: "terminated", attempts: AttemptAccessor };

declare function registerRequestCompensationHandler<TReq, TRes>(
  definition: RequestDefinition<TReq, TRes> & { compensation: true },
  handler: (
    ctx: { signal: AbortSignal },
    payload: InferOutput<TReq>,
    info: RequestCompensationInfo<InferOutput<TRes>>,
  ) => Promise<void | typeof MANUAL>,
  options: {
    maxConcurrent?: number;
    retryPolicy: {
      timeoutSeconds: number;
      maxAttempts?: number;
      totalTimeoutSeconds?: number;
      intervalSeconds?: number;
      backoffRate?: number;
      maxIntervalSeconds?: number;
    };
    onExhausted?: {
      callback: (
        ctx: { signal: AbortSignal },
        payload: InferOutput<TReq>,
        info: RequestCompensationInfo<InferOutput<TRes>>,
      ) => Promise<void | typeof MANUAL>;
      retryPolicy: { intervalMs: number; backoffRate?: number; maxIntervalMs?: number };
    };
  },
): Unsubscribe;
```

The same four use cases that `registerRequestHandler` supports apply directly to compensation handlers:

```typescript
// 1. Handler is the sole resolver — programmatic refund.
client.registerRequestCompensationHandler(
  refundCharge,
  async ({ signal }, payload, info) => {
    if (info.status === "terminated") return;
    // For timed_out, the original charge may or may not have gone through —
    // attempt the refund regardless; the gateway is idempotent on chargeId.
    await chargeAPI.refund(payload.chargeId, { signal });
  },
  { retryPolicy: { timeoutSeconds: 30, maxAttempts: 5, intervalSeconds: 5 } },
);

// 2. Handler resolves with manual fallback on exhaustion.
client.registerRequestCompensationHandler(
  refundCharge,
  async ({ signal }, payload, info) => { /* programmatic attempt */ },
  {
    retryPolicy: { timeoutSeconds: 30, maxAttempts: 3, intervalSeconds: 10 },
    onExhausted: {
      callback: async ({ signal }, payload, info) => {
        await notifyOpsTeam(payload, info, { signal });
        return MANUAL;   // an operator will mark it resolved from the admin panel.
      },
      retryPolicy: { intervalMs: 5000, backoffRate: 1.5, maxIntervalMs: 60_000 },
    },
  },
);

// 3. Check-or-wait — return MANUAL directly when compensation must wait for
//    an external event (e.g., a webhook confirming the partner's refund cleared).
client.registerRequestCompensationHandler(
  refundCharge,
  async ({ signal }, payload, info) => {
    const status = await chargeAPI.checkRefund(payload.chargeId, { signal });
    if (status.refunded) return;
    return MANUAL;
  },
  { retryPolicy: { timeoutSeconds: 10, maxAttempts: 3, intervalSeconds: 30 } },
);

// 4. Full external resolution — no compensation handler registered at all.
//    The compensation invocation enters manual mode immediately. An operator
//    sees "compensation pending: refundCharge / chargeId=ch_123" in the admin
//    dashboard, calls the partner manually, and resolves it.
//    (No code at all.)
```

The `MANUAL` sentinel reuses Part 11's existing module-level export. Resolution from outside reuses the existing pattern (`client.requests.<name>.resolve(...)` or its compensation analogue) — exact API surface is provisional and to be settled during the public API design pass.

A discussion item still open: should request compensation invocations be **lightweight** (stateless worker handler, no per-instance primitives, no `findUnique`/`findMany` surface) or **heavyweight** (per-instance entities with declared primitives, like step compensations)? Lightweight is simpler and probably right for v1. Heavyweight buys consistency with step compensations.

The call site, in either case, loses `.compensate(...)`:

```typescript
await ctx.requests
  .refundCharge({ chargeId: "ch_1" })
  .timeout(60, () => null)
  .resolve(ctx);
```

## 11. The Chain Simplifies

With `.compensate(...)` removed from all call types, and `WorkflowCall.compensate` removed because child workflows manage their own compensation lifecycles, the chain ordering rationale that occupied much of Part 5 collapses. The Part 5 prose about `.compensate` as a "hard fence," about callback type stability under chain reordering, about the careful interaction between `.timeout` / `.failure` / `.compensate` — all removed.

### Before

```
StepCall:     (.retry)? → (.timeout)? → (.compensate)? → (.complete)? → .resolve
WorkflowCall: (.retry)? → (.timeout)? → .failure → (.compensate)? → (.complete)? → .resolve
RequestCall:  (.priority)? → (.timeout)? → (.compensate)? → (.complete)? → .resolve
```

with elaborate `Called` bookkeeping locking out `.retry`/`.timeout`/`.failure` after `.compensate`.

### After

```
StepCall:     { .retry?, .timeout?, .complete? }     in any order → .resolve
WorkflowCall: { .retry?, .timeout?, .failure }       — .failure mandatory; .complete? — in any order → .resolve
RequestCall:  { .priority?, .timeout?, .complete? }  in any order → .resolve
```

```typescript
// Both equivalent — same final type:
ctx.steps.bookHotel(args).timeout(60, () => null).complete(r => r.confirmationId).resolve(ctx);
ctx.steps.bookHotel(args).complete(r => r.confirmationId).timeout(60, () => null).resolve(ctx);
```

`.complete(cb)` is kept (the user's call); the order constraint between `.timeout` and `.complete` is dropped because nothing depends on it any more.

## 12. What Disappears

| Surface | Before (`NEW_PRIMITIVES.MD` today) | After |
| --- | --- | --- |
| Compensation closure API | `.compensate(cb)`, `.compensate(name, cb)` on `StepCall`, `WorkflowCall`, `RequestCall` | Removed. Compensation lives in `defineStep.compensation` / `defineRequest.compensation: true` |
| Standalone registration | `ctx.registerCompensation(name, cb)`, `ctx.compensateEagerly(name, cb)` | Removed |
| Workflow-level compensation primitives | `defineWorkflow.compensation: { terminalErrors }` | Removed. Per-instance primitives live on `defineStep.compensation` |
| Compensation hooks | `beforeCompensate`, `afterCompensate` on `defineWorkflow` | Removed. Orchestration lives in the relevant compensable step's `undo` |
| Compensation outcome (external aggregate) | `CompensationFailureInfo<T>`, `handle.compensation.wait()` | Removed. Per-instance reads via `findUnique(...).result()` and per-instance events |
| Compensation outcome (internal callback) | `StepCompensationResult<TArgs, T>` (compensation closure's `result` parameter) | Replaced by `(ctx, args, info)` where `info: CompensationInfo<TResult>` |
| Request compensation outcome | `RequestCompensationResult<TResponse>` (closure parameter) | Replaced by `(ctx, payload, info)` where `info: RequestCompensationInfo<TResponse>` |
| Request "needs compensation" flag | (none — every `.compensate(...)` is per-call-site) | `defineRequest({ compensation: true })` |
| `state` primitive | `defineWorkflow.state`, `compensation.state`, `ctx.state` | Removed entirely. `const state = {}` in the body has the same semantics |
| Step type families | Single `StepDefinition` | Same single type, with `IsStepCompensable<S>` helper for namespace filtering |
| Halt skippability | Unskippable in both VELs (Part 3) | Unskippable in execution; skippable per-instance in compensation |
| Builder `.compensate` fence | Hard ordering, post-fence methods → `never` | No fence. Chain methods commutative |

`defineWorkflow` simplifies sharply:

```typescript
// Before
defineWorkflow({
  name, args,
  channels, streams, events, attributes, queues, requests, topics,
  terminalErrors,
  compensation: { terminalErrors },
  beforeCompensate: async ({ ctx, args }) => { /* ... */ },
  afterCompensate:  async ({ ctx, args }) => { /* ... */ },
  steps,
  execute: async (ctx, args) => { /* ... */ },
});

// After
defineWorkflow({
  name, args,
  channels, streams, events, attributes, queues, requests, topics,
  terminalErrors,
  steps,                          // each step may carry its own compensation
  execute: async (ctx, args) => { /* ... */ },
});
```

## 13. Storage Shape and Why

### Before

`NEW_PRIMITIVES.MD` Part 8 models a unified tree per workflow: workflow primitives (channels, streams, events, attributes) all live in tables keyed by `workflow_id`, and compensation closures share these tables. The single `halt` table covers both VELs.

### After

Compensation block instances are separate durable entities and need their own storage. The reformation introduces **parallel** tables — separate, not polymorphic; no shared owner-type column:

```
workflow                            compensation_block_instance
  workflow_attributes                 compensation_block_attributes
  channel_message                     compensation_block_channel_message
  stream_record                       compensation_block_stream_record
  workflow_event                      compensation_block_event
  workflow_halt                       compensation_block_halt
  step                                compensation_block_step
```

Within compensation block instance tables, all instances of all step-compensation types share a single set of tables, discriminated by the parent step's `definition_name` plus the instance id. This avoids per-step-type schema explosion. Per-step-type schema enforcement happens at the engine layer using each step's declared compensation primitive schemas.

Two halt tables (`workflow_halt`, `compensation_block_halt`) make the §7 skippability asymmetry structurally evident.

The "unified tree model" framing of the current Part 8 needs revisiting: under the reformation the workflow has one execution tree and *N* compensation block instance trees. Mirror scopes for unconsumed branches still exist as structural-concurrency bundles, but each branch in a mirror scope corresponds to a separate compensation block instance with its own per-instance state.

Implementation details below this level — exact column lists, indexes, foreign keys, retention semantics — are provisional and to be designed alongside the public API.

## 14. Open Surface for the Next Round of Discussion

The design above is conceptually settled. What remains to be discussed during the public API design pass:

- **Exact field names** on `defineStep.compensation` — `undo` vs alternatives is settled (`undo`); the rest of the record needs to be drafted against the type sketches in §2 and §10.
- **Status enum** on compensation block instances — exact membership (`pending | running | completed | halted | skipped` is provisional).
- **Lightweight vs heavyweight** request compensations — does `defineRequest({ compensation: true })` ever expand into `defineRequest({ compensation: { ... } })` to declare per-instance primitives, or stay strictly lightweight?
- **`SearchQuery` instantiation** for `q.metadata` on compensation block instances — which fields are queryable, what comparisons are supported per field.
- **Manual-resolution surface** for request compensation (parallel to `client.requests.<name>.resolve(...)` from Part 11) — exact shape.
- **Handle method surface** for `findUnique` / `findMany` — every read operation must be a `FindUniqueResult<...>` (or subset analog); double-check the shape against the established attribute / stream / event / channel APIs.
- **Storage layout details** — exact column lists, indexes, foreign keys, retention semantics for the parallel compensation tables.
- **Integration into `NEW_PRIMITIVES.MD`** itself — exact rewrite scope per Part, preservation of cross-references, refresh of the Summary tables.

The reformation is internally consistent and structurally complete. It is ready to be folded into `NEW_PRIMITIVES.MD` once the open items above are resolved through the next round of public API design.

The document is complete — §14 ends it. The full sequence:

- §0 Framing
- §1 The Driving Insight
- §2 Compensation Becomes a Property of the Operation (with `CompensableStepDefinition` and `StepCompensation` type sketches, minimal shorthand example)
- §3 The Compensation Outcome Doctrine (`CompensationInfo<TResult>`, the flaky-API `timed_out` discussion, expanded `bookHotel` example with the lookup-only-when-needed pattern)
- §4 Compensation Block Instances as First-Class Entities (full-featured example using all four declared primitives genuinely)
- §5 The Query-Grounding Handle Pattern (with `FindUniqueResult`, unique-handle and subset-handle type sketches, naming grounded against `attributes.X.get/getNowait`, `streams.X.readNowait/tail`, `events.X.wait`)
- §6 Failure Semantics: Return, Don't Throw
- §7 Halts in Compensation Are Skippable
- §8 The Single Compensation VEL, Reframed
- §9 Type-Level Discrimination Without a Separate Type (`IsStepCompensable` / `IsRequestCompensable` helpers)
- §10 Request Compensation: The Necessary Asymmetry (`compensation: true` flag, `registerRequestCompensationHandler` modeled on `registerRequestHandler`, all four use-case patterns)
- §11 The Chain Simplifies
- §12 What Disappears
- §13 Storage Shape and Why
- §14 Open Surface for the Next Round of Discussion

If a particular section still feels under-developed — for example, you'd like me to draft the `SearchQuery` namespaces for `q.metadata` more concretely, or to flesh out the manual-resolution client API surface for request compensation, or to expand any of the type sketches into fully-elaborated TS definitions — say which one and I'll extend it in place.

---

Ok, I've output the buffer to the @BUFFER.MD file. Changed some things that were inconsistent.

A rewrite is still needed for:

1. @BUFFER.MD:607-655 This section seems to imply that we "filter out" the compensable steps/requests at context level, not showing them inside the context as an option. If so, this is wrong: we DO NOT ALLOW THEM TO BE ADDED TO THE DEFINITION. And from the POV of a context, we've built the abstraction in such a way, that it doesn't know whether a compensation is present or not: and isn't supposed to, since the call looks exactly the same in both cases.
2. @BUFFER.MD:441-446 could you make sure that the client indeed has this signatures for reading from a stream? I doubt it, I don't remember adding any tail methods. Make sure the signature is consistent with what we've already got. It also concerns the other primitives and their methods you've listed under this section. Make sure to check.
3. @BUFFER.MD:323-378 I do not like the example. The logic is strange. Instead of trying to cancel the booking in case we've found a confirmationId, why are we going straight to the operator? Why not try with a timeout and then go? Strange logic, make it more realistic. Also we don't actually need this to be a channel: it's a request rather.
4. @BUFFER.MD:183-186 please, keep this in mind. It's important.