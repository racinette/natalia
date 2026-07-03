# @2026-06-30-110539-hello.txt explore this chat transcript as well as the current
_Exported on 7/3/2026 at 23:18:18 GMT+3 from Cursor (3.9.16)_

---

**User**

@2026-06-30-110539-hello.txt explore this chat transcript as well as the current project state and the docs. What have we yet to implement over what we've currently got?

---

**Cursor**

I'll read the transcript, project layout, and docs in parallel to compare what's planned versus what's already built.


Here is a consolidated gap analysis from the transcript, `docs/`, `src/types`, divergence notes, and `CHANGESET.MD`.

## Where things stand

The project is in a **mid-refactor of the type system**, with **conceptual primitive docs largely written** and **runtime almost entirely stubbed**. The big recent win from the transcript — **`childWorkflows` / `externalWorkflows` redesign** — is done end-to-end in types, regression tests, and docs (`pnpm typecheck` green at session end).

What remains splits into three lanes: **unimplemented primitives**, **partial primitives / API seams**, and **missing engine-behavior + runtime work**.

---

## Done (types + docs agree)

### Primitive docs (15 finalized + 2 behavior)
| Area | Status |
|------|--------|
| channels, streams, steps, queues, requests | Documented; types largely wired |
| events, patches, scopes | Documented; types implemented |
| child-workflows, external-workflows | Documented; types implemented (recent redesign) |
| attributes, topics | Documented; **types not wired** (see below) |
| error-model | Written in session; types exist |
| header-interface-implementation, resolving-requests-asynchronously | Done |

### Type system — implemented surfaces
- **Execution body**: steps, requests (call site), queues (enqueue), channels, streams, events, patches, scopes, `ctx.errors`, `sleep`/`sleepUntil`, `rng`/`timestamp`/`date`, `ctx.schedule`
- **Child/external**: unified `ctx.childWorkflows.<name>(...)`, `ctx.externalWorkflows.<name>.get/.start`, factory-conditional identity, operator introspection shapes
- **Compensation (partial)**: step/request compensation declarations, `registerRequestCompensationHandler`, `undo` ctx for steps/requests/children/external/channels/streams/events

---

## Not implemented yet — primitives

These are the largest **code** gaps. Docs describe the intended API; types do not expose it.

### 1. Topics (biggest primitive gap)
Per `docs/topics_divergence.md`:
- `defineTopic()` exists; `registerConsumer` is a no-op stub
- Missing: `topics` slot on `defineWorkflow`, `ctx.topics.<name>.publish`, client `registerTopicConsumer` / `registerBatchTopicConsumer`, `onConsumeError`, `TopicRecord` shape, batch consumer

### 2. Attributes
Per `docs/attributes_divergence.md`:
- `AttributeDefinitions` type exists; compensation-block `attributes` slot exists in types
- Missing: `attributes` slot on `defineWorkflow`, `ctx.attributes.<name>.set`, external `handle.attributes.<name>.get/getNowait`, real compensation-block attribute accessors (currently `Record<string, unknown>` placeholders in `engine.ts`)

---

## Partially implemented — types exist, surface incomplete

These have regression tests and/or divergence notes; docs and code do not fully match.

| Area | What's there | What's missing |
|------|--------------|----------------|
| **Requests** | Call-site types, compensation handler, manual-resolution types | Forward `client.registerRequestHandler`; `MANUAL` currently scoped to compensation, not forward handlers; client `resolve`/`cancel` stubbed |
| **Queues** | Enqueue types, `DEAD_LETTER`, dead-letter handle shapes | Client `registerHandler` stubbed; definition-level stub still present; `retention`/`defaultTTL` from REFACTOR not modeled |
| **Channels** | `receive`, `receiveNowait`, `listen` | `receive(Date)` deadline overload (Part 14); docs under-document timeout/`receiveNowait` |
| **Streams** | `read`, `iterator`, `isOpen` | `readNowait`; docs missing `isOpen`, `closed`/`not_found` arms |
| **Compensation undo** | Declares queues/topics/attributes slots | `undo` ctx: queues = `never`, no `topics` accessor, no per-instance `attributes` accessor |
| **Compensation handles** | `status()` / `result()` | No `skip()`, no per-instance primitive reads on block handles |
| **Patches** | `ctx.patches.<name>` awaitable read | Replay flip rule (`true→false` while replaying) unspecified everywhere |
| **External introspection** | Typed `attributes`/`streams`/`events` on handles | All `attributes` planes are `Record<string, unknown>` placeholders until attributes land |

---

## Runtime — almost everything

`src/client.ts` and `src/engine.ts` are **typed shells**: workflow start/execute/get, search, request resolution, queue handlers, dead-letter ops all `throw new Error("Not implemented")`. There is no durable execution engine under `src/` beyond `ScopeRuntimeRegistry` and error types.

So: **the type layer is far ahead of runtime**. Regression tests in `src/types-regression-tests/` are the current definition of done for the refactor.

---

## Documentation still missing

The transcript explicitly deferred **engine-behavior docs**. Primitive tier is largely done; behavior/operations tier is not.

### High priority (paired with error model)
| Doc | Source | Notes |
|-----|--------|-------|
| **halt-model.md** | refactor/09, REFACTOR Part 3 | Session **interrupted mid-write**; `error-model.md` forward-references it |
| **execution-model.md** | refactor/01 | Core replay/entry model; patches flip rule belongs here or in patches doc |
| **context-isolation.md** | refactor/06 | Zero coverage in `docs/` |
| **compensation-model.md** | refactor/08 | Partially absorbed by `steps.md`; request compensation + two halt flavors not unified |

### Medium priority (cross-cutting behavior)
| Doc | Source |
|-----|--------|
| call-time-options / timeouts & retries | refactor/03 |
| attempt-accessor | refactor/05 |
| determinism (rng / timestamp / date) | types exist, no doc |
| scheduled-delivery | refactor/18 |
| idempotency-key-factory | refactor/19 |
| introspection & queries | refactor/12 |
| search-query | refactor/11 |
| engine/client setup | refactor/20 |

### Housekeeping
- No `docs/README.md` index
- `REFACTOR.MD` migration: only Part 7 (scopes) stubbed; most parts still carry implementation detail
- 8 `*_divergence.md` parked notes need per-primitive reconciliation before code changes
- Stale artifacts: `src/index.ts` header comment still mentions `ctx.childWorkflows.detached` and `ctx.externalWorkflows.X.get` only; comment typo "externalWorkflows callers" flagged in transcript

---

## Future product surface (`CHANGESET.MD`)

Explicitly **ahead of current work**, not started:
- OTel integration
- Pause workflow
- Fork from point in time
- Client-driven rollback
- Stream aggregator primitive
- External cron workflow starts (`client.schedules.*`)
- Scope hierarchies
- `"aborted"` flag on attempts
- Client vs engine connection model decisions

---

## Suggested priority order

If the goal is to close the refactor before building runtime:

1. **Implement topics + attributes** in `src/types` (largest primitive holes; divergence notes are ready)
2. **Write halt-model.md** (natural follow-on to `error-model.md`; session was cut off there)
3. **Reconcile parked divergences** — especially requests (forward handler + `MANUAL`), queues (client registration), Part 14 extensions (`receive(Date)`, `readNowait`)
4. **Wire compensation gaps** — `undo` accessors, block `skip()`, external attribute reads
5. **Engine-behavior doc tier** — execution model, context isolation, determinism, etc.
6. **Runtime** — only after the type surface stabilizes

The transcript's own closing summary matches this: *"remaining frontier is the engine-behavior docs we deferred … and the still-unimplemented primitives (topics, attributes)."*

Want me to turn this into a tracked worklist (e.g. ordered tasks with file-level checklists), or start on one lane — topics/attributes types, `halt-model.md`, or divergence reconciliation?

---

**User**

considering we're only after the public api design at the current stage, what are we missing?

---

**Cursor**

Narrowing to public API design only — I'll compare the intended type surface against what's exported and wired in `src/types`.


At the **public API design** stage, “done” means the type surface in `src/types/**`, definition helpers, and exports tell a complete, internally consistent story. Runtime stubs and narrative docs are out of scope.

## What’s largely designed

The core workflow authoring and client shapes are in place:

- **Body**: `steps`, `requests`, `queues`, `channels`, `streams`, `events`, `patches`, `scopes`, `ctx.errors`, `sleep`/`sleepUntil`, `rng`/`timestamp`/`date`, `ctx.schedule`
- **Composition**: `childWorkflows.<name>(…)` (attached, awaitable) and `externalWorkflows.<name>.get/.start` (independent roots)
- **Client/engine**: per-workflow `start` / `execute` / `get` / `findUnique` / `findMany` / `count`, search-query machinery, halt observation, workflow operator verbs (`sigkill` / `sigterm` / `skip`)
- **Queues (client)**: `client.queues.<name>.registerHandler` + dead-letter namespace — typed
- **Requests (partial)**: call-site accessor, compensation handler registration, manual-resolution handles (`resolve` / `cancel`) — typed
- **Compensation (partial)**: step/request compensation declarations, `registerRequestCompensationHandler`, external block handles with `skip`

---

## Missing from the public API design

### 1. Topics — not designed on the public surface

`defineTopic()` exists, but the rest of the API is absent:

| Missing piece | Intended shape (per docs/REFACTOR) |
|---------------|-----------------------------------|
| Workflow slot | `topics: { audit: auditTopic }` on `defineWorkflow` |
| Body publish | `ctx.topics.<name>.publish(record, { metadata? })` |
| Client consumers | `client.registerTopicConsumer(…)` / `registerBatchTopicConsumer(…)` |
| Consumer options | `filter`, `onConsumeError` (`"skip"`/`"halt"`), batch options |
| Record type | `TopicRecord<TPayload, TMetadata>` vs bare decoded payload |

`TopicDefinition.registerConsumer` is a transitional stub; `WorkflowClient` has no `topics` namespace at all.

### 2. Attributes — not designed on the public surface

Types exist as `AttributeDefinitions`, but only on compensation blocks:

| Missing piece | Intended shape |
|---------------|----------------|
| Workflow slot | `attributes: { progress: z.object(…) }` on `defineWorkflow` |
| Body write | `ctx.attributes.<name>.set(value)` |
| External read | `handle.attributes.<name>.get({ afterVersion, signal })` / `getNowait()` |
| Result unions | `{ status: "ok", value, version }` \| `not_set` \| `never` |
| Compensation block reads | Typed primitive plane on `CompensationBlockUniqueHandleExternal` (today `Record<string, unknown>`) |

`WorkflowHandleExternal.attributes` is still a placeholder.

### 3. Request forward-handler registration — API undecided

The biggest **requests** gap:

- Docs/REFACTOR: `client.registerRequestHandler(def, handler, { retryPolicy, onExhausted, maxConcurrent })`
- Code: only `RequestDefinition.registerHandler` stub on the definition; nothing on `WorkflowClient`
- `MANUAL` is typed/exported as a **compensation** sentinel; forward-handler `MANUAL` / `onExhausted` are not modeled
- `defineRequest` retention (`{ resolved, timedOut, cancelled }`) not on the definition type

### 4. Compensation `undo` context — declared but not wired

`StepCompensationDefinition` declares `queues`, `topics`, `attributes`, but `CompensationContext` does not expose them:

- `queues` → `Record<string, never>`
- no `topics` accessor
- no per-instance `attributes` accessor

The public undo API is narrower than the declaration slots promise.

### 5. Part 14 extensions — spec’d, not on the type surface

| Extension | Status |
|-----------|--------|
| `channel.receive(number \| Date)` | Only `number` overloads |
| `stream.readNowait(offset)` | Not on `StreamReaderAccessorExternal` |
| Attribute `getNowait` | Not defined |

### 6. Open API decisions (parked in `*_divergence.md`)

These are design choices, not implementation — they block calling the API “finished”:

- **Handler registration home**: client vs definition (`requests`, `queues`, `topics` all have transitional definition stubs)
- **`MANUAL` semantics**: one sentinel for forward + compensation, or two?
- **`DeadLetterReason`**: code has `"unrecoverable"`; docs say that’s topics-only
- **Queue `defineQueue` options**: `ttlSeconds` only vs REFACTOR’s `defaultTTL` + `retention`
- **Attribute external result shape**: flat `{ status, value, version }` vs `{ ok, status }` used elsewhere
- **Topic consumer record**: bare payload vs `TopicRecord` with `id`/`metadata`
- **Patch replay flip rule**: behavioral, but affects what `await ctx.patches.X` means under replay

### 7. Stale / deprecated public exports

The `childWorkflows` / `externalWorkflows` redesign landed in types, but cleanup remains:

- Still exported: `DetachedChildWorkflowAccessor`, `DetachedChildWorkflowInvocationOptions`, `DetachedStartOptions`
- Stale comments in `index.ts`, `call-builders.ts`, `context-interfaces.ts` still describe `childWorkflows.attached` / `.detached` and `.start()` on children (detached starts live on `externalWorkflows.start` now)

### 8. Connection model — undecided (`CHANGESET.MD` §4)

`txOrConn?` appears on external/operator methods, but whether the **client** takes a pool at construction vs per-call connection is still an open public API question.

---

## Explicitly not current-stage API design

These are either runtime, narrative, or future product surface — not blockers for “public API types are complete”:

- Runtime wiring (`client.ts` / `engine.ts` stubs)
- Engine-behavior docs (`halt-model`, `execution-model`, etc.) — types for halts, entries, errors largely exist
- DB schema, OTel, pause/fork/rollback, external cron schedules, scope hierarchies (`CHANGESET.MD` backlog)

---

## Practical “what’s left” list

If the goal is a **complete public API type design**, the worklist is roughly:

1. **Topics** — full surface (workflow slot, `ctx.topics`, client registration, consumer types)
2. **Attributes** — full surface (workflow slot, `ctx.attributes`, external get/getNowait, typed handle plane)
3. **Requests** — `registerRequestHandler` on client, forward `MANUAL`/`onExhausted`, close definition-stub question
4. **Compensation undo** — wire `queues`/`topics`/`attributes` accessors to match declared slots
5. **Part 14** — `receive(Date)`, `readNowait`, attribute read result types
6. **Reconcile divergence decisions** — handler registration location, `MANUAL`, dead-letter reasons, retention options
7. **Hygiene** — remove deprecated detached-child exports, align comments with `childWorkflows` / `externalWorkflows` split

Topics and attributes are the two **entire primitives** still missing from the type surface. Requests forward-handler registration is the biggest **single-method** gap on an otherwise-designed primitive. Everything else is extensions, wiring, or unresolved choices on an API that’s mostly sketched.

Want me to draft the topics or attributes type surface first — workflow slot, body accessor, and client/operator plane?

---

**User**

let's begin with the cleanup of the stale/deprecated exports and aligning the comments: all in all we want to finish the childWorkflows and externalWorkflows work.

---

**Cursor**

I'll search the codebase for stale child/external workflow exports and comments, then align them with the current API.


Implementing cleanup: removing deprecated types and aligning comments across the codebase.


Cleanup is done — `pnpm typecheck` and `pnpm lint` both pass.

## Removed deprecated public exports

From `call-builders.ts` / `types.ts`:
- `ChildWorkflowAccessor`
- `ChildWorkflowCallOptions` / `ChildWorkflowTimeoutCallOptions` (the mistaken `retry` copy from steps)
- `DetachedChildWorkflowAccessor`
- `DetachedChildWorkflowInvocationOptions` / `DetachedStartOptions`
- `ChildWorkflowStartOptions` (unused)

**Kept** the current surface: `ChildWorkflowUnifiedAccessor`, `CompensationChildWorkflowAccessor`, `ExternalWorkflowAccessor`, `ExternalWorkflowHandle`, `ExternalWorkflowStartOptions`, and the attached-child entry/handle types.

## Removed deprecated helper aliases

- `InferWorkflowAttachedChildren` / `InferWorkflowDetachedChildren` — `engine.ts` now uses `InferWorkflowChildren` directly.

## Removed dead operator type

- `DetachedChildWorkflowNamespaceExternal` — independent roots live under `workflowHandle.externalWorkflows.<name>`.

## Comments aligned across `src/`

Updated stale references in:
- `call-builders.ts`, `context-interfaces.ts`, `workflow-definition.ts`, `workflow-headers.ts`
- `engine.ts`, `helpers.ts`, `results.ts`, `schema.ts`, `index.ts`, `workflow.ts`
- Regression test comments in `01`, `03`, `07`, `13`

The narrative is now consistent everywhere:
- **`ctx.childWorkflows.<name>(...)`** — parent-owned, awaitable, no `idempotencyKey`, no `.start()`
- **`ctx.externalWorkflows.<name>.get/.start`** — independent roots, `ExternalWorkflowHandle`
- **`workflowHandle.childWorkflows.<name>`** — operator introspection of owned children (not `.attached.<name>`)

`AttachedChildWorkflow*` type names are intentionally kept — they still describe child-workflow semantics (parent-scoped ids, non-lifecycle handles). Only the old attached/**detached split API is gone.

---

**User**

ok. let's proceed. you're saying there is an issue with the queue types implementation. can you highlight the expected API and the current state? It's important we're on the same page about what the api is supposed to look like before we go ahead implementing it.

---

**Cursor**

I'll read the queue docs, divergence notes, and type definitions to compare the intended API with what's implemented.


The queue **type surface is mostly designed and regression-tested** (`13_queues.ts` passes). What’s left are a few **open decisions** and one **real wiring bug** in compensation — not a wholesale missing API. Here’s the picture so we’re aligned before touching code.

---

## Canonical expected API

Source of truth for the public shape: **`docs/queues.md`** + **`refactor/13_queues.MD`**. They agree on the model below.

### 1. Definition

```typescript
const emailQueue = defineQueue({
  name: "emailQueue",      // literal name — also the client namespace key
  message: z.object({ … }),
  ttlSeconds?: number,     // default TTL for messages (docs naming; not REFACTOR's `defaultTTL`)
});
```

Queues are **global** (not per-workflow). Workflows reference them via a **local slot name**:

```typescript
defineWorkflow({
  queues: { email: emailQueue },  // slot "email" ≠ definition name "emailQueue"
  …
});
```

### 2. Workflow enqueue (body + compensation undo)

```typescript
ctx.queues.email.enqueue(payload, opts?): void   // buffered, synchronous, no await
```

Options:

| Option | Type | Notes |
|--------|------|-------|
| `priority` | `number?` | lower = higher priority (REFACTOR semantics) |
| `ttlSeconds` | `number?` | per-message TTL override |
| `delaySeconds` | `number` | scheduled delivery (mutually exclusive with `scheduledAt`) |
| `scheduledAt` | `Date` | scheduled delivery |

No `txOrConn` on enqueue.

### 3. Client handler registration

Keyed by **definition `name`**, not workflow slot:

```typescript
client.queues.emailQueue.registerHandler(
  async (message, { signal }) => void | DEAD_LETTER,
  {
    maxConcurrent?: number,
    retryPolicy?: {
      timeoutSeconds, maxAttempts?,
      intervalSeconds?, backoffRate?, maxIntervalSeconds?,
    },
  },
): Unsubscribe
```

Handler contract:
- **Input**: decoded message (`z.output` of schema)
- **Return**: `void` (success) or `DEAD_LETTER` (immediate dead-letter)
- **Throw**: transient failure → retry per `retryPolicy`
- **Not allowed**: `MANUAL`, `UnrecoverableError` (topics only per docs)
- **No** `txOrConn` on registration

### 4. Dead letters (operator/client)

```typescript
client.queues.emailQueue.deadLetters
  .findMany(predicate, { fields?, limit?, txOrConn? })
  .findUnique(predicate, { txOrConn? })
  .count(predicate, { txOrConn? })
  .get(id)                    // sync, branded DeadLetterId, no txOrConn

handle.fetchRow(fields?, { txOrConn? })
handle.retry({ txOrConn? })
handle.purge({ txOrConn? })
```

Dead-letter reasons (per docs): **`"max_attempts"` | `"ttl_expired"`** only.

---

## Current type state

### Already matches the expected API

| Surface | Status | Where |
|---------|--------|-------|
| `defineQueue({ name, message, ttlSeconds? })` | ✅ | `workflow.ts`, `messaging.ts` |
| `queues` slot on `defineWorkflow` | ✅ | `workflow-definition.ts`, `workflow-contract.ts` |
| `ctx.queues.<slot>.enqueue(msg, opts?) → void` | ✅ | `QueueAccessor` in `call-builders.ts` |
| `QueueEnqueueOptions` (`priority`, `ttlSeconds`, `ScheduledDeliveryOptions`) | ✅ | `messaging.ts` |
| `client.queues.<definitionName>` namespace derivation | ✅ | `engine.ts` unions queues from registered workflows, keys by `queue.name` |
| `registerHandler` on client namespace | ✅ typed | `QueueNamespaceExternal` |
| `DEAD_LETTER` sentinel + `QueueHandlerResult` | ✅ | `handlers.ts`, exported from `index.ts` |
| `deadLetters` query/handle API | ✅ typed | `DeadLetterNamespaceExternal`, `DeadLetterHandleExternal` |
| Branded `DeadLetterId<TQueueName>`, `DeadLetterRow` | ✅ | `schema.ts` |
| `QueueInterface` = definition without `registerHandler` | ✅ | `workflow-contract.ts` |
| Regression coverage | ✅ green | `13_queues.ts` exercises all of the above |

So for the **core queue loop** (define → declare → enqueue → register handler → dead-letter ops), the types are already the API.

---

## Where things diverge or are incomplete

### A. Dual handler registration (design smell, not missing API)

**Expected:** handlers register only on `client.queues.<name>.registerHandler`.

**Current:** `QueueDefinition` still carries a **transitional `registerHandler` stub** (no-op unsubscribe from `defineQueue`). Docs call this transitional; `QueueInterface` correctly omits it.

**Decision needed:** remove the definition-level method once we commit to client-only registration (like requests should be).

---

### B. `DeadLetterReason` has an extra variant

**Expected (docs):** `"max_attempts" | "ttl_expired"`

**Current (`schema.ts`):**

```typescript
type DeadLetterReason = "max_attempts" | "ttl_expired" | "unrecoverable";
```

`"unrecoverable"` is a topics concept per docs; queues should dead-letter via `return DEAD_LETTER`, not `UnrecoverableError`. The regression test already rejects `UnrecoverableError` as a handler return.

**Decision needed:** drop `"unrecoverable"` from `DeadLetterReason`, or justify it for queues.

---

### C. Compensation `undo` doesn’t wire declared queues (real bug)

**Expected:** compensation blocks can declare `queues: { … }` and call `ctx.queues.<slot>.enqueue` from `undo` (docs/steps.md, `StepCompensationDefinition`).

**Current:** `CompensationContext` **does** expose `queues: QueueAccessor`, but `StepCompensationDefinition.undo` hardcodes:

```200:210:src/types/definitions/steps.ts
  readonly undo: (
    ctx: CompensationContext<
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TRequests,
      Record<string, never>,   // ← TQueues pinned to never
      TChildren,
      TExternalWorkflows
    >,
```

So declaring `queues` on a compensation block is accepted on the definition, but **`undo` ctx can never see those accessors**. That’s the main functional gap in queue types today.

---

### D. `defineQueue` config — docs vs REFACTOR (open, low urgency)

| Field | docs + current types | REFACTOR Part 10 |
|-------|---------------------|------------------|
| `ttlSeconds` | ✅ | was `defaultTTL` |
| `retention.{processed, deadLettered}` | ❌ dropped | ✅ spec'd |

Docs and types intentionally use the simpler shape. Unless you want retention on the definition, this is settled — just close REFACTOR.

---

### E. `retryPolicy` required vs optional

**Docs examples:** always pass `retryPolicy`.

**Types:** `retryPolicy?` is optional on `QueueHandlerRegistrationOptions`.

Minor — decide whether registration should require it.

---

### F. Runtime semantics not on the type surface (expected at this stage)

REFACTOR describes behavior that types don’t encode (and don’t need to for API design):
- `delay >= ttl` rejected at enqueue
- `ttl: null` = never expire
- claim ordering (`priority ASC, scheduled_at ASC, id ASC`)
- attempt history via `AttemptAccessor` on handler failures

These are runtime/impl concerns, not missing public types.

---

### G. Runtime stubs (out of scope for API design, but noted)

`client.ts` `registerHandler` / dead-letter methods return stubs or throw. Types are ahead of runtime — same as workflows/requests.

---

## Summary matrix

| Layer | Expected | Current |
|-------|----------|---------|
| Definition | `defineQueue({ name, message, ttlSeconds? })` | ✅ |
| Workflow declare | `queues: { slot: def }` | ✅ |
| Body enqueue | `ctx.queues.<slot>.enqueue(…): void` | ✅ |
| Compensation enqueue | `ctx.queues.<slot>.enqueue(…)` in `undo` | ❌ wired as `never` |
| Client namespace key | `client.queues.<def.name>` | ✅ |
| Handler registration | client only | ⚠️ client + definition stub |
| Handler return | `void \| DEAD_LETTER`; throw = retry | ✅ |
| Dead-letter API | namespace queries + handle actions | ✅ typed |
| Dead-letter reasons | `max_attempts`, `ttl_expired` | ⚠️ extra `unrecoverable` |
| `MANUAL` / `UnrecoverableError` on queue handlers | excluded | ✅ enforced in tests |

---

## Decisions to lock before implementing

1. **Remove `QueueDefinition.registerHandler`** — commit to client-only registration?
2. **Drop `"unrecoverable"` from `DeadLetterReason`** for queues?
3. **Wire `TQueues` into compensation `undo` ctx** — should be yes if we follow docs.
4. **Keep `retryPolicy` optional** or require it on registration?
5. **Skip `retention` on `defineQueue`** — keep docs’ simpler `ttlSeconds`-only shape?

If you confirm those five, the type work is mostly: fix compensation wiring, clean up the stub/extra reason, and optionally remove the definition-level `registerHandler`. Want to go through those decisions now, or should I propose defaults?

---

**User**

let me address every point separately:

> 1. Definition

There is `scheduledAt` and `delaySeconds` - these allow 2 planes of delay: the exact date and a seconds offset after the current timestamp. We want the same thing for the TTL. What would be a good way to shape this api? Maybe call it deadline? Also, I've been thinking about a possibility of introducing another variant that will count the deadline offset since the workflow start timestamp. This is essentially `ctx.timestamp + offsetSeconds`, and a specific use case, but whether worth including in the public api or not, it's up for a discussion.

---

**Cursor**

I'll check how scheduling and deadlines are modeled elsewhere in the type system so queue TTL options stay consistent.


The scheduling side already has a clean two-plane model. TTL should mirror it — but I'd avoid calling it `deadline` in the queue layer.

## Why not `deadline` for queue TTL?

`deadline` is already load-bearing elsewhere:

| Existing use | Meaning |
|--------------|---------|
| `DeadlineOptions` (`deadlineSeconds` / `deadlineUntil`) | **Execution boundary** — how long a child workflow / scoped entry may run |
| Step/request timeout `StepBoundary` | Same family — "stop trying after this wall" |
| `info.reason: "deadline"` on compensation | Execution timed out |

Queue TTL is a different concept: **message lifetime** — when an *unclaimed* message becomes `ttl_expired` in the dead-letter store. Overloading `deadline` will confuse "this workflow entry must finish by X" with "this queue row expires at X".

Better vocabulary: **expiry** (or **expires**), paired with **scheduled delivery**.

---

## Recommended shape: parallel unions

Keep the same discriminated-union style as `ScheduledDeliveryOptions`:

```typescript
/** When the message becomes eligible for claim. */
type ScheduledDeliveryOptions =
  | { delaySeconds: number; scheduledAt?: never }
  | { scheduledAt: Date; delaySeconds?: never }
  | { delaySeconds?: undefined; scheduledAt?: undefined };

/** When an unclaimed message expires (dead-letter with ttl_expired). */
type MessageExpiryOptions =
  | { ttlSeconds: number; expiresAt?: never; expiresAfterWorkflowSeconds?: never; neverExpires?: never }
  | { expiresAt: Date; ttlSeconds?: never; expiresAfterWorkflowSeconds?: never; neverExpires?: never }
  | { expiresAfterWorkflowSeconds: number; ttlSeconds?: never; expiresAt?: never; neverExpires?: never }
  | { neverExpires: true; ttlSeconds?: never; expiresAt?: never; expiresAfterWorkflowSeconds?: never }
  | { ttlSeconds?: undefined; expiresAt?: undefined; expiresAfterWorkflowSeconds?: undefined; neverExpires?: undefined };

type QueueEnqueueOptions = ScheduledDeliveryOptions &
  MessageExpiryOptions & {
    priority?: number;
  };
```

### The three expiry planes

| Variant | Anchor | Example | Resolves to (at enqueue commit) |
|---------|--------|---------|--------------------------------|
| `ttlSeconds` | **Enqueue time** | `{ ttlSeconds: 3600 }` | `committedAt + 3600s` |
| `expiresAt` | **Absolute instant** | `{ expiresAt: new Date("2027-06-30T00:00:00Z") }` | that instant |
| `expiresAfterWorkflowSeconds` | **Workflow start** | `{ expiresAfterWorkflowSeconds: 604800 }` | `workflow.startedAt + 7d` |

This mirrors delivery cleanly:

```
delivery:  delaySeconds  ↔  scheduledAt
expiry:    ttlSeconds    ↔  expiresAt
           (+ workflow-start anchor as a third plane)
```

`expiresAt` is the natural name for the absolute plane — symmetric with `scheduledAt`, both "pick an instant on the calendar."

---

## On the workflow-start-relative variant

Worth including in the public API, but as an **explicit third anchor**, not as `ctx.timestamp + offset`.

`ctx.timestamp` is the **current logical clock** at the enqueue site (replay position), not workflow birth. That's effectively enqueue-relative — `ttlSeconds` already covers it once the batch commits.

The distinct use case is a **shared expiry wall for the whole workflow instance**:

```typescript
// Parent runs up to 7 days; any "cleanup if still pending" message
// should expire with the parent, whether enqueued on day 1 or day 6.
ctx.queues.cleanup.enqueue(
  { orderId: args.orderId },
  { expiresAfterWorkflowSeconds: 7 * 24 * 3600 },
);
```

Without this, two enqueues on day 1 and day 6 with `ttlSeconds: 7d` get different expiry instants. The workflow-start anchor ties them to the same boundary.

**Requirements if we add it:**
- `workflow.startedAt` must be a stable, persisted field (already on `WorkflowRow`)
- Validation at enqueue: `eligibleAt < expiresAt` (same rule REFACTOR has for `scheduled_at < expires_at`)
- Deterministic under replay — `startedAt` is fixed per instance, so this is fine

**Naming options** (pick one):

| Name | Pros |
|------|------|
| `expiresAfterWorkflowSeconds` | Explicit anchor; reads well |
| `ttlFromWorkflowStartSeconds` | Mirrors `ttlSeconds` |
| `workflowTtlSeconds` | Short; slightly ambiguous |

I'd lean **`expiresAfterWorkflowSeconds`** — the anchor is obvious in API docs and at call sites.

---

## Definition-level defaults

Same pattern on `defineQueue`:

```typescript
defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  defaultExpiry?: MessageExpiryOptions,  // replaces bare ttlSeconds?
});
```

Per-enqueue options override the default. `neverExpires: true` on the definition means "this queue's messages don't TTL unless an enqueue overrides."

REFACTOR's `ttl: null` becomes `neverExpires: true` — clearer than null.

---

## Validation rules (runtime, but shape the types)

At enqueue commit, reject impossible combinations:

1. **Mutual exclusion** — exactly one expiry variant (or none → use default)
2. **Delivery before expiry** — `max(eligibleAt) < expiresAt`
   - `eligibleAt` = `committedAt + delaySeconds` or `scheduledAt`
   - `expiresAt` derived from whichever expiry variant was chosen
3. **Workflow-start expiry in the past** — if `workflow.startedAt + expiresAfterWorkflowSeconds <= now`, dead-letter immediately or reject at enqueue (pick one; I'd reject at enqueue for a clear author error)

---

## What I'd defer

**`ctx.timestamp + offset` as a separate public variant** — I'd skip it. It overlaps with `ttlSeconds` (enqueue-relative) unless you need "expire relative to this exact line in the body, not commit time." Buffered enqueue commits at batch boundaries, so the practical difference is small. If that gap matters later, add `expiresAfterEnqueueSeconds` as an alias — but I wouldn't ship it v1.

---

## Summary recommendation

1. **Don't use `deadline`** for queue TTL — use **`MessageExpiryOptions`** with `ttlSeconds` / `expiresAt` / `expiresAfterWorkflowSeconds` / `neverExpires`.
2. **Mirror** `ScheduledDeliveryOptions` structure — authors learn one pattern.
3. **Include workflow-start-relative** — it's a real, distinct anchor; cheap to type and implement.
4. **Skip `ctx.timestamp + offset`** as a first-class variant unless you have a concrete case where commit-time vs call-site-time matters.

Example call site with all planes:

```typescript
ctx.queues.notifications.enqueue(
  { userId: "u1", body: "Hello" },
  {
    priority: 0,
    delaySeconds: 60,                    // eligible in 1 min
    expiresAt: new Date("2027-07-01"),   // absolute expiry
  },
);

ctx.queues.cleanup.enqueue(
  { orderId: args.orderId },
  {
    scheduledAt: new Date("2027-06-29T08:00:00Z"),
    expiresAfterWorkflowSeconds: 604800, // expires 7d after workflow started
  },
);
```

If this direction works for you, next step is to fold `MessageExpiryOptions` into `messaging.ts`, update `defineQueue` defaults, and extend `13_queues.ts` with the new variants and `@ts-expect-error` mutual-exclusion checks.

---

**User**

what if we had expiresAt and ttlSeconds? ttlSeconds is important, because it bypasses the workflow deterministic model, gets the current timestamp at call time and creates a real-world timestamp. once. indeterministically. other things are implementable with the expiresAt. what do you think?

---

**Cursor**

Your instinct is sound: **two expiry variants is enough**, and giving `ttlSeconds` a special “real-world once” semantics is a meaningful distinction—not just a naming choice.

## The core idea

| Variant | Who picks the anchor | Determinism |
|---------|-------------------|-------------|
| **`expiresAt`** | Author (absolute instant) | Deterministic — derived from whatever the body uses (`ctx.date`, `workflow.startedAt`, a constant, etc.) |
| **`ttlSeconds`** | Engine (wall-clock **once** at first commit) | **Intentionally non-replay-derived** — the sampled instant is persisted and replay reuses it |

That split is coherent:

- **`expiresAt`** covers workflow-start offsets, fiscal deadlines, “expire at end of quarter,” `ctx.timestamp + N`, all of it — you compute the instant in the body and pass it.
- **`ttlSeconds`** covers “real SLA from when this actually hit the queue in production” — OTP cleanup, notification windows, “24h from when we really enqueued this.”

You don’t need `expiresAfterWorkflowSeconds` as a first-class option if authors can write:

```typescript
ctx.queues.cleanup.enqueue(payload, {
  expiresAt: addSeconds(workflowStartedAt, 7 * 24 * 3600),
});
```

…once they have a stable `workflowStartedAt` (or equivalent) on the context.

## The one rule that makes `ttlSeconds` work

“Indeterministic once” only works if the engine **never re-samples** on replay:

1. **First execution** at the enqueue step: `expires_at = wallClockNow() + ttlSeconds` → persist on the message row / in the batch record.
2. **Replay**: read persisted `expires_at`; do **not** call `Date.now()` again.

Same pattern as “generate UUID once” or “sample external id once”—a recorded side effect, not a re-derived formula. Without that, replay would shift expiry every time and the model breaks.

So `ttlSeconds` doesn’t really “bypass determinism” globally; it **opts into a one-shot wall-clock capture** that becomes part of durable state.

## What I like about this

1. **Small API** — mutual exclusion between `ttlSeconds` and `expiresAt`, plus optional `neverExpires` / queue default.
2. **Clear author mental model**:
   - “I know the instant” → `expiresAt`
   - “I want real-world N seconds from when this lands” → `ttlSeconds`
3. **Asymmetry with scheduling is OK** — `delaySeconds` / `scheduledAt` can stay on the **logical/durable** clock (enqueue commit), while expiry via `ttlSeconds` is the escape hatch for real-world TTL. That’s a feature, not inconsistency, if documented.

## Things to nail down

**1. “Call time” = commit time, not JS call time**

Enqueue is buffered; the durable moment is **batch commit**, not when `.enqueue()` returns in the coroutine. For TTL, I’d sample wall clock at **commit**, not at the synchronous call. Same as when the message actually becomes visible to workers.

**2. Document the replay contract explicitly**

Something like: *`ttlSeconds` uses the system clock once when the enqueue is first committed; replays use the stored expiry and do not re-sample.*

**3. `defineQueue` default**

If `defineQueue` has a default expiry, it should follow the same semantics as enqueue-time `ttlSeconds` (wall-clock-once per message), not a logical offset—unless you deliberately want different defaults.

**4. `neverExpires` / omit**

You still need “never” and “use queue default”:

```typescript
type MessageExpiryOptions =
  | { ttlSeconds: number; expiresAt?: never; neverExpires?: never }
  | { expiresAt: Date; ttlSeconds?: never; neverExpires?: never }
  | { neverExpires: true; ttlSeconds?: never; expiresAt?: never }
  | { ttlSeconds?: undefined; expiresAt?: undefined; neverExpires?: undefined };
```

**5. Validation**

Still require `eligibleAt < expiresAt` (however each side was chosen).

**6. Workflow-start-relative without a new knob**

Works via `expiresAt` **if** the body can read a stable `startedAt`. Today that’s on `WorkflowRow`, not obviously on `ctx`—so either expose something like `ctx.startedAt` / `ctx.workflowStartedAt` for authoring, or authors stash start time in metadata/attributes. Worth a follow-up; it doesn’t require a third expiry variant.

## What I’d skip

- **`ctx.timestamp + offset` as its own variant** — that’s just `expiresAt` built from logical time in the body.
- **`expiresAfterWorkflowSeconds` on the type** — same; compute `expiresAt` once you have start time on the context.

## Verdict

**Yes — `expiresAt` + `ttlSeconds` (wall-clock-once-at-commit) is a good public shape.** It’s smaller than the three-plane design, the special case is justified, and the rest folds into deterministic `expiresAt` math in the workflow body.

If you want to proceed, the type work is: replace bare `ttlSeconds?` on `QueueEnqueueOptions` with a proper `MessageExpiryOptions` union, align `defineQueue` defaults, and add regression tests that (a) reject both `ttlSeconds` and `expiresAt`, and (b) document that `ttlSeconds` is the non-replay-sampled path (types can’t enforce “persist once,” but the test file comment + doc can).

---

**User**

ok. this is decided. what else do we need to decide for the queues?

---

**Cursor**

With **`MessageExpiryOptions`** settled (`ttlSeconds` wall-clock-once-at-commit, `expiresAt`, `neverExpires`/default), the queue API is mostly designed. What’s left is a short decision list before types/docs line up.

---

## Already decided (no reopen)

| Topic | Decision |
|-------|----------|
| Enqueue surface | `ctx.queues.<slot>.enqueue(msg, opts?) → void`, buffered |
| Client namespace key | `client.queues.<definition.name>`, not workflow slot |
| Handler registration home | Client (`registerHandler`), not runtime on definition |
| Handler contract | `void \| DEAD_LETTER`; throw = retry; no `MANUAL` / `UnrecoverableError` |
| Dead-letter API | `deadLetters` namespace + handle `retry`/`purge`/`fetchRow` |
| Scheduling | `delaySeconds` \| `scheduledAt` (mutually exclusive) |
| Naming | `ttlSeconds`, `delaySeconds` (not REFACTOR’s `ttl`/`delay`) |
| Expiry planes | `ttlSeconds` (real-world once) + `expiresAt` (author absolute); rest via `expiresAt` math |

---

## Still need to decide

### 1. `defineQueue` default expiry shape

**Question:** Replace `ttlSeconds?` on the definition with `defaultExpiry?: MessageExpiryOptions`?

**Recommendation:** Yes — same union as enqueue (`ttlSeconds` | `expiresAt` | `neverExpires`). Per-enqueue opts override; omit on enqueue → use default.

**Sub-decision:** If a queue has **no** `defaultExpiry`, is expiry **required** on every enqueue (REFACTOR rule)?

**Recommendation:** Yes — require one of `ttlSeconds` | `expiresAt` | `neverExpires` on enqueue when there’s no default. Types can enforce “at least one expiry source” via overloads or a helper type.

---

### 2. Remove `QueueDefinition.registerHandler`?

**Question:** Drop the stub on `defineQueue()` return value entirely?

**Recommendation:** Yes — `QueueInterface` already omits it; client is canonical; matches where requests are heading. Remove from `QueueDefinition`, `defineQueue` impl, and regression test that references `emailQueue.registerHandler`.

---

### 3. `DeadLetterReason`: drop `"unrecoverable"`?

**Question:** Keep the third reason in `DeadLetterReason`?

**Recommendation:** Drop it for queues — only `"max_attempts" | "ttl_expired"`. Queue handlers use `return DEAD_LETTER`; `UnrecoverableError` stays topics-only.

---

### 4. Compensation `undo` queue access

**Question:** Wire `TQueues` into `StepCompensationDefinition.undo` ctx (today hardcoded `Record<string, never>`)?

**Recommendation:** Yes — docs and compensation slots already promise `ctx.queues` in undo; this is a type bug, not a design choice.

---

### 5. `retryPolicy` on handler registration — required?

**Question:** Optional (current types) vs required (docs examples always pass it)?

**Recommendation:** **Required** — a queue handler without timeout/maxAttempts is underspecified for a retried worker. Match requests’ forward-handler direction.

---

### 6. Row retention on `defineQueue` (REFACTOR `retention.processed` / `retention.deadLettered`)

**Question:** Add definition-level retention for processed/dead-lettered **rows**, separate from message expiry?

**Recommendation:** **Defer** — ops/GC concern, not needed to close the enqueue/handler/dead-letter API. Revisit with engine GC design (also in `CHANGESET.MD`). Don’t block queue types on it.

---

### 7. Enqueue validation rules (authoring contract)

**Question:** Which rules are part of the **public contract** (documented + runtime-enforced) vs implementation detail?

| Rule | Proposed contract? |
|------|-------------------|
| `delaySeconds`/`scheduledAt` mutually exclusive | Yes (already typed) |
| `ttlSeconds`/`expiresAt`/`neverExpires` mutually exclusive | Yes (new type) |
| `eligibleAt < expiresAt` | Yes — reject at enqueue commit |
| Priority: lower number = higher urgency | Yes — document (REFACTOR) |
| Default priority `0` | Yes |

**Decision needed:** Confirm that list as the v1 contract.

---

### 8. Dead-letter `retry()` semantics

**Question:** When an operator calls `deadLetter.retry()`, what happens to expiry and scheduling?

REFACTOR: redrive preserves priority; retry resets attempt count. Unclear on expiry.

**Options:**
- **A)** Recompute from original enqueue opts (replay persisted opts)
- **B)** Fresh wall-clock `ttlSeconds` if original used `ttlSeconds`
- **C)** Clear expiry / require operator to set new opts

**Recommendation:** **A** — redrive is “try again as the same message”; reuse persisted `expires_at` unless already past (then reject or immediate `ttl_expired`). Worth an explicit decision.

---

### 9. `ctx` access for `expiresAt` authoring patterns

**Question:** Do we need `ctx.workflowStartedAt` (or similar) on `WorkflowContext` for workflow-start-relative `expiresAt` without a new expiry variant?

**Not blocking** queue types, but affects ergonomics. Options:
- Add `ctx.startedAt` / `ctx.workflowStartedAt` to body context
- Defer — authors use metadata/attributes they set at start
- Document pattern only

**Decision:** Ship queues without it, or add now?

---

### 10. Docs sync

**Question:** Update `docs/queues.md` + `queues_divergence.md` when types land?

**Recommendation:** Yes — part of the same PR: `MessageExpiryOptions`, remove transitional `registerHandler` mention, drop `unrecoverable`, document `ttlSeconds` wall-clock-once semantics.

---

## Not API decisions (skip for now)

- DB schema, claim SQL, `SKIP LOCKED` — runtime
- `AttemptAccessor` on handler failures — cross-cutting (Part 15)
- Client stub → real runtime — later
- Whether `ScheduledDeliveryOptions` also applies to workflow starts — already shared type; no queue-specific decision

---

## Suggested decision order

1. **defaultExpiry + required-on-enqueue rule** (pairs with expiry decision)
2. **Remove definition `registerHandler`**
3. **Drop `"unrecoverable"` from `DeadLetterReason`**
4. **Wire compensation `TQueues`**
5. **Require `retryPolicy` on registration**
6. **Confirm validation contract** (eligible &lt; expires)
7. **Dead-letter `retry()` redrive semantics**
8. **Defer retention**; **defer `ctx.startedAt`** unless you want it now

If you want defaults without debating each one: I’d go **yes / yes / drop / yes / required / confirm / reuse persisted expiry / defer / defer** for items 1–9. Say which you want to override and we can implement the type changes next.

---

**User**

Ok, we really have to understand the expiry shape better.

> defineQueue default expiry shape

We cannot have expiresAt as a default constant. We could potentially allow expiresAt default, but make it a callback - but what it should depend on, it's unknown.

`neverExpires` is questionable in the both cases, it seems like `ttlSeconds: null` is an overall better api shape. Maybe we could potentially do `ttl: number | Date | null` and `delay: number | Date | 0`.

---

**Cursor**

The expiry/default question really comes down to **what can be frozen at `defineQueue` time** vs **what must be chosen per enqueue**. A unified `ttl` / `delay` scalar union is a good direction; a few semantics need to be pinned.

---

## What can `defineQueue` default?

You're right: **`expiresAt` as a static default doesn't work** — one `Date` on the definition would apply to every message forever, which is almost never what you want.

A **callback on the definition** is awkward for the same reason: at definition time you don't have enqueue context (payload, parent workflow, commit instant, etc.). Whatever it returned would either be:
- constant in practice, or
- secretly “run at enqueue time” — which belongs on the enqueue call, not on `defineQueue`.

**Realistic `defineQueue` default:**

```typescript
defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  defaultTtl?: number | null,  // only this shape makes sense
});
```

| `defaultTtl` | Meaning |
|--------------|---------|
| `number` | Default wall-clock-once TTL for messages that omit `ttl` on enqueue |
| `null` | Default is “never expires” |
| omitted | No default — every enqueue must pass `ttl` |

No `Date` on the definition. Absolute expiry is always **per enqueue** (`ttl: Date` or computed in the body).

A define-time callback only becomes interesting if you later add something like `defaultTtl: (ctx: EnqueueCommitContext) => number | Date | null` **on the enqueue options**, not on `defineQueue`. That's equivalent to computing `ttl` in the workflow body; I'd skip it for v1.

---

## `neverExpires` vs `ttl: null`

Agree — **`ttl: null` is better** than a separate `neverExpires` flag. It matches REFACTOR and reads naturally:

- `ttl: 3600` → expires (wall-clock once)
- `ttl: new Date("…")` → expires at instant
- `ttl: null` → never
- omit `ttl` → use `defaultTtl` (if set), else type/runtime error

---

## Unified shape: `ttl` and `delay`

This is a solid simplification:

```typescript
type QueueEnqueueOptions = {
  priority?: number;
  delay?: number | Date | 0;
  ttl?: number | Date | null;
};
```

### `delay` — when the message becomes claimable

| Value | Meaning |
|-------|---------|
| omitted / `0` | Eligible at commit (immediate) |
| `number` | `delay` seconds after **enqueue commit** (logical/durable clock — replay-stable) |
| `Date` | Eligible at this absolute instant |

Using `0` for “now” is fine; **`omit` ≡ `0`** keeps call sites light.

### `ttl` — when an unclaimed message expires

| Value | Meaning |
|-------|---------|
| omitted | Use `defineQueue.defaultTtl`; error if none |
| `number` | Wall-clock **once at commit**: `expires_at = now() + ttl`, persisted, replay reuses stored value |
| `Date` | Absolute `expires_at` (author-owned, deterministic) |
| `null` | Never expires |

**Asymmetry is intentional:**
- `delay` number → deterministic (commit-relative)
- `ttl` number → real-world once (then durable)

`Date` on both sides is always absolute calendar time.

---

## Why this is better than `MessageExpiryOptions`

- One field per concern, no mutually exclusive key soup
- `number | Date | null` is easy to explain and serialize
- `defineQueue` default stays honest: **`number | null` only**
- Body can still do workflow-start-relative expiry:  
  `ttl: new Date(startedAt.getTime() + 7 * DAY_MS)` — no extra variant

---

## Still need to decide (expiry-focused)

### 1. Naming: `ttl` / `delay` vs `ttlSeconds` / `delaySeconds`

| | `ttl` / `delay` | `ttlSeconds` / `delaySeconds` |
|--|-----------------|-------------------------------|
| Pros | Short; matches REFACTOR; `Date` carries its own unit | Consistent with `deadlineSeconds`, `intervalSeconds` elsewhere |
| Cons | Unit of `number` must be documented | More verbose |

If you adopt `ttl` / `delay`, I'd use them **everywhere** for queues (definition + enqueue) and treat `Date` as the absolute form. Pick one naming scheme and stick to it.

### 2. Omit vs explicit `null` on enqueue

| Enqueue `ttl` | `defaultTtl: 3600` | `defaultTtl: null` | no default |
|---------------|--------------------|--------------------|------------|
| omit | 3600 | never | **error** |
| `null` | never (override) | never | never |
| `3600` | 3600 | 3600 | 3600 |

Confirm that **`null` overrides a numeric default** (explicit “this message never expires”).

### 3. Validation at commit

- `eligibleAt < expiresAt` (when `ttl` is not `null`)
- If `ttl` is `Date` in the past → reject at enqueue, or dead-letter immediately? (I'd **reject** at enqueue for author errors.)

### 4. `delay: Date` in the past

Same choice: reject at enqueue vs eligible immediately.

### 5. Types for “ttl required”

When `defaultTtl` is absent, enqueue should require `ttl`. That's hard to express per-queue in TypeScript without branded define results; options:
- **Runtime only** (simpler)
- **Branded `defineQueue` return** that flows into workflow slot types (heavier)

Worth deciding how far types go on v1.

---

## Recommended expiry shape (consolidated)

```typescript
// defineQueue — defaults only what can be global
defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  defaultTtl?: number | null,
});

// enqueue
ctx.queues.email.enqueue(payload, {
  priority?: number,
  delay?: number | Date | 0,
  ttl?: number | Date | null,
});
```

**Semantics doc (one paragraph):**  
*`delay` controls claim eligibility (commit-relative number or absolute `Date`). `ttl` controls expiry (`number` = wall-clock once at commit, `Date` = absolute, `null` = never). Omit `ttl` to use `defaultTtl`; omit `delay` or pass `0` for immediate.*

---

## What this removes from the earlier design

- No `expiresAt` / `ttlSeconds` / `neverExpires` keys
- No `expiresAt` on `defineQueue` (constant or callback)
- No `MessageExpiryOptions` discriminated union
- No `defaultExpiry` object on the definition

---

If this matches your intent, the remaining queue decisions from before are mostly unchanged (remove definition `registerHandler`, drop `"unrecoverable"`, wire compensation queues, require `retryPolicy`) — only the **expiry/default** slice is now this `ttl` / `delay` model. Want to lock **`ttl`/`delay` naming** and the **omit/null/default table** next, then implement types?

---

**User**

let's also add defaultDelay, 0 being the default. v1 doesn't need the defaultDelay and defaultTtl callback.

let's discuss the next pending questions. 

> remove definition registerHandler

We need to remove handler registration at definition time. Definition is completely separate from the implementation: the handlers are to be registered on the client.

> drop "unrecoverable", wire compensation queues

Can you expand on that?

---

**Cursor**

Updated **`defineQueue`** shape with your additions:

```typescript
defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  defaultDelay?: number | Date | 0,  // default 0 (immediate)
  defaultTtl?: number | Date | null,   // omit => enqueue must pass ttl
});
```

Enqueue still uses `delay?` / `ttl?` with the omit → default rules we discussed. No callbacks in v1.

---

## Remove `registerHandler` from the definition

**What exists today**

`defineQueue()` returns a `QueueDefinition` that includes:

```typescript
registerHandler(handler, options?): Unsubscribe  // no-op stub in workflow.ts
```

Meanwhile the real surface is:

```typescript
client.queues.emailQueue.registerHandler(handler, options): Unsubscribe
```

`QueueInterface` (workflow contract slice) already does `Omit<QueueDefinition, "registerHandler">` — the contract layer knew handlers don't belong on the definition.

**Why remove it**

Queues follow the same split as the rest of the engine:

| Layer | Responsibility |
|-------|----------------|
| **Definition** (`defineQueue`) | Global name, message schema, defaults (`defaultDelay`, `defaultTtl`) — pure data contract |
| **Workflow** | Declares `queues: { slot: def }`, enqueues via `ctx.queues.<slot>` |
| **Client / engine** | Registers workers, runs handlers, dead-letter ops |

Handler registration is **runtime wiring**: which process consumes which queue, with what concurrency and retry policy. That lives outside workflow code — on the client when the worker starts — not on the global definition object.

Keeping `emailQueue.registerHandler(...)` suggests definitions carry implementation, contradicts docs, and duplicates the client API (the regression test at line 167 only exists to prove `MANUAL` is rejected on the stub).

**What changes**

- Remove `registerHandler` from `QueueDefinition` and `defineQueue()` return value
- `QueueInterface` becomes identical to `QueueDefinition` (no more `Omit`)
- Delete `emailQueue.registerHandler` from `13_queues.ts`
- Same pattern you'll want for requests/topics eventually

---

## Drop `"unrecoverable"` from `DeadLetterReason`

**What exists today**

```typescript
type DeadLetterReason = "max_attempts" | "ttl_expired" | "unrecoverable";
```

Docs and REFACTOR only list the first two for queues.

**Two different mechanisms**

Queue handlers have their own vocabulary:

| Mechanism | Queue behavior |
|-----------|----------------|
| Success | `return` / `void` |
| Intentional dead-letter | `return DEAD_LETTER` |
| Transient failure | `throw` → retry per `retryPolicy` |
| Exhausted retries | Engine dead-letters with reason **`max_attempts`** |
| TTL passed unclaimed | Engine dead-letters with reason **`ttl_expired`** |

**Topics** use a different model:

| Mechanism | Topic behavior |
|-----------|----------------|
| Permanent consumer failure | `throw new UnrecoverableError(...)` → `onConsumeError` / halt / skip |

`UnrecoverableError` is documented as **topics-only**. Queue handlers must not throw it — `13_queues.ts` already rejects it as a return value.

**What `"unrecoverable"` on `DeadLetterReason` implies**

A third persisted reason suggesting queues can dead-letter like topics (throw → `unrecoverable`). That path doesn't exist in the queue handler contract and would blur two models:

- Queues: **return** `DEAD_LETTER` for intentional rejection
- Topics: **throw** `UnrecoverableError` for permanent failure

**What “drop it” means**

```typescript
type DeadLetterReason = "max_attempts" | "ttl_expired";
```

- Dead-letter search/filter only exposes real queue outcomes
- `UnrecoverableError` stays exported for topic consumers; not part of queue dead-letter taxonomy
- No runtime path assigns `reason: "unrecoverable"` for queue rows

`DEAD_LETTER` return stays — that's immediate dead-letter by handler choice; the stored reason would be something the engine defines for that case (worth deciding: same as `max_attempts` vs a dedicated code — REFACTOR treated `return DEAD_LETTER` as immediate dead-letter, not a separate reason string). That's a small follow-up if not already specified.

---

## Wire compensation queues

**What exists today**

Step compensation blocks can **declare** queue dependencies:

```typescript
compensation: {
  queues: { notify: emailQueue },
  async undo(ctx, args, info) {
    // docs say: enqueue from undo, same as workflow body
  },
}
```

`CompensationContext` **already types** `ctx.queues` with `QueueAccessor` (enqueue works in the interface).

But `StepCompensationDefinition.undo` pins the wrong generic:

```200:210:src/types/definitions/steps.ts
  readonly undo: (
    ctx: CompensationContext<
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TRequests,
      Record<string, never>,   // ← 6th type param = TQueues, hardcoded to never
      TChildren,
      TExternalWorkflows
    >,
```

`CompensationContext` generics are:

```
TChannels, TStreams, TEvents, TSteps, TRequests, TQueues, TChildren, TExternalWorkflows, ...
```

Position 6 is `TQueues`. Passing `Record<string, never>` means **inside `undo`, `ctx.queues` is always empty** — TypeScript never exposes declared queue slots, even when `compensation.queues: { notify: emailQueue }` is set.

**What “wire” means**

Change the `undo` callback to pass **`TQueues`** (the compensation block's declared queue map) instead of `Record<string, never>`:

```typescript
ctx: CompensationContext<
  TChannels,
  TStreams,
  TEvents,
  TSteps,
  TRequests,
  TQueues,              // ← declared queues flow through
  TChildren,
  TExternalWorkflows
>,
```

Then this type-checks:

```typescript
compensation: {
  queues: { notify: emailQueue },
  async undo(ctx, args, info) {
    ctx.queues.notify.enqueue({ ... }, { ttl: 3600 });
  },
}
```

And this fails (undeclared queue):

```typescript
async undo(ctx) {
  ctx.queues.notify.enqueue(...);  // error: notify not in TQueues
}
```

**Why it matters**

Compensation often needs side effects: “payment failed, enqueue reversal job.” Without wiring, the declaration slot is a lie — you can write `queues:` on the block but can't call `ctx.queues` in `undo`.

**Scope**

- Types only for this change (same `QueueEnqueueOptions` / `delay` / `ttl` as workflow body)
- No separate compensation enqueue API
- Topics/attributes in compensation `undo` are still unwired (same bug pattern) — queues are the topic here

**Test follow-up**

Add a case in `08_compensation_model.ts` or extend `13_queues.ts`: compensation block with `queues:` + `undo` calling `ctx.queues.<slot>.enqueue`.

---

## Remaining queue decisions (after the above)

| # | Question | Status |
|---|----------|--------|
| 1 | `ttl` / `delay` naming (vs `*Seconds`) | Open |
| 2 | `retryPolicy` required on `registerHandler` | Open — recommend required |
| 3 | Validation contract (`eligibleAt < expiresAt`, past dates) | Open — recommend reject at enqueue |
| 4 | Dead-letter `retry()` — reuse persisted expiry | Open |
| 5 | Row retention on `defineQueue` | Deferred |
| 6 | `ctx.workflowStartedAt` for `ttl: Date` patterns | Deferred |

**Locked in this thread**

- `defaultDelay` (default `0`) + `defaultTtl` on `defineQueue`; no callbacks v1
- `ttl: number \| Date \| null`, `delay: number \| Date \| 0` on enqueue
- Remove definition `registerHandler`
- Drop `"unrecoverable"` from `DeadLetterReason`
- Wire `TQueues` into compensation `undo` ctx

Want to knock out the type changes for the locked items next, or settle `retryPolicy` required and dead-letter `retry()` semantics first?

---

**User**

ok. so you suggest dripping "unrecoverable" from the dead-letter reason. what about the use-case, when the handler decides that there is no point in retrying, so it deems the message unrecoverable? this seems to be what this option intended to represent, yet failed to get across.

---

**Cursor**

You're right to push on this — the **use case is real**. What failed was naming and wiring, not the idea.

## Three different paths into dead-letter storage

Operators care *why* a row landed in `deadLetters`:

| Path | Handler / engine behavior | What happened |
|------|---------------------------|---------------|
| **`max_attempts`** | Handler **throws** (transient); engine retries until `retryPolicy.maxAttempts` | “We tried; infrastructure/handler kept failing.” |
| **`ttl_expired`** | Message never claimed (or expired) before `expires_at` | “Time ran out.” |
| **Handler permanent reject** | Handler **`return DEAD_LETTER`** on first (or any) attempt | “This payload is bad; retrying won’t help.” |

That third case is exactly “handler decides there’s no point retrying.” It’s already the **intended** queue API — REFACTOR Part 15b:

> Return `DEAD_LETTER` → dead-letter immediately, bypassing remaining retry attempts … the message itself is the problem, not the handler or its dependencies.

So the **mechanism** isn’t missing. What’s missing is a clear **persisted reason** on the dead-letter row.

REFACTOR’s DB constraint only allows:

```sql
dead_letter_reason IN ('max_attempts', 'ttl_expired')
```

It never says what reason is stored when the handler returns `DEAD_LETTER`. The type added `"unrecoverable"` was likely filling that hole — but it collided with **`UnrecoverableError`** (topic **throw**), so it read like “queues can throw `UnrecoverableError`,” which we explicitly don’t want.

## Correct model (mechanism vs reason)

**Queues — permanent “don’t retry”:**

```typescript
if (!isValid(message)) {
  return DEAD_LETTER;  // not throw UnrecoverableError
}
```

**Topics — same intent, different surface:**

```typescript
throw new UnrecoverableError("...");  // → onConsumeError, not dead-letter store
```

Same author intent (“this record is permanently bad”), **different handler vocabulary**. The dead-letter **reason** should describe the **outcome**, not the JavaScript class name.

## Recommendation: keep a third reason, clarify the mapping

**Don’t drop** the third reason — **define it** as the persisted outcome of `return DEAD_LETTER`:

```typescript
type DeadLetterReason =
  | "max_attempts"      // exhausted throws
  | "ttl_expired"       // expiry clock
  | "rejected";         // handler returned DEAD_LETTER (name TBD)
```

I'd lean **`rejected`** or **`handler_rejected`** over **`unrecoverable`**:

| Name | Pros | Cons |
|------|------|------|
| `unrecoverable` | Matches intuition | Confused with `UnrecoverableError` |
| `rejected` | Short; “handler rejected this message” | Slightly generic |
| `handler_rejected` | Very explicit | Longer |

If you prefer keeping `unrecoverable`, document it tightly:

> **`unrecoverable`** — dead-lettered because the handler returned **`DEAD_LETTER`**. Not related to throwing `UnrecoverableError` (topics only).

## What operators get

```typescript
// Poison pill — wrong schema, unknown tenant, business rule "never process"
client.queues.notifications.deadLetters.findMany(
  ({ reason }) => eq(reason, "rejected"),
);

// Flaky downstream — different bucket
client.queues.notifications.deadLetters.findMany(
  ({ reason }) => eq(reason, "max_attempts"),
);
```

Without the third reason, `return DEAD_LETTER` and exhausted retries are indistinguishable in search — both are “in dead letter store,” but remediation differs (fix payload vs fix dependency vs retry).

## Summary

- Your use case is **`return DEAD_LETTER`**, not a missing API.
- **`"unrecoverable"` as a reason** was pointing at the right semantics; it failed because it sounded like the topic **throw** type.
- **Keep three reasons**; optionally **rename** `unrecoverable` → `rejected` / `handler_rejected`.
- **Queues still do not use `UnrecoverableError`** — permanent failure is a **return**, matching `MANUAL` on requests (intentional outcomes are returns, not throws).

If you pick the reason string (`rejected` vs `handler_rejected` vs keep `unrecoverable`), we can lock the dead-letter taxonomy and move on to the type implementation.

---

**User**

this case isn't "invalid payload". and thanks to your highlight of an "invalid payload" case, it may be a nice addition to have `"invalid_payload"` as well: this is for when the worker wasn't able to deserialize the input to pass to the handler. 

then, the `"handler_reject"` case as we've discussed. But what I'm thinking is whether we wouldn't be better off returning some kind of metadata alongside the rejection. It seems like there are already examples of such behavior in the codebase, let's explore whether my assumption is correct.

---

**Cursor**

Searching the codebase for rejection metadata patterns alongside dead-letter and handler outcomes.


Your assumption is **half right**: the codebase already has a strong **structured failure metadata** story for **throws** and **workflow errors**, but **not** for intentional **returns** like `DEAD_LETTER` today. That gap is exactly where `handler_reject` + optional metadata should land.

---

## Two different “permanent failure” cases

| Case | Who decides | Handler runs? | Typical cause |
|------|-------------|---------------|---------------|
| **`invalid_payload`** | Engine | No | Stored bytes don’t decode/validate against `message` schema |
| **`handler_reject`** | Handler | Yes | Decoded message is valid structurally, but processing is permanently pointless (unknown business code, revoked tenant, etc.) |

`invalid_payload` is not “handler didn’t like the JSON shape” — it’s **before** the handler: Standard Schema `validate` failed on the persisted payload. The handler never sees a typed `message`.

`handler_reject` is **after** decode: “I understand this message; retrying won’t change the outcome.” That’s `return DEAD_LETTER` (or a richer return), not a throw.

Proposed reason set:

```typescript
type DeadLetterReason =
  | "max_attempts"
  | "ttl_expired"
  | "invalid_payload"   // engine: decode/validate failed
  | "handler_reject";   // handler: intentional permanent reject
```

---

## Precedent in the codebase: metadata on failures

### 1. `AttemptError` (throw → retriable attempt row)

The main structured-handler pattern:

```typescript
throw new AttemptError({
  type: "DownstreamUnavailable",
  message: "SMTP timeout",
  details: { host: "smtp.example.com", code: 421 },
});
```

REFACTOR Part 15: engine persists `type`, `message`, `details` on **`queue_message_attempt`** (and the same shape for steps, requests, topics). That’s the unified **`Failure` / `Attempt`** model in `results.ts`.

Used for **transient** failures you’re willing to retry — not for permanent reject.

### 2. `ExplicitError` / `WorkflowErrorEnvelope` (workflow business failure)

Workflow body: `ctx.errors.X(message, details)` → external callers see `ErrorValue` with `code`, `message`, `details`. `WorkflowErrorEnvelope` on the row has `type`, `message`, `details`.

Same **triple** (classifier + message + JSON details), different surface.

### 3. Intentional returns — **no metadata today**

| Return | Metadata |
|--------|----------|
| `MANUAL` (requests) | Bare sentinel only |
| `DEAD_LETTER` (queues) | Bare sentinel only |

REFACTOR says returning `DEAD_LETTER` still writes **`queue_message_attempt`**, but it doesn’t define what goes in that row for a return (no throw to extract from). So today there’s a hole: **reason on the dead-letter row, no structured “why” from the handler.**

### 4. `UnrecoverableError` (topics) — weak metadata

Topics throw `UnrecoverableError(message?: string)` — **message string only**, no `type`/`details`. Exhaustion goes to `onConsumeError`, which can read **`event.attempts.last()`** for attempt history.

`refactor/17_handler_early_termination.ts` still shows the **old** queue pattern (`throw UnrecoverableError`); current direction is **`return DEAD_LETTER`** instead — another sign the metadata story for queues wasn’t finished.

### 5. Dead-letter row today — no `details`

```282:294:src/types/schema.ts
export interface DeadLetterRow<...> {
  readonly id: DeadLetterId<TQueueName>;
  readonly queueName: TQueueName;
  readonly payload: TMessage;
  readonly reason: DeadLetterReason;
  readonly priority: number;
  readonly attemptCount: number;
  readonly deadLetteredAt: Date;
  readonly createdAt: Date;
}
```

Operators get `reason` + decoded `payload`, but not handler/engine diagnostics unless we add a field or **`attempts()`** on the handle (REFACTOR Part 15 mentions attempt access for queue dead letters; not on `DeadLetterHandleExternal` yet).

---

## Your instinct is correct: add metadata for `handler_reject`

Align with **`AttemptError` / `ExplicitError`**: optional `type`, `message`, `details` (`JsonInput`), but on an intentional **return**, not a throw.

### Option A — `deadLetter()` helper (recommended)

Replace bare `return DEAD_LETTER` with a function that returns a typed outcome:

```typescript
// handlers.ts
export function deadLetter(options?: {
  readonly type?: string;
  readonly message?: string;
  readonly details?: JsonInput;
}): DeadLetterOutcome;

export type QueueHandlerResult = void | DeadLetterOutcome;
```

```typescript
if (order.state === "cancelled") {
  return deadLetter({
    type: "OrderAlreadyCancelled",
    message: "Cannot charge cancelled order",
    details: { orderId: message.orderId },
  });
}
```

- `return deadLetter()` / `return deadLetter({...})` → `reason: "handler_reject"`
- `return` / `void` → success
- `throw` / `AttemptError` → retry → eventually `max_attempts`

Keep exporting `DEAD_LETTER` as deprecated alias, or drop it in favor of `deadLetter()`.

### Option B — enrich `DeadLetterRow` + attempt log

On dead-letter:
- Set `reason: "handler_reject"`
- Write final **`queue_message_attempt`** row from return metadata (same columns as `AttemptError`)
- Optionally copy summary onto row: `details?: JsonInput` on `DeadLetterRow` for `fetchRow` without loading attempts

For **`invalid_payload`**:
- Engine writes `reason: "invalid_payload"`
- `details`: Standard Schema `issues` (or normalized form)
- `payload` on row: probably **raw stored JSON** (`JsonInput`), not `TMessage` — typing implication: `payload` may be opaque when `reason === "invalid_payload"`

### Where metadata lives (layered, like elsewhere)

| Layer | `handler_reject` | `invalid_payload` |
|-------|------------------|-------------------|
| **`dead_letter_reason`** | `handler_reject` | `invalid_payload` |
| **Attempt log** | Final attempt from `deadLetter({...})` | Synthetic “attempt 1” with schema issues in `details` |
| **`DeadLetterRow.details`** (optional) | Copy of handler summary | Copy of validation issues |
| **`DeadLetterHandle.attempts()`** (future) | Full history | Single decode-failure record |

Same pattern as request compensation: row scalars + **`attempts()`** for depth.

---

## Why not use `AttemptError` for `handler_reject`?

You *could* throw `AttemptError` and special-case “don’t retry” — but that blurs:
- **throw** = “try again might work”
- **return** = “I’m deciding the outcome”

Docs and REFACTOR already separate intentional outcomes as **returns** (`DEAD_LETTER`, `MANUAL`). Metadata should follow that: **`deadLetter({ type, message, details })`**, not throw.

`AttemptError` stays for transient/infrastructure failures.

---

## Summary

| Question | Answer |
|----------|--------|
| Is there precedent for failure metadata? | **Yes** — `AttemptError`, `Failure`/`Attempt`, `WorkflowErrorEnvelope` / `ExplicitError` |
| On intentional `DEAD_LETTER` return? | **No** — bare sentinel only; gap to fill |
| Add `invalid_payload`? | **Yes** — engine-owned, before handler |
| Add `handler_reject`? | **Yes** — maps to `return deadLetter({...})` |
| Return metadata with reject? | **Yes, recommended** — `deadLetter({ type?, message?, details? })` mirroring `AttemptError` fields |

If this direction works, next design choices are:

1. **`deadLetter()` only** vs keep `DEAD_LETTER` symbol as shorthand for `deadLetter()`
2. **`DeadLetterRow.details`** on the row vs attempts-only
3. **`payload` typing** when `reason === "invalid_payload"` (raw `JsonInput` vs union)

I can draft the exact types (`DeadLetterOutcome`, updated `QueueHandlerResult`, `DeadLetterReason`, `DeadLetterRow`) when you want to lock those three.

---

**User**

let's trace how the idea behind non-throwing handling. understandably, this is nice conceptually. however, do we really want that in case of the queue message handlers? they don't return anything, the errors aren't supposed to be typed: they are supposed to be random. the metadata, though... we want it typed, but it's hard to settle on an idea of how to treat random errors vs the typed ones (e.g. `RandomJson | TypedError` - there is nothing to discriminate over, since there is no know structure of `RandomJson`). So we end up with a half baked solution. We could enforce typed errors by introducing some kind of a `onException`or `parseException` callback block that promises to return a typed result on all paths - this could be a way to type all the errors - but other than that the current approach seems to take from everywhere, but commit to nothing, which creates modelling ambiguity currently.

---

**Cursor**

Tracing the non-throwing handler design and how it applies (or doesn't) to queues.


The non-throwing pattern is a real design choice for **requests**, but for **queues** it’s been copied without the same foundations — so the modelling ambiguity you’re feeling is justified.

---

## Why “intentional outcomes are returns” exists

The error model inverts the workflow body on purpose:

| Surface | Intentional terminal outcome | Transient / unknown fault |
|---------|------------------------------|---------------------------|
| **Workflow body** | **throw** `ctx.errors.X(...)` | **throw** anything else → **halt** |
| **Handlers** | **return** sentinel (`MANUAL`, `DEAD_LETTER`) | **throw** → retry |

Rationale (from `docs/error-model.md`):

- Retries are tied to **throws**. If permanent rejection were a throw, the engine would need a large `instanceof` table to avoid retrying it.
- **Returns** are explicit control flow: “I’m not saying the operation failed unexpectedly; I’m choosing a different terminal path.”

That works well where the return channel already carries meaning.

### Requests — return channel is natural

```typescript
Promise<TResponse | typeof MANUAL>
```

Success and intentional branch share one typed return union. `MANUAL` is a real alternate outcome, not “void but different.”

### Queues — return channel is awkward

```typescript
Promise<void | typeof DEAD_LETTER>
```

Success is **void**. The only reason to return anything is a sentinel. You’re not returning a value; you’re signalling through the only exit that isn’t a throw. Conceptually neat, ergonomically thin.

So the inversion is borrowed from requests, but queues don’t have a rich success return type — only “done” vs “dead-letter this.”

---

## Where metadata was supposed to live (and doesn’t)

The codebase **does** have a structured failure record — but it’s built around **throws**:

```typescript
interface Failure {
  readonly message: string | null;
  readonly type: string | null;      // loose classifier, not a declared enum
  readonly details: JsonInput | undefined;
}
```

REFACTOR Part 15: engine **extracts** this from whatever was thrown (`AttemptError` → full structure; plain `Error` → name + message; random value → `String(thrown)`).

That’s the honest answer for “random” errors: **don’t type them at the handler boundary**. Type them **loosely on the attempt log** with nullable fields — logging, not a schema.

Permanent reject via `return DEAD_LETTER` breaks that pipeline:

- REFACTOR says an attempt row is still written, but there was **no throw to extract from**.
- So you either add a parallel metadata channel on the return (`deadLetter({ details })`), or you leave `handler_reject` rows with empty attempt diagnostics.

That’s the half-baked part: **return for disposition, throw for metadata**, with no single committed story for queues.

---

## The `RandomJson | TypedError` problem

You’re right that a union like that on the dead-letter row is a dead end without a discriminator.

The workflow body solves this with a **declared map** + `error.code`. Handler failures deliberately **don’t** do that — `Attempt.type` is `string | null`, `details` is `JsonInput | undefined`. It’s observability data, not a public API contract.

So the choice isn’t “typed vs random union on one field.” It’s:

1. **Accept loose attempt records** for everything (typed when author uses `AttemptError`, random otherwise), or  
2. **Introduce a declared queue failure vocabulary** (heavy — starts to look like `ctx.errors` for workers), or  
3. **Normalize at registration time** (`onException` / `parseException`) so the engine always sees a known shape before persisting.

---

## Three coherent models (pick one; current design mixes them)

### A. Throw-only disposition (simplest for void handlers)

Handlers **only return void**. All outcomes go through throw classification:

| Throw | Engine |
|-------|--------|
| (none) | Success |
| `AttemptError` | Retry; structured attempt row |
| `QueueRejectError` (or dedicated class) | **No retry** → dead-letter, `reason: handler_reject` |
| plain `Error` / random | Retry until `max_attempts` |

Metadata for reject: `QueueRejectError` mirrors `AttemptError` (`type`, `message`, `details`). Random faults stay random until exhausted.

**Pros:** One channel (throw); extraction rules already exist; no sentinel return.  
**Cons:** Reverses “intentional = return” for queues only (or globally if topics/requests stay as-is).

`refactor/17_handler_early_termination.ts` actually sketched this for queues (`throw UnrecoverableError`). Docs later moved to `return DEAD_LETTER` — the ambiguity started there.

---

### B. Return disposition, throw-only for transient (current direction)

| Outcome | Mechanism |
|---------|-----------|
| Success | `return` / void |
| Permanent reject | `return deadLetter({ type?, message?, details? })` |
| Transient | `throw` / `AttemptError` |

**Pros:** Clear “don’t retry” without instanceof on throws.  
**Cons:** Two ways to attach structure (return metadata vs `AttemptError` on throws); void success makes returns feel synthetic; metadata on reject duplicates the attempt log unless you define how they relate.

---

### C. Registration-time normalization (`onException` / `parseException`)

Handler throws freely (or returns void on success). Registration classifies:

```typescript
client.queues.emailQueue.registerHandler(handler, {
  retryPolicy: { ... },
  onFailure: (failure: Failure, ctx) => "retry" | "dead_letter",
});
```

Or stricter — promise typed output on all paths:

```typescript
parseFailure: (thrown: unknown) => {
  disposition: "retry" | "dead_letter";
  type?: string;
  message?: string;
  details?: JsonInput;
};
```

Engine always persists a normalized `Failure` first, then applies disposition. Handler code stays messy; **typing lives at the boundary you control** (like `onExhausted` on requests).

**Pros:** Types “all errors” without handler return unions; random throws get normalized once; operators see consistent attempt rows.  
**Cons:** More registration API; handler’s `throw` no longer fully describes outcome without reading opts; two functions to maintain (handler + classifier).

---

## What I’d actually recommend for queues

**Stop treating queues like requests.** For a void handler, **Model A or C** commits to something; **Model B** is the ambiguous middle.

**My lean: A + loose attempt log, with engine-owned `invalid_payload`**

```typescript
// Handler
async (message, { signal }) => {
  if (!canProcess(message)) {
    throw new QueueRejectError("Order cancelled", {
      type: "OrderCancelled",
      details: { orderId: message.orderId },
    });
  }
  await work(message, { signal });
}

// Registration — only retryPolicy + maxConcurrent, no return union
```

Engine rules:

- `QueueRejectError` → dead-letter immediately, `handler_reject`, attempt row from error
- `AttemptError` / `Error` → retry
- decode failure → `invalid_payload`, never calls handler

Dead-letter **reason** is the coarse enum (`handler_reject`, `max_attempts`, `ttl_expired`, `invalid_payload`). **Detail** is always on attempt row(s) using the existing loose `Failure` shape — no `RandomJson | TypedError` union, no discriminator needed.

If you want author-defined typing without a throw class per queue, add **optional C**:

```typescript
onFailure?: (failure: Failure) => "retry" | "dead_letter"
```

…only for cases where `constructor.name === 'TypeError'` should dead-letter instead of retry. Default: retry until exhausted.

---

## What to drop if you commit

| Current bit | If throw-only (A) | If keep return (B) |
|-------------|-------------------|---------------------|
| `DEAD_LETTER` sentinel | Remove | Keep or replace with `deadLetter()` |
| `UnrecoverableError` on queues | Already rejected | Stay rejected |
| Metadata on return | N/A | Must define vs attempt log |
| `QueueHandlerResult` union | `void` only | `void \| DeadLetterOutcome` |

---

## Direct answer to your concern

> takes from everywhere, but commit to nothing

Yes. It takes:

- body’s typed errors (but handlers don’t get `ctx.errors`),
- `AttemptError` structured throws (but tied to retry),
- request `MANUAL` returns (but queues have no `TResponse`),
- topic `UnrecoverableError` throws (then swapped for `DEAD_LETTER` returns),

…and commits to none of them fully for queue permanent failure + metadata.

The way out isn’t a better `RandomJson | TypedError` union. It’s either:

1. **Loose attempt log** for all failures (random is fine), plus a **small set of disposition rules** (throw class or `onFailure`), or  
2. **Registration callback** that normalizes everything to `Failure` + disposition before persistence.

If you want to decide next: **throw-only reject class** vs **`onFailure` classifier** vs **keep return `deadLetter()`** — I can sketch the exact types for whichever you prefer.

---

**User**

I think `parseException` would be a bad design decision. It seems to me it's trivially replaced by:

```typescript
try {
  await doSomething();
} catch (err) {
  throw ctx.error({
    typed: convertToTypedError(err),  // any function that turns an error into the typed error shape expected by the handler definition 
    deadLetter: true,  // set it to true if you want the handler to stop trying and manually dead letter the message
  });
}
```

And this would be traceable and explicit. However, we still potentially are open to unhandled exceptions:

```typescript
// no catch: we don't get the typed error
await doSomething();
```

I think the best shape here would be:

```typescript
type QueueHandlerAttempt<T> = {
  readonly message: string | null;
  readonly type: string | null;      // loose classifier, not a declared enum
  readonly details: JsonInput | undefined;
  readonly typed: T | undefined;  // optional, may be absent, if untyped
  readonly deadLetter: boolean;
}
```

so that we accept that arbitrary exceptions can be untyped by nature and allow the parsing to fail and return undefined, while also allowing partial typing that makes sense for the end user

---

**Cursor**

Your direction is more coherent than the current mix. Here’s how it fits together and what still needs pinning down.

---

## Why `parseException` on registration is the wrong layer

A registration-time classifier hides control flow:

- Handler throws `Error("timeout")` — retry or dead-letter?
- Registration callback decides — not visible in handler code
- Harder to test, harder to read, duplicates logic that belongs in the handler

Your alternative keeps disposition **explicit in the handler**:

```typescript
try {
  await doSomething();
} catch (err) {
  throw ctx.error({
    typed: convertToTypedError(err),
    deadLetter: true,
  });
}
```

That’s traceable: “I caught this, I optionally typed it, I want dead-letter.” Unhandled paths stay honest:

```typescript
await doSomething(); // random throw → untyped attempt, deadLetter: false → retry
```

So: **one channel (throw), two outcomes (retry vs dead-letter)** — no void return sentinel.

---

## `QueueHandlerAttempt<T>` — committing to partial typing

Your shape names the ambiguity instead of papering over it:

```typescript
type QueueHandlerAttempt<T> = {
  readonly attempt: number;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
  readonly typed: T | undefined;   // present only when conversion succeeded
  readonly deadLetter: boolean;
};
```

| Field | Role |
|-------|------|
| `message` / `type` / `details` | Loose diagnostic layer (same as `Failure` / `AttemptError` extraction) — always persistable |
| `typed` | Optional **queue-declared** shape when author bothered to convert |
| `deadLetter` | **Disposition** on this attempt — engine stops retrying when `true` |

No `RandomJson | TypedError` union, no discriminator problem: `typed` is either `T` or absent. Random faults simply leave `typed: undefined`.

`T` comes from an optional slot on the queue definition (like `errors` on workflows, but handler-side and optional):

```typescript
defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  error: z.object({ code: z.string(), orderId: z.string() }), // optional
});
```

If no `error` schema → `T` is `undefined` and `typed` is always absent (attempt log only).

---

## `ctx.error()` — what it should be

Not a registration hook; a **handler-context throw factory** (same family as `ctx.errors.X` on the body, but handler vocabulary):

```typescript
interface QueueHandlerContext<TTyped> {
  readonly signal: AbortSignal;
  error(options: {
    readonly typed?: TTyped;
    readonly deadLetter: boolean;
    readonly message?: string;
    readonly type?: string;
    readonly details?: JsonInput;
  }): QueueHandlerError<TTyped>;
}
```

Handler usage:

```typescript
// Explicit permanent reject with typing
throw ctx.error({
  typed: { code: "ORDER_CANCELLED", orderId: message.orderId },
  deadLetter: true,
  type: "OrderCancelled",
});

// Explicit permanent reject, conversion failed
throw ctx.error({
  typed: undefined,
  deadLetter: true,
  message: err instanceof Error ? err.message : String(err),
  details: { raw: safeSerialize(err) },
});

// Transient — retry, still structured
throw ctx.error({
  deadLetter: false,
  type: "SmtpTimeout",
  details: { host: "smtp.example.com" },
});

// Or plain throw for fully random — no ctx.error
throw err;
```

Engine rules (simple table):

| What handler does | `deadLetter` | Next step |
|-------------------|--------------|-----------|
| Returns normally | — | Success |
| `throw ctx.error({ deadLetter: true, ... })` | `true` | Dead-letter immediately, `reason: handler_reject` |
| `throw ctx.error({ deadLetter: false, ... })` | `false` | Record attempt, retry |
| `throw` anything else | `false` | Extract via Part 15 rules, record attempt, retry |
| Exhausted retries | — | Dead-letter, `reason: max_attempts` |

**Drop `DEAD_LETTER` return** and `QueueHandlerResult = void | sentinel`. Handler return type is **`void` only**.

---

## How this maps to dead-letter reasons

```typescript
type DeadLetterReason =
  | "max_attempts"
  | "ttl_expired"
  | "invalid_payload"   // engine: decode failed, handler never ran
  | "handler_reject";   // last attempt had deadLetter: true
```

- **`invalid_payload`**: engine-only; attempt row with schema `issues` in `details`, `typed: undefined`, `deadLetter: true`
- **`handler_reject`**: handler threw `ctx.error({ deadLetter: true })`; final attempt carries `typed` if provided
- **`max_attempts`**: last attempt(s) had `deadLetter: false`; operator sees full attempt history

Coarse **reason** on the row; rich data on **attempt(s)** — same layering as workflow `failed` + error envelope vs halt diagnostics.

---

## What we’re no longer doing

| Old / ambiguous | New |
|-----------------|-----|
| `return DEAD_LETTER` | `throw ctx.error({ deadLetter: true })` |
| `deadLetter({ details })` return metadata | Same throw, fields on attempt |
| `AttemptError` for permanent reject | `ctx.error({ deadLetter: true })` — or keep `AttemptError` only when `deadLetter: false` |
| `UnrecoverableError` on queues | Gone |
| `parseException` on registration | Gone — handler try/catch is explicit |

Optional: keep `AttemptError` as sugar for `deadLetter: false` only, or fold into `ctx.error` entirely for queues.

---

## Open decisions (small)

1. **`ctx.error` required vs optional** — Can handlers still `throw new AttemptError(...)` for retries, or must everything go through `ctx.error`? Recommendation: plain `throw` still works (untyped retry); `ctx.error` when you want structure and/or `deadLetter`.

2. **`typed` validation** — If queue declares `error` schema, validate `typed` at throw time (like `ctx.errors`)? Recommendation: yes when `typed` is present.

3. **Dead-letter handle surface** — `fetchRow` exposes last attempt / `attempts()` returning `QueueHandlerAttempt<T>[]`? Recommendation: yes — operators read `typed` when present, fall back to loose fields.

4. **Topics** — Keep `UnrecoverableError` + `onConsumeError` separate, or converge later? Queues can lead; topics stay different for now.

---

## Verdict

Your instinct is right:

- **Reject** registration `parseException`
- **Accept** untyped failures as first-class (`typed: undefined`)
- **Commit** to throw + `deadLetter` flag on the attempt record
- **Optional** `T` via queue definition + explicit conversion in handler

That removes the “takes from everywhere, commits to nothing” problem: queues get **void success, throw-only failure, loose attempt log + optional typed slot, boolean disposition**.

If you want to lock this, next step is typing `QueueHandlerContext<TTyped>`, `QueueHandlerError`, `QueueHandlerAttempt<T>`, update `QueueHandlerResult` to `void`, and define `invalid_payload` + `handler_reject` on `DeadLetterReason`. I can implement that in `handlers.ts` / `messaging.ts` / `schema.ts` when you say go.

---

**User**

1. I feel like we should get rid of AttemptError and UnrecoverableError at this point. We either are aware of the error we're getting and exactly where we do, and thus we can `try { } catch () {}` around it rethrowing an appropriate `ctx.error`, or the error is unknown to us pre-runtime, meaning we fall back on a safe default for the type, message and details fields, while the `typed` remains undefined and `deadLetter` remains false. This seems to be the best default behavior overall.
2. `typed` validation happens automatically before it's saved to the database. This could mean a serialization error, which we may also somehow intricately weave into the design.
3. we want fetchRow to expose the typed error where available, and it's important to highlight that not only the last error is bound to be typed: we can `throw ctx.error({ typed: T, deadLetter: false })` as well.
4. let's not consider topics right now.

---

**Cursor**

Here’s the queue error model locked to your four points, plus the serialization edge case and what it implies for the rest of the codebase.

---

## Queue handler error model (locked)

### Handler contract

- **Return:** `void` only — no `DEAD_LETTER`, no sentinel returns.
- **Success:** normal return.
- **Failure:** always **throw** — either `ctx.error({...})` or an unhandled exception.

### `ctx.error()` — the only intentional failure API

```typescript
interface QueueHandlerContext<TTyped> {
  readonly signal: AbortSignal;
  error(options: {
    readonly typed?: TTyped;
    readonly deadLetter: boolean;
    readonly message?: string;
    readonly type?: string;
    readonly details?: JsonInput;
  }): QueueHandlerError;
}
```

```typescript
try {
  await doSomething();
} catch (err) {
  throw ctx.error({
    typed: convertToTyped(err),  // T | undefined — conversion may fail
    deadLetter: true,
    message: ...,
    type: ...,
    details: ...,
  });
}
```

### Default behavior for unhandled throws

No `try/catch`, plain `throw err`, library throws, etc.:

| Field | Value |
|-------|--------|
| `message` / `type` / `details` | Safe extraction (Part 15-style: `Error.message`, `constructor.name`, etc.) |
| `typed` | `undefined` |
| `deadLetter` | `false` → **retry** per policy |

No `AttemptError`, no `UnrecoverableError` on the queue handler surface. Authors who care wrap and rethrow `ctx.error`.

---

## 1. Removing `AttemptError` / `UnrecoverableError`

**For queues:** agreed — remove from queue handler vocabulary entirely.

**Scope note:** `AttemptError` still exists today on **steps**, **requests**, and (per old sketch) **topics**. This decision is **queue-handler-specific** unless you want a follow-up to migrate those surfaces to their own `ctx.error` equivalents. For now:

| Surface | Error API |
|---------|-----------|
| Queue handlers | `ctx.error` only |
| Steps / requests / topics | unchanged until separately redesigned |

Queue regression tests and docs drop `DEAD_LETTER`, `AttemptError`, and `UnrecoverableError` for queues.

---

## 2. `typed` validation + serialization failures

When handler throws `ctx.error({ typed: value, ... })`:

1. Engine validates/encodes `typed` against optional `error` schema on `defineQueue` **before** persisting.
2. On success → `QueueHandlerAttempt.typed = encoded/decoded `T`` as stored.
3. On validation/serialization failure → weave into the attempt rather than crashing the worker:

Proposed rule (fits “partial typing is OK”):

| Outcome | Attempt record |
|---------|------------------|
| `typed` validates | `typed: T`, loose fields as provided |
| `typed` fails validation | `typed: undefined`, `details` includes schema issues (Standard Schema `issues` or normalized form), `type: "TypedValidationFailed"` (or similar), **`deadLetter` unchanged** from what handler requested |

Rationale: a bad `typed` payload is usually a handler bug; if they set `deadLetter: true` it still dead-letters; if `false`, retrying won’t fix a deterministic bug — you may later add “validation failed → force deadLetter” but v1 can document “don’t pass malformed `typed`”.

`defineQueue` optional slot:

```typescript
defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  error: z.object({ code: z.string(), orderId: z.string() }), // optional → TTyped
  defaultDelay?: number | Date | 0,
  defaultTtl?: number | Date | null,
});
```

---

## 3. `QueueHandlerAttempt<T>` + `fetchRow`

Persisted per-try shape:

```typescript
type QueueHandlerAttempt<TTyped> = {
  readonly attempt: number;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
  readonly typed: TTyped | undefined;
  readonly deadLetter: boolean;
};
```

Important: **`typed` is not only on the final dead-letter attempt.** Any try can carry it:

```typescript
throw ctx.error({
  typed: { code: "SMTP_TIMEOUT", attempt: 3 },
  deadLetter: false,  // retry — but operators see typed history
});
```

**`fetchRow`** on dead-letter handle (and/or **`attempts()`** on the handle) should expose:

- Row scalars: `reason`, `payload`, priority, timestamps, …
- **Attempt history:** `QueueHandlerAttempt<T>[]` — any attempt may have `typed` set
- Convenience: `lastAttempt`, or `typed` on row = **last attempt’s `typed`** when present (document which)

Dead-letter **reason** stays coarse; rich data lives on attempts.

---

## Engine disposition table

| Event | `deadLetter` on attempt | Queue message outcome |
|-------|-------------------------|------------------------|
| Handler returns | — | `processed` |
| `throw ctx.error({ deadLetter: false })` | `false` | retry |
| Unhandled throw | `false` | retry |
| Retries exhausted | last attempts `false` | dead-letter, `max_attempts` |
| `throw ctx.error({ deadLetter: true })` | `true` | dead-letter immediately, `handler_reject` |
| TTL / expiry | — | `ttl_expired` |
| Decode/validate before handler | `true` (engine) | `invalid_payload` |

```typescript
type DeadLetterReason =
  | "max_attempts"
  | "ttl_expired"
  | "invalid_payload"
  | "handler_reject";
```

---

## Still locked from earlier (queues only)

| Topic | Decision |
|-------|----------|
| Enqueue `delay` / `ttl` | `number \| Date \| 0` / `number \| Date \| null` |
| `defineQueue` defaults | `defaultDelay` (default `0`), `defaultTtl` |
| Handler registration | Client only — remove `QueueDefinition.registerHandler` |
| Compensation `undo` | Wire `TQueues` into `CompensationContext` |
| `retryPolicy` on registration | Still open — recommend required |

---

## What to implement next (when you say go)

1. `QueueHandlerContext`, `QueueHandlerError`, `QueueHandlerAttempt<T>`
2. `defineQueue({ message, error?, defaultDelay?, defaultTtl? })`
3. `QueueEnqueueOptions` with `delay` / `ttl` unions
4. Remove `DEAD_LETTER`, `QueueHandlerResult` union, queue use of `AttemptError`/`UnrecoverableError`
5. `DeadLetterReason` + `DeadLetterRow` (payload typing for `invalid_payload`)
6. `DeadLetterHandleExternal.attempts()` and/or `fetchRow` fields for typed + attempt history
7. Wire compensation `TQueues`
8. Update `13_queues.ts` + `docs/queues.md`

Topics explicitly out of scope.

If you want implementation next, say the word; otherwise the only remaining product choice is **`retryPolicy` required vs optional** on `registerHandler`.

---

**User**

what if we did:

```typescript
readonly typed: { type: "typed", value: TTyped } | SerializationError | undefined;
```

with `SerializationError` being

```typescript
type GenericError = {
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
};

type SerializationError = {
  type: "serialization_error";
  error: GenericError;
};
```

Something like this. It may be too verbose. But I've kind of been aiming at the best observability, so that the reasons for failure are apparent without looking at the logs. What do you think?

---

**Cursor**

Reviewing how errors and attempts are modeled in the codebase so the recommendation fits existing patterns.


I think the direction is right. The discriminated union solves a real problem my earlier “downgrade to `undefined`” sketch handled poorly: **you must not overwrite the attempt’s top-level `message` / `type` / `details` when `typed` fails to persist.** Those fields should stay what the handler meant; the typed-slot failure is a separate fact.

---

## What works well

**Three clear states for the typed slot**

| `typed` | Meaning |
|---------|---------|
| `undefined` | No typed payload was offered (unhandled throw, or `ctx.error` without `typed`) |
| `{ type: "typed", value: T }` | Typed slot validated and stored |
| `{ type: "serialization_error", error: GenericError }` | Handler offered `typed`, engine could not validate/encode it |

That last case is visible in `fetchRow` / `attempts()` without log diving — which matches your observability goal.

**Fits existing patterns.** Workflow errors already use a `type` discriminator (`ExplicitError`). Queue attempts would use the same “tagged outcome” style for the optional typed slot.

**Preserves handler intent on the attempt row:**

```typescript
throw ctx.error({
  typed: { code: "SMTP_TIMEOUT", orderId: "o-1" }, // fails schema
  deadLetter: false,
  message: "SMTP timed out",
  type: "SmtpError",
});
```

You get:

- Top-level: `message`, `type`, `details` from the handler (operational context)
- `typed`: `{ type: "serialization_error", error: { type: "...", details: { issues: [...] } } }` (persistence/validation context)

No conflation, no silent loss of “they tried to type this.”

---

## Verbosity: real, but manageable

The wrapper on success is the main cost:

```typescript
attempt.typed?.type === "typed" ? attempt.typed.value : undefined
```

That’s acceptable if:

1. **`GenericError` is shared** with attempt loose fields (same shape as `Pick<Failure, "message" | "type" | "details">` or a named alias used everywhere).
2. **Helpers exist** on the dead-letter handle / attempt accessor, e.g. `typedValue(attempt)`, `isTypedSerializationError(attempt.typed)` — operators use those; app code rarely pattern-matches by hand.

I wouldn’t avoid the union to save typing; I’d avoid **duplicating** `GenericError` under a different name in three places.

---

## Small refinements I’d consider

**1. Discriminator naming**

`type: "typed"` is a bit self-referential. Alternatives that read better in UIs:

- `{ type: "value", value: T }` — short
- `{ type: "ok", value: T }` — mirrors Result-style naming
- Keep `"typed"` if you want symmetry with `serialization_error` as “what went wrong in the typed column”

Any of these is fine; consistency matters more than the exact string.

**2. `serialization_error` vs `validation_error`**

The failure mode is schema validation / JSON encode before DB write. `serialization_error` is fine as an umbrella term; if you want operator clarity, `typed_validation_failed` is more explicit. One name, documented once.

**3. `deadLetter` when serialization fails**

I’d still **honor the handler’s `deadLetter`** on the attempt record, but document that `serialization_error` is almost always a handler bug (retry won’t fix a deterministic bad shape). Optional later: engine policy “serialization_error → treat as `handler_reject`” — not required for v1 if the union is visible.

**4. What goes in `serialization_error.error.details`**

For best observability: Standard Schema `issues`, plus a **sanitized** snapshot of what was rejected (not necessarily the full raw object if it’s huge). That’s what makes this better than logs.

---

## Suggested shape (slightly tightened)

```typescript
type GenericError = {
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
};

type TypedSlot<TTyped> =
  | { readonly type: "value"; readonly value: TTyped }
  | { readonly type: "serialization_error"; readonly error: GenericError };

type QueueHandlerAttempt<TTyped> = {
  readonly attempt: number;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
  readonly typed: TypedSlot<TTyped> | undefined;
  readonly deadLetter: boolean;
};
```

(`"value"` instead of `"typed"` — optional bikeshed.)

---

## Verdict

Not too verbose for what you’re optimizing for. The union is the right place to put serialization failure: it’s **about the typed column**, not about replacing the attempt’s primary error surface. `undefined` vs `serialization_error` is the distinction operators need.

I’d adopt this. The main implementation choices left are discriminator strings and whether `GenericError` is a shared exported alias tied to `Failure`. If you want to proceed, we can fold this into the queue types + `13_queues.ts` spec next.

---

**User**

a typed error serialization_error is different conceptually from not being able to handle a message. in this case we've handled the message successfully and decided that an error is an adequate response. but the error itself wasn't serializable the way we expected it to be: so we cannot provide the typed record, but we can still provide the rest of the data that was available, while also attaching the error that happened during serialization. so this doesn't really affect handler logic, rather subtly breaks observability.

Maybe we did this?

```
type Typed<T> = {
  ok: true,
  status: "serialized",
  result: T,
} | {
  ok: false,
  status: "serialization_error",
  error: BaseError,
} | {
  ok: false,
  status: "unspecified",
};
```

---

**Cursor**

Yes — that framing is the right one, and the `Typed<T>` union captures it well.

**Serialization failure is a metadata defect, not a handler failure.** The handler already did its job: it returned an intentional outcome via `ctx.error` (or an unhandled throw was classified). Disposition (`deadLetter`, retry vs dead-letter) follows that decision. The only thing that breaks is the *optional typed column* — operators lose structured `T`, but they still get the loose fields the handler supplied, plus an explicit record of why `T` could not be stored.

That’s subtly different from `invalid_payload` (message never runnable) and from “handler failed” in any operational sense.

---

## Your `Typed<T>` shape

```typescript
type BaseError = {
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
};

type Typed<T> =
  | { ok: true; status: "serialized"; result: T }
  | { ok: false; status: "serialization_error"; error: BaseError }
  | { ok: false; status: "unspecified" };
```

This works. The three statuses are the right mental model:

| `status` | Meaning |
|----------|---------|
| `"serialized"` | Handler offered `typed`, engine validated/encoded it |
| `"serialization_error"` | Handler offered `typed`, engine could not persist it |
| `"unspecified"` | Handler did not offer `typed` (unhandled throw or `ctx.error` without `typed`) |

**Attempt row on serialization failure** (handler logic unchanged):

```typescript
{
  attempt: 2,
  message: "SMTP timed out",           // from ctx.error — preserved
  type: "SmtpError",                   // preserved
  details: { host: "smtp.example" },   // preserved
  deadLetter: false,                   // honored as thrown
  typed: {
    ok: false,
    status: "serialization_error",
    error: { message: "...", type: "SchemaValidationFailed", details: { issues: [...] } },
  },
}
```

Observability is degraded in one narrow place (`result` missing), not the whole attempt.

---

## `ok` + `status`: keep or drop?

`status` alone is enough for TypeScript narrowing:

```typescript
type Typed<T> =
  | { status: "serialized"; result: T }
  | { status: "serialization_error"; error: BaseError }
  | { status: "unspecified" };
```

`ok` is redundant with `status` but nice for dashboards and quick checks (`typed.ok`). If you keep both, make `ok` derivable so they can’t disagree — e.g. `ok: status extends "serialized" ? true : false` via a helper type, or document that `ok === (status === "serialized")`.

Leaning: **`status` as the canonical discriminant**, optional `ok` only if you really want it for JSON consumers who don’t like string tags.

---

## Always present vs `undefined`

Your `"unspecified"` variant replaces `typed: undefined`. I’d adopt that:

```typescript
type QueueHandlerAttempt<T> = {
  readonly attempt: number;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
  readonly typed: Typed<T>;   // always set
  readonly deadLetter: boolean;
};
```

Every attempt has an explicit typed-slot story; no ambiguity between “field omitted” and “handler didn’t use typed.”

---

## `BaseError`

Good name if it’s the shared loose-error carrier (attempt top-level fields + `serialization_error.error`). Could alias:

```typescript
type BaseError = Pick<Failure, "message" | "type" | "details">;
```

so queue attempts and steps share one shape without duplicating docs.

---

## What this does *not* change

| Concern | Behavior |
|---------|----------|
| Handler disposition | `deadLetter` from `ctx.error` / default for unhandled |
| Retry / dead-letter reason | `max_attempts`, `handler_reject`, etc. — unchanged |
| Attempt loose fields | Always populated when available; serialization doesn’t clobber them |
| `invalid_payload` | Pre-handler; no attempts from handler; different path entirely |

---

**Verdict:** Yes — this is the design I’d lock. Conceptually clean, observability-first, and handler semantics stay stable when serialization fails. Next step when implementing: add `Typed<T>`, `BaseError`, wire into `QueueHandlerAttempt<T>`, and regression-test the three `typed.status` branches plus “loose fields preserved on serialization_error.”

---

**User**

`ok` is a way to write fast code:

```typescript
if (attempt.typed.ok) {
  // some logic
} else {
  // a generic fallback - no decision can be made
}
```

Otherwise we'd have to handle specific statuses for no apparent reason.

It seems like we've locked in on the design. Confirm if correct.

There was also the pending question of the `retryPolicy`. What was that about?

---

**Cursor**

## Design confirmation

Yes — this is locked for **queues** (topics still out of scope). Summary:

### Handler contract
- Return **`void`** only; failures via **throw**.
- Intentional failure: **`throw ctx.error({ ... })`**.
- Unhandled throw: safe extraction into loose fields, **`typed: { ok: false, status: "unspecified" }`**, **`deadLetter: false`** → retry.

### `ctx.error()`
```typescript
error(options: {
  typed?: TTyped;
  deadLetter: boolean;
  message?: string;
  type?: string;
  details?: JsonInput;
}): QueueHandlerError;
```

### Attempt record
```typescript
type BaseError = {
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
};

type Typed<T> =
  | { ok: true; status: "serialized"; result: T }
  | { ok: false; status: "serialization_error"; error: BaseError }
  | { ok: false; status: "unspecified" };

type QueueHandlerAttempt<T> = BaseError & {
  readonly attempt: number;
  readonly typed: Typed<T>;
  readonly deadLetter: boolean;
};
```

**`ok`** is intentional: fast path for “can I use structured `T`?” vs generic fallback. **`status`** is the precise discriminant when you need it.

Serialization failure does **not** change handler disposition; it only degrades the typed slot while preserving loose fields + `serialization_error.error`.

### Removed from queue surface
`DEAD_LETTER`, `AttemptError`, `UnrecoverableError` (queue handlers only).

### Dead-letter reasons
`max_attempts` | `ttl_expired` | `invalid_payload` | `handler_reject`

### Definition / enqueue (also locked earlier)
- `defineQueue({ message, error?, defaultDelay?, defaultTtl? })` — no `registerHandler` on definition.
- Enqueue: `delay`, `ttl` as `number | Date | 0` / `number | Date | null`.
- Compensation `undo` gets `TQueues`.
- `fetchRow` / `attempts()` expose full attempt history; any attempt may have `typed.ok === true`.

---

## The `retryPolicy` question

When you **`registerHandler`**, should **`retryPolicy` be required or optional?**

Today in types it’s **optional**:

```32:35:src/types/definitions/messaging.ts
export interface QueueHandlerRegistrationOptions {
  readonly retryPolicy?: HandlerRetryOptions;
  readonly maxConcurrent?: number;
}
```

`HandlerRetryOptions` is `RetryPolicyOptions` + optional **`maxAttempts`**:

```48:50:src/types/definitions/handlers.ts
export interface HandlerRetryOptions extends RetryPolicyOptions {
  readonly maxAttempts?: number;
}
```

For **steps**, that split is deliberate: `retryPolicy` = *how* to retry; *when* to stop is on the **call site** (`timeout` / `maxAttempts` on the step boundary). Steps can retry until success unless the caller caps them.

For **queues**, there is no call site — registration **is** the only configuration point. So:

| If `retryPolicy` is **optional** | If `retryPolicy` is **required** |
|----------------------------------|-----------------------------------|
| Engine must define defaults for `maxAttempts`, `timeoutSeconds`, backoff, etc. | Author must pass an explicit policy at registration |
| Risk: silent “retry forever” or surprising defaults if `maxAttempts` defaults to ∞ | No registration without stating retry limits |
| Matches topics/requests (optional today) | Matches **request compensation** handlers, which already require `retryPolicy` |

The open product choice is really: **must queue workers explicitly declare `maxAttempts` (and likely `timeoutSeconds`)**, or can they omit `retryPolicy` and inherit engine defaults?

**Lean recommendation for queues:** **`retryPolicy` required**, at minimum **`maxAttempts`** and **`timeoutSeconds`**, because:
1. Queue messages are independent work items — unlike steps, nothing upstream caps retries for you.
2. `maxAttempts` directly drives dead-lettering (`max_attempts`); leaving it implicit is an operational footgun.
3. Registration is already an explicit “I’m operating this queue” moment — good place to force the decision.

Optional fields *inside* `retryPolicy` (`intervalSeconds`, `backoffRate`, …) can still default; the question is whether you can omit the whole block.

If you want symmetry with request compensation, required wins. If you want minimal registration boilerplate for dev/test handlers, optional + documented defaults is fine — but you’d need to nail **`maxAttempts` default** (e.g. `5` vs unbounded).

What’s your preference: **required** at registration, or **optional** with engine defaults?

---

**User**

Yeah I think that DX-wise we want to make the developer aware of what they are doing with the retries. I think it's important to make them decide on register explicitly. But at the same time we should enable them to set a "retry forever" policy as well.

---

**Cursor**

Checking how retry limits are modeled elsewhere so we can align the "retry forever" option with existing patterns.


That lines up well. Here’s the locked shape:

## `retryPolicy` at registration

**Required** — omitting it is a type error. Registration is the configuration point; there is no caller to cap retries later.

**`maxAttempts` is the explicit decision**, with a deliberate escape hatch:

```typescript
type QueueHandlerRetryPolicy = RetryPolicyOptions & {
  /**
   * Attempt cap before dead-letter (`max_attempts`).
   * `null` = no attempt cap — retry until success, `ttl_expired`, or `handler_reject`.
   */
  readonly maxAttempts: number | null;
};

interface QueueHandlerRegistrationOptions {
  readonly retryPolicy: QueueHandlerRetryPolicy; // required
  readonly maxConcurrent?: number;
}
```

Examples:

```typescript
// bounded — typical production
client.queues.email.registerHandler(handler, {
  retryPolicy: {
    maxAttempts: 5,
    timeoutSeconds: 30,
    intervalSeconds: 1,
    backoffRate: 2,
  },
});

// explicit forever — author must opt in
client.queues.email.registerHandler(handler, {
  retryPolicy: {
    maxAttempts: null,
    timeoutSeconds: 30,
  },
});
```

`maxAttempts: null` is not “we forgot to set it”; it is an explicit forever policy. Omitting `retryPolicy` entirely remains invalid.

## What “forever” means (and doesn’t)

| Still applies | Not limited by `maxAttempts: null` |
|---------------|-------------------------------------|
| Message `ttl` → `ttl_expired` | Transient failures (`deadLetter: false`) |
| `throw ctx.error({ deadLetter: true })` → `handler_reject` | |
| `invalid_payload` (pre-handler) | |
| Per-attempt `timeoutSeconds` (if set) | |

So forever means **no attempt-count dead-letter**, not immunity to expiry or intentional dead-letter.

## Other `retryPolicy` fields

`intervalSeconds`, `backoffRate`, `maxIntervalSeconds`, `timeoutSeconds` can stay **optional with engine defaults** — the mandatory choice is **`maxAttempts: number | null`**. If you later want stricter DX, you can require `timeoutSeconds` too; that wasn’t part of this decision.

## Queue-specific type

Use a queue-specific `QueueHandlerRetryPolicy` rather than reusing optional `HandlerRetryOptions` from topics/requests. Topics are out of scope; queues get the stricter contract now.

---

**Updated lock-in:** `retryPolicy` required at `registerHandler`; `maxAttempts: number | null` with `null` = retry forever. Ready to implement when you say go.

---

**User**

ok. list the api changes we've locked in on so far to verify we're on the same page refactor-wise.

---

**Cursor**

Gathering the current API surface so the locked-in changes list matches what's in the codebase.


## Locked API changes (refactor checklist)

Scope: **queues** (primary), plus **child/external workflows** (already landed in types). **Topics** explicitly out of scope.

---

### `defineQueue`

| | Today | Locked |
|---|--------|--------|
| **Shape** | `{ name, message, ttlSeconds? }` | `{ name, message, error?, defaultDelay?, defaultTtl? }` |
| **`error`** | — | Optional Standard Schema for handler `typed` slot (`TTyped`) |
| **`defaultDelay`** | — | `number \| Date \| 0`, default `0` (immediate) |
| **`defaultTtl`** | — | `number \| Date \| null`; omit ⇒ enqueue must pass `ttl` |
| **`ttlSeconds`** | On definition | **Removed** — replaced by `defaultTtl` |
| **`registerHandler`** | Stub on definition | **Removed** — client-only registration |

Definition is **data-only** (name, message, optional error schema, delivery defaults).

---

### Workflow enqueue — `ctx.queues.<slot>.enqueue`

| | Today | Locked |
|---|--------|--------|
| **Return** | `void` | `void` (unchanged) |
| **Options** | `{ priority?, delaySeconds?, scheduledAt?, ttlSeconds? }` via `ScheduledDeliveryOptions` | `{ priority?, delay?, ttl? }` |
| **`delay`** | `delaySeconds` / `scheduledAt` (mutually exclusive) | `number \| Date \| 0` — omit/`0` = immediate; number = commit-relative logical clock |
| **`ttl`** | `ttlSeconds?: number` | `number \| Date \| null` — omit ⇒ `defaultTtl`; `null` = never expires; number = wall-clock at commit (persisted `expires_at`) |

---

### Handler registration — `client.queues.<definitionName>.registerHandler`

| | Today | Locked |
|---|--------|--------|
| **Location** | Client (+ definition stub) | **Client only** |
| **Return type** | `void \| DeadLetterSentinel` | **`void` only** |
| **`DEAD_LETTER`** | Sentinel return | **Removed** |
| **`AttemptError` / `UnrecoverableError`** | Throw for transient / (misused) permanent | **Removed** from queue handlers |
| **Failure API** | throw / return sentinel | **`throw ctx.error({ ... })`** |
| **`retryPolicy`** | Optional `HandlerRetryOptions` | **Required** `QueueHandlerRetryPolicy` |
| **`maxAttempts`** | Optional `number` | **Required** `number \| null` — `null` = retry forever (still subject to message `ttl`, `handler_reject`, etc.) |
| **`maxConcurrent`** | Optional | Optional (unchanged) |

**`ctx.error()`** on handler context:

```typescript
error(options: {
  typed?: TTyped;
  deadLetter: boolean;
  message?: string;
  type?: string;
  details?: JsonInput;
}): QueueHandlerError;
```

**Disposition:**

| Handler action | Outcome |
|----------------|---------|
| Normal return | Success |
| `throw ctx.error({ deadLetter: true })` | Immediate dead-letter, `handler_reject` |
| `throw ctx.error({ deadLetter: false })` | Record attempt, retry |
| Unhandled throw | Safe loose fields, `typed.status: "unspecified"`, `deadLetter: false`, retry |

---

### Handler context — `QueueHandlerContext`

| | Today | Locked |
|---|--------|--------|
| **Fields** | `{ signal }` only | `{ signal, error }` |
| **Types exported** | `QueueHandlerContext`, `QueueHandlerResult`, `DeadLetterSentinel` | `QueueHandlerContext`, `QueueHandlerError`; drop result union + sentinel |

---

### Attempt records — `QueueHandlerAttempt<T>`

New shared shapes:

```typescript
type BaseError = {
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
};

type Typed<T> =
  | { ok: true; status: "serialized"; result: T }
  | { ok: false; status: "serialization_error"; error: BaseError }
  | { ok: false; status: "unspecified" };

type QueueHandlerAttempt<T> = BaseError & {
  readonly attempt: number;
  readonly typed: Typed<T>;   // always present
  readonly deadLetter: boolean;
};
```

- **`typed.ok`** — fast path: structured `T` vs generic fallback.
- **Serialization failure** does **not** change handler disposition; loose fields preserved; only typed slot degrades.
- **Any attempt** may carry `typed.ok === true`, not only the last.

Exposed via dead-letter handle **`attempts()`** and/or **`fetchRow`** (attempt history on the row).

---

### Dead letters

| | Today | Locked |
|---|--------|--------|
| **`DeadLetterReason`** | `"max_attempts" \| "ttl_expired" \| "unrecoverable"` | `"max_attempts" \| "ttl_expired" \| "invalid_payload" \| "handler_reject"` |
| **`invalid_payload`** | — | Schema decode fails **before** handler runs; no handler attempts |
| **`handler_reject`** | — | `ctx.error({ deadLetter: true })` |
| **`unrecoverable`** | Dead-letter reason | **Removed** (was conflated with topic `UnrecoverableError`) |
| **Handle API** | `fetchRow`, `retry`, `purge`, query namespace | Same verbs; **`fetchRow` / `attempts()`** include typed attempt history |
| **`retry()`** | Exists | Reuse persisted expiry (lean; not re-decided) |

`DeadLetterRow` may grow attempt/typed fields as needed for `fetchRow`; payload typing for `invalid_payload` TBD at implementation.

---

### Compensation — `undo` context

| | Today | Locked |
|---|--------|--------|
| **`ctx.queues`** in `undo` | `CompensationContext` has `TQueues` slot, but `StepCompensationDefinition.undo` passes `Record<string, never>` at position 6 | **Wire `TQueues`** from step compensation definition into `undo` ctx |

`ctx.queues.<slot>.enqueue(...)` becomes available in compensation undo when the workflow declares queues.

---

### Child / external workflows (already in types)

For same-page refactor context — **done**, not pending:

- **`ctx.childWorkflows.<name>(...)`** — parent-owned, awaitable, no `idempotencyKey`, no `.start()`
- **`ctx.externalWorkflows.<name>.get/.start`** — independent roots, `ExternalWorkflowHandle`
- **`workflowHandle.childWorkflows.<name>`** — operator introspection (not `.attached.<name>`)
- Removed deprecated: `ChildWorkflowAccessor`, detached-child types, `InferWorkflowAttachedChildren` / `DetachedChildren`

---

### Explicitly **not** locked / deferred

- Topics (consumers, `UnrecoverableError`, etc.)
- Row retention on `defineQueue`
- `ctx.workflowStartedAt` for `ttl: Date` patterns
- Registration-level `parseException` / `onFailure` callbacks
- Whether `timeoutSeconds` is required inside `retryPolicy` (only `maxAttempts` is required so far)

---

### Files that will move (when implementing)

`src/types/definitions/messaging.ts`, `handlers.ts`, `results.ts` (or new queue-error types), `schema.ts`, `engine.ts`, `definitions/steps.ts`, `workflow.ts` (`defineQueue`), `src/types-regression-tests/13_queues.ts`, `docs/queues.md`, `docs/queues_divergence.md`

---

If anything on this list doesn’t match your intent, flag it before implementation — the rest reads as a single coherent queue refactor tranche.

---

**User**

let's go ahead and proceed with the implementation.

---

**Cursor**

Implementing the locked queue API changes. Exploring the codebase to map all touchpoints.


Implementing the type changes across the codebase.


Using a phantom `__hasDefaultTtl` flag so optional `defaultTtl` is detected reliably at the type level.


---

**User**

can we try to get to the heart of the issue of why the type system isn't aware of  defaultTtl being set? because we already have the `HasIdempotencyFactory` which kind of does a similar thing

---

**Cursor**

Tracing how `HasIdempotencyFactory` propagates through the workflow types versus how `defaultTtl` flows into `ctx.queues`.


Identifying the issue: `__hasDefaultTtl` is optional on the declared return type, so TypeScript can't narrow it—unlike `HasIdempotencyFactory`, which uses an inferred generic with a sentinel default. Implementing the same pattern with a `TDefaultTtl` generic.


Enqueue errors are fixed. Updating client queue namespace inference for the 4th generic parameter.


## Root cause

Two separate problems stacked on each other.

### 1. Optional properties can't carry "was this set?" information

`defaultTtl?: number | Date | null` always means the property type is effectively `number | Date | null | undefined` — whether you pass `86400` or omit the field. TypeScript has no built-in way to say "this optional key was present at the call site."

So checks like:

```typescript
TQueues[K] extends { defaultTtl: number | Date | null }
```

fail for the wrong reason: optional fields don't guarantee presence.

### 2. The `__hasDefaultTtl` phantom couldn't work either

We tried runtime `__hasDefaultTtl: true`, but `defineQueue`'s **declared return type** was always:

```typescript
QueueDefinition<TName, TMessageSchema, TErrorSchema>  // __hasDefaultTtl?: true — always optional
```

TypeScript doesn't narrow the return type from a conditional spread. The phantom was erased at the type level before it reached `ctx.queues`.

### Why `HasIdempotencyFactory` works

It doesn't inspect optional properties. It uses an **inferred generic with a sentinel default**:

```typescript
// defineWorkflow generic — defaults to "absent"
TIdempotencyKeyFactory extends (args: ...) => string = (args: ...) => never

// When omitted → stays `(args) => never`
// When passed  → inferred to the real factory function

HasIdempotencyFactory<W> =
  InferIdempotencyKeyFactory<W> extends (args: never) => never ? false : true
```

Discrimination is on the **4th type parameter's value**, not on whether a property exists on the object shape.

---

## Fix (same pattern)

**4th generic on `QueueDefinition` / `defineQueue`:**

```typescript
TDefaultTtl extends number | Date | null | undefined = undefined
```

- `defineQueue({ ..., defaultTtl: 86400 })` → `TDefaultTtl = 86400`
- `defineQueue({ ... })` without `defaultTtl` → `TDefaultTtl = undefined` (default)

**Helper in `helpers.ts`:**

```typescript
export type HasDefaultTtl<Q> = Q extends QueueDefinition<string, any, any, infer TDefaultTtl>
  ? [TDefaultTtl] extends [undefined] ? false : true
  : false;
```

**`QueueAccessor` wiring:**

```typescript
HasDefaultTtl<TQueues[K]> extends true
  ? QueueAccessor<TMessageSchema, true>   // ttl optional on enqueue
  : QueueAccessor<TMessageSchema, false>  // ttl required
```

Also fixed `WorkflowClientQueueNamespacesFromUnion` — it was still matching `QueueDefinition` with only 3 type params, which broke client namespace keys once we added the 4th.

`pnpm typecheck` is green. Regression tests now assert `HasDefaultTtl<typeof emailQueue>` is `true` and `false` for queues without `defaultTtl`.

---

**User**

we need to add `ctx.error` type regression tests for the queues as well. 

---

**Cursor**

Reviewing `04_error_model.ts` for patterns, then adding `ctx.error` regression tests.


Adding a dedicated `ctx.error` regression section mirroring `04_error_model.ts` and `05_attempt_accessor.ts`.


---

**User**

damn. we completely forgot about the case when the error type schema isn't specified. and it's an important case. I think this should mean that `typed` becomes missing from the object. what do you think?

---

**Cursor**

Reviewing how `typed` is wired when no error schema is declared, then recommending and implementing the right conditional shape.


Agreeing: without an `error` schema, `typed` shouldn't exist on `ctx.error()` — mirroring workflow `ctx.errors` (declared only). Implementing with `never` as the sentinel, like `HasIdempotencyFactory`.


Updating regression tests and fixing the broken `ctx.error` section.


Yes — that's the right call, and it's now reflected in the types.

## Why `typed?: unknown` was wrong

Without an `error` schema, allowing `typed` on `ctx.error()` implied a structured slot exists when nothing was declared to validate or persist it. That's the same mistake as optional properties carrying "was this set?" — it looks flexible but means nothing at the type level.

Parallels workflow `ctx.errors`: structured errors only exist when you declare them.

## Locked behavior

| Queue definition | `ctx.error({...})` | Attempt `typed` slot |
|------------------|--------------------|----------------------|
| **With `error` schema** | `deadLetter` + optional `typed` + loose fields | `serialized` / `serialization_error` / `unspecified` |
| **No `error` schema** | `deadLetter` + loose fields only — **no `typed` key** | always `{ ok: false, status: "unspecified" }` |

`serialization_error` can't happen without a schema — there's no typed column to fail.

## Type-level mechanism (same family as `HasIdempotencyFactory`)

- `InferQueueTypedError<Q>` → schema output type, or **`never`** when no `error`
- `HasQueueErrorSchema<Q>` → `true` / `false`
- `QueueHandlerErrorOptions<never>` = loose options only (no `typed`)
- `QueueHandlerErrorOptions<T>` when `T` is not `never` = loose options **&** `{ typed?: T }`
- `Typed<never>` collapses to `{ ok: false, status: "unspecified" }` only

Handlers on no-schema queues are `QueueHandlerContext<never>`; `@ts-expect-error` rejects `typed` in regression tests.

## Helpers added

- `InferQueueTypedError<Q>`
- `HasQueueErrorSchema<Q>`

`pnpm typecheck` passes with the updated `13_queues.ts` `ctx.error` regression block.

---

**User**

are we done with the queues? any inconsistencies still? have we managed to write type assertion tests to verify every corner case we've discussed?

---

**Cursor**

Auditing the queue implementation against the locked design and regression test coverage.


## Are we done with queues?

**For the types/API redesign: yes.** `pnpm typecheck` is green and the locked surface is implemented in `src/types/**`, `workflow.ts` (`defineQueue`), `engine.ts`, `client.ts` (stub `attempts()`), and `docs/queues.md`.

**For the product end-to-end: no.** Runtime queue handling is still stubbed (`client.ts` throws "Not implemented"). That's expected — this tranche was the type contract.

---

## Remaining inconsistencies (non-test)

| Item | Status |
|------|--------|
| `docs/queues_divergence.md` | **Stale** — still describes `ttlSeconds`, `DEAD_LETTER`, definition `registerHandler`, `"unrecoverable"` |
| `docs/error-model.md` | **Stale** — still lists `DEAD_LETTER` / `AttemptError` for queue handlers |
| `REFACTOR.MD` / `refactor/13_queues.MD` | Stale (historical; not blocking types) |
| Runtime implementation | Not started |
| Row retention on `defineQueue` | Explicitly deferred |
| `delay >= ttl` validation, claim ordering | Spec-only, not typed |

Types and `docs/queues.md` agree. The divergence note and error-model doc lag behind.

---

## Regression coverage vs locked design

### Well covered in `13_queues.ts`

- `defineQueue` name literal
- Enqueue: `void`, message schema, `delay`/`ttl`/`priority`, no `txOrConn`
- `HasDefaultTtl` / required `ttl` when no `defaultTtl`
- `HasQueueErrorSchema` / `InferQueueTypedError` (schema vs `never`)
- Client namespace keyed by definition name (not workflow slot)
- `registerHandler`: `retryPolicy` required, `maxAttempts` required, `maxAttempts: null` forever
- Handler `Promise<void>`; `MANUAL` rejected
- `ctx.error`: `deadLetter` required, `typed` schema validation, no `typed` when no `error` schema
- `QueueHandlerError` class shape, `JsonInput` on `details`
- `DeadLetterReason` four-way union
- `Typed<T>` / `QueueHandlerAttempt<T>` shapes
- Dead-letter query/handle API + `attempts()` + `typed.ok` narrowing (one path)

### Gaps — discussed but not asserted

| Corner case | Gap |
|-------------|-----|
| **`defineQueue` has no `registerHandler`** | No `@ts-expect-error` on `emailQueue.registerHandler(...)` (old test removed) |
| **`DEAD_LETTER` removed** | No test that export/symbol is gone |
| **`UnrecoverableError` / `AttemptError` on queue handlers** | No `@ts-expect-error` (they may still typecheck as plain throws — worth documenting intent) |
| **Handler must not return a value** | No `@ts-expect-error` for `return DEAD_LETTER` or other non-void return |
| **`defaultTtl: null`** (never-expire default) | Not tested for `HasDefaultTtl` or enqueue omit |
| **`defaultTtl: Date` / enqueue `ttl: Date`** | Options variables exist for `delay: Date` only |
| **`delay: 0` explicit** | Not tested |
| **`Typed` `serialization_error` branch** | Union shape only — no narrowing test on `.error` |
| **`typed.ok` false fallback** | No test for `unspecified` / `serialization_error` branches |
| **`QueueHandlerAttemptAccessor`** | No `all`/`count`/`reverse`/iterator tests (cf. `05_attempt_accessor.ts`) |
| **No-schema queue dead-letter types** | Handler context tested; `DeadLetterHandleExternal<..., never>` not asserted |
| **Compensation `undo` → `ctx.queues`** | Wired in `steps.ts`; **no regression** in `08` or `13` |
| **`invalid_payload` reason** | In union only — no predicate/query usage |
| **`defineQueue` fields** | `error`, `defaultDelay`, `defaultTtl` not shape-asserted on return type |

### Cannot be type-tested (runtime/engine)

- Unhandled throw → loose fields + `typed: unspecified`
- Serialization failure preserving handler loose fields
- TTL/expiry / `invalid_payload` engine paths
- Retry disposition table end-to-end

---

## Verdict

**Types: done for the agreed scope.**  
**Tests: strong on the happy path and `ctx.error` core, but not exhaustive** — roughly **~70%** of discussed corners have explicit assertions; the table above is the backlog.

**Recommended next steps** (if you want to close the gaps):

1. Extend `13_queues.ts` with the missing `@ts-expect-error` cases and accessor/narrowing tests (small, high value).
2. Add compensation `ctx.queues.enqueue` in `08_compensation_model.ts` (or a slice in `13`).
3. Refresh `docs/queues_divergence.md` and `docs/error-model.md` queue sections.

I can implement 1–3 if you want to finish the tranche.

---

**User**

> Row retention on defineQueue

row retention on defineQueue - what do you mean?

> delay >= ttl validation, claim ordering

an important detail has arisen: do we start counting ttl after the delay has passed or since creation? this seems important to consider. we either should allow to pick the behavior or assume sound defaults like "if ttl is a date and delay is a date, then consider dates; if ttl is a date and delay is a number, then consider dates; if both are numbers - then ttl offsets from the delay" - however, this isn't very consistent.

let's think

---

**Cursor**

Checking what was deferred around retention and how TTL/delay are specified in the docs and REFACTOR.


## Row retention on `defineQueue`

That’s separate from **message TTL** (how long an unprocessed message may live before `ttl_expired`).

In old **REFACTOR.MD Part 10**, `defineQueue` had:

```typescript
retention: {
  processed: 86400,        // keep row N seconds after successful processing
  deadLettered: 86400 * 30, // keep row N seconds after dead-lettering
}
```

That’s **operator/DB garbage collection**: how long `queue_messages` rows stick around *after* they reach a terminal state. Workflows have the same idea (`retention` on `defineWorkflow` for complete/failed/terminated).

We **deferred** this for queues in the redesign — current `defineQueue` has no `retention`. It’s not in types or `13_queues.ts`. Only worth revisiting when you care about storage/audit policy for processed/dead-lettered rows.

---

## TTL vs delay — the real question

You’re hitting two different intents that both get called “TTL”:

| Intent | Meaning | Example |
|--------|---------|---------|
| **Shelf life** | Message must leave the system within N seconds of **enqueue**, including time spent delayed | “Drop if not processed within 24h of enqueue, even if delayed 23h” |
| **Processing window** | Once **eligible**, handler has N seconds before expiry | “Send in 1h; after that, you have 30m to process” |

REFACTOR’s draft implicitly chose **shelf life** for numeric TTL:

- `ttl: number` → `expires_at = enqueue_time + ttl`
- `delay: number` → `scheduled_at = enqueue_time + delay`
- Reject if `scheduled_at >= expires_at` (`delay >= ttl`)

So a delayed message **consumes** TTL while waiting. `delay: 3600, ttl: 1800` is invalid. That’s coherent but often surprising.

Our locked types say:

- `delay` number → commit-relative logical clock (replay-stable)
- `ttl` number → wall-clock at commit, **persisted** `expires_at` (replay reuses)

We never pinned **what instant** `expires_at` is computed from relative to `delay`. That’s the gap.

---

## Why a per-shape matrix gets messy

Rules like “if both Date use dates; if ttl Date + delay number use dates; if both numbers offset from delay” multiply cases and still don’t answer:

- `delay: 3600, ttl: Date` — is the Date absolute or relative?
- `delay: Date, ttl: 3600` — is 3600 from enqueue or from delay Date?

Authors have to memorize a truth table. One anchor is better.

---

## Recommendation: one anchor for numeric `ttl`

**Numeric `ttl` = duration after eligibility, not after enqueue.**

At commit, compute and persist:

1. **`eligible_at`** — `created_at + delay` (number), or `delay` (Date), or `created_at` if no delay  
2. **`expires_at`** —  
   - `ttl: null` → never  
   - `ttl: Date` → that absolute instant  
   - `ttl: number` → `eligible_at + ttl` (wall-clock once at commit, stored for replay)

**Validation:** `eligible_at < expires_at` (strict). No separate `delay >= ttl` rule — it falls out naturally unless `ttl: 0`.

Examples:

| Enqueue | eligible_at | expires_at | Reading |
|---------|-------------|------------|---------|
| `{ delay: 3600, ttl: 1800 }` | T+1h | T+1h30m | 30m processing window after send |
| `{ ttl: 3600 }` | T | T+1h | 1h from enqueue (no delay) |
| `{ delay: 3600, ttl: new Date('...') }` | T+1h | fixed deadline | “Fire in 1h, must finish by 5pm” |
| `{ ttl: new Date('...') }` | T | 5pm | Absolute deadline, process ASAP until then |

**Shelf life from enqueue** when you also want delay: pass an absolute `ttl: Date` (e.g. `ctx.date + totalBudget`), or omit delay and bake wait into workflow logic.

This avoids a combinatorial matrix: **Date = absolute; number = offset from eligibility.**

---

## Claim ordering (separate, but interacts)

Once eligible and not expired:

`priority ASC, eligible_at ASC, id ASC`

Claim SQL already checks both `scheduled_at <= now` and `expires_at > now`. With “TTL from eligibility,” a message isn’t claimable until `eligible_at`, and expiry is measured from the same anchor — no “expired before we could try” unless the author set `ttl` too tight.

---

## What I’d lock

1. **Numeric `ttl`** → `expires_at = eligible_at + ttl` (persisted at commit).  
2. **`ttl: Date`** → absolute `expires_at`.  
3. **`ttl: null`** → never expires.  
4. **Validate** `eligible_at < expires_at` at enqueue.  
5. **Row retention** on `defineQueue` — still deferred; unrelated to message expiry.

If that matches your intuition, we should document it in `docs/queues.md` and encode `eligible_at`/`expires_at` in the runtime spec before implementation. If you prefer **shelf life** (REFACTOR style) instead, that’s valid too — but then delayed + short `ttl` must keep failing validation, and authors need “processing window after delay” via absolute `ttl: Date` or a longer numeric shelf life.

Which of the two intents do you want numeric `ttl` to mean? That single choice drives everything else.

---

**User**

nice thinking! this concept unifies the model neatly. Now as for the other issues:

> docs/queues_divergence.md  

we can get rid of the queues_divergence.md completely, since we've basically landed on a different design, essentially diverging from the divergent design. we need to document the current design, though, if we haven't yet.

 > docs/error-model.md  

fix the error-model.md.

 > REFACTOR.MD / refactor/13_queues.MD  

REFACTOR.MD was supposed to begin a transition to a new state, where every section was going to be replaced with a reference to a docs/ file. so if there is still a queues section, we should get rid of it and replace with a reference to a document.


---

**Cursor**

Updating queue documentation and removing stale divergence/REFACTOR content. Reading the current files.


Writing comprehensive queue docs and updating related files.


Reading the current files to finish the remaining updates.


Documentation cleanup is done. Summary:

### `docs/queues_divergence.md`
Already removed — no references remain in the repo.

### `docs/queues.md`
Canonical queue design doc (eligibility/expiry, `ctx.error`, dead letters, etc.) — no further changes needed.

### `docs/error-model.md`
Already aligned with the current design:
- Queue handlers use `throw ctx.error({...})`, not `DEAD_LETTER` or `AttemptError`
- Split handler sections by primitive
- Links to `queues.md` for queue-specific details

### `REFACTOR.MD`
- **Part 10** replaced with an extraction pointer (same pattern as Part 7 / scopes):

```1698:1704:REFACTOR.MD
## Part 10: Queues

> **Extracted → [docs/queues.md](docs/queues.md)** (canonical). This section now lives in its own document; the design there is authoritative.

---
```

- **Part 15b**, **Part 16**, and exports updated earlier (`DEAD_LETTER` → `QueueHandlerError`, queue scheduling points to `docs/queues.md`)
- Overview item 7 updated: queue enqueue uses `delay`/`ttl`; workflow starts keep `delaySeconds`/`scheduledAt`

### `refactor/13_queues.MD`
Rewritten to point at `docs/queues.md` and `docs/error-model.md` as the source of truth, with a short highlights list and acceptance contract.

### `refactor/18_scheduled_delivery.MD`
Queue scheduling now references `docs/queues.md` instead of Part 10, and notes that queues do not use `ScheduledDeliveryOptions`.

**Note:** Part 15 (AttemptAccessor) in `REFACTOR.MD` still describes queue handlers as using `AttemptError` / `AttemptAccessor` — that predates the `QueueHandlerAttempt` / `ctx.error` design. Worth extracting to `docs/error-model.md` in a follow-up, same as scopes and queues.

---

**User**

what it is, what it is not an so on: this structure only applies to the primitives description docs, so that it's easier to understand how they are different amongst each other. however, when writing generic docs, like @docs/error-model.md , we don't need to use this layout. can you rephrase the document, so that it's readable and accurately desribes the error model the library assumes? because the library makes a lot of assumptions about the code style, and it's more than conventions: the error model, while looking like a convention, actually creates a different behavior model overall. let's capture that.

---

**Cursor**

Reviewing the current error-model doc and related types so the rewrite matches how the library actually behaves.


Rewriting the error-model doc as conceptual narrative prose, emphasizing engine behavior over the primitive-doc layout.


Fixing a broken cross-reference in `queues.md`.


`docs/error-model.md` is rewritten as a conceptual guide rather than a primitive-style doc.

**Structural changes**
- Removed "What it is" / "What it is NOT" framing
- Opens with the core claim: classification drives **behavior**, not just style
- Organized around execution planes (workflow body vs handlers), then outcome paths, caller contract, compensation isolation, and attempt history
- Examples kept at the end as illustrations, not the main structure

**Behavioral emphasis**
- The four workflow-body paths (success, declared failure, engine event, halt) are explicit in a table with engine consequences
- Halts vs failures are contrasted on compensation, terminal state, and caller visibility
- Engine events as **returned values** are tied to replay and domain decisions
- Handler vocabulary is summarized in one table with pointers to primitive docs
- Closing "Mental model" section frames recognition rules as state machines, not conventions

Also fixed the broken link in `docs/primitives/queues.md` (`../error-model.md`).

---

**User**

now, when thinking about the error model (once again), I can't help but notice that we're seemingly better off unifying the error model overall. we've had the bright idea about the serialization_error, but we've also missed the `ctx.errors.SomeError` syntax for some reason with the `errors: { SomeError: true }` syntax for typed error definitions: it's an easy win if we did the type and the message by default - these are always safely serializable - while allowing body to fail the serialization, but not fail the overall operation. I wonder whether the behavior should differ though between the workflow errors and the queue errors: we could halt the workflow due to the serialization error, so we may not need to have the same model of explicit serialization errors, while queue handler attempts clearly benefit from this.

---

**Cursor**

Reviewing how workflow and queue errors are typed and persisted today so we can compare unification options.


You're pointing at a real unification — not “make every surface use the same API,” but **one persistence pattern with context-specific failure handling**.

## The shared pattern

Both surfaces already split **identity** from **structured payload**:

| | Identity (always safe) | Structured payload |
|--|------------------------|-------------------|
| **Workflow** `ctx.errors.X(...)` | `code` (map key) + `message` | `details` (schema, when not `true`) |
| **Queue** `ctx.error({...})` | loose `type` / `message` / `details` | `typed` (queue `error` schema) |

The queue design made the second part explicit: validate at the persistence boundary, and **don't let payload validation change the operational outcome**. Workflow errors never got that treatment — we mostly assume compile-time + throw-time correctness, and if `details` fails at persist time the behavior is underspecified.

The easy win for workflow is exactly what you describe:

- **`errors: { Cancelled: true }`** → `ctx.errors.Cancelled(message)` — only strings, nothing to fail.
- **`errors: { OrderInvalid: z.object({...}) }`** → `ctx.errors.OrderInvalid(message, details)` — `code` and `message` always persist; `details` is validated when the failure is **committed** as terminal state.

That mirrors queue's split between “what the handler decided” and “what we could structurally store.”

## Why disposition should differ

The asymmetry isn't arbitrary — it follows **what kind of commit you're making**:

**Workflow declared failure** is a **terminal, externally contracted outcome**. The caller's schema says `failed.error.details` has a shape. Returning `failed` with missing or corrupt `details` breaks that contract. Options:

1. **Halt** — “we intended a business failure but can't honor the declared schema” (schema bug, bad deploy, non-serializable value). Operator fixes code/schema and replays. No compensation on a half-valid failure.
2. Expose `serialization_error` on `ErrorValue` — caller must handle a third details shape. That leaks engine plumbing into the business API and weakens the whole point of declared errors.

Halt is the right default for workflow. You don't need `Typed<T>` on the **caller-facing** failure — if persistence fails, you never reach `WorkflowResult.failed`.

**Queue handler attempt** is **operational telemetry on a retried side effect**. Disposition (`deadLetter`, retry) is already decided from loose fields + `deadLetter`. The `typed` slot is enrichment for operators and dead-letter triage. Losing it shouldn't undo “dead-letter this message” or “retry again.” Hence `serialization_error` on the attempt record, disposition unchanged.

Same validation step, different consequences — because one is terminal API contract, the other is attempt log enrichment.

## What unification actually means

Unify the **model**, not necessarily the **syntax**:

```
throw factory({ always-safe identity..., optional structured body })
        → validate structured body at persist boundary
        → on failure: halt (terminal commits) | serialization_error (attempt records)
```

Keep surface differences where behavior differs:

- Workflow: `ctx.errors.<Code>(message, details?)` — no `deadLetter`; throwing *is* failing.
- Queue: `ctx.error({ deadLetter, message?, type?, details?, typed? })` — disposition is part of the throw.

Queue needs the extra loose fields because handlers aren't declaring a fixed code map per throw. Workflow gets codes from the map key — that's the `SomeError` in `errors: { SomeError: true }`.

## What we missed on workflow (and why it still matters)

TypeScript validates `details` at the throw site, but runtime still matters for:

- schema tightening on replay (history throws details that no longer validate),
- `InferInput` vs `InferOutput` gaps,
- values that compile but aren't JSON-safe at persist time.

Today that's a gray zone — likely indistinguishable from an unmodeled throw → halt, or worse, silently wrong persistence. Making it explicit: **recognize `ExplicitError`, persist `code` + `message`, validate `details`; on validation failure → execution halt** (not `failed`, not a special caller-facing variant).

That gives workflow the same *discipline* as queue without copying `Typed<T>` onto `ErrorValue`.

## Where `Typed<T>` should live

| Context | Structured slot | Persist failure |
|---------|-----------------|-----------------|
| `ErrorValue` / caller | `details` (when declared) | **Halt** — don't expose `serialization_error` |
| `QueueHandlerAttempt` | `typed` | **`serialization_error`** on attempt |
| Step/request `Attempt` | `details` (loose `JsonInput` today) | Could stay loose-only, or add optional declared schema later with queue-like degradation |

Steps/requests don't have a declared error map per handler throw today, so queue-style `Typed<T>` is the standout case among attempt records.

## Child workflow propagation

This stays clean: child fails → parent receives `ErrorValue<TChildErrors>` only if the child **completed** terminal failure with valid persisted details. If the child's details fail validation at commit, the child **halts** — parent sees `{ ok: false, status: "failed", error }` only when the child's failure was fully persisted. Parent translating `child.error` into `ctx.errors.X(..., { childError: child.error })` remains a normal pattern; nested details are already serialized child `ErrorValue`.

## Recommendation

1. **Document** the unified rule: identity always persists; structured body validated at boundary; failure handling depends on commit kind.
2. **Workflow runtime**: on `ExplicitError`, persist `code` + `message`, validate `details`; validation failure → **execution halt** (not a fourth terminal status).
3. **Keep** `Typed<T>` + `serialization_error` on queue attempts only (for now).
4. **Don't** add `serialization_error` to `ErrorValue` or change `ctx.errors` call shape unless you want object form for symmetry — `(message, details?)` is fine if the persist rules are clear.

If you want this captured in docs next, I'd add a short “Structured payload persistence” section to `error-model.md` and a note in `queues.md` pointing at the shared rule and the deliberate asymmetry. I can draft that, or we can sketch type-level changes (e.g. internal persist result type shared by engine) if you're ready to move toward implementation.

---

**User**

fair enough. but my premise was whether we wanted to extend the `errors: { SomeTypedError1: true, SomeTypedError2: zodSchema }` to the queues, so that we could have `throw ctx.SomeTypedError1("message")` and `throw ctx.SomeTypedError2("message2", { body: "some body", wontBeAbleToSerialize: BigInt(1) })`, so that later we still get to discriminate over `"SomeTypedError1"` and `"SomeTypedError2"`, see the error messages, but not get a coherent body in the second case.

---

**Cursor**

Reviewing the queue error API so we can compare it with the workflow `ctx.errors` pattern you're proposing.


Your premise holds up, and it’s a cleaner unification than the current single anonymous `error` schema + `ctx.error({ typed, type, message, details, deadLetter })` bag.

## What you’re actually proposing

Replace:

```typescript
defineQueue({ message: …, error: z.object({ … }) })
throw ctx.error({ deadLetter: true, typed: { … }, message: "…" })
```

With the same declaration shape workflows already use:

```typescript
defineQueue({
  message: …,
  errors: {
    SomeTypedError1: true,
    SomeTypedError2: z.object({ body: z.string() }),
  },
})

throw ctx.errors.SomeTypedError1("message", { deadLetter: true })
throw ctx.errors.SomeTypedError2(
  "message2",
  { body: "some body", wontBeAbleToSerialize: BigInt(1) },
  { deadLetter: false },
)
```

(I’d keep the `ctx.errors` namespace for symmetry with the workflow body — not `ctx.SomeTypedError1` directly — but the factory semantics are what matter.)

On persist, the attempt always gets:

- **`code`** — `"SomeTypedError1"` | `"SomeTypedError2"` (discriminator)
- **`message`** — always safe
- **`details`** — per-code structured slot:
  - `true` codes → absent / `undefined`
  - schema codes → `Typed<InferOutput<ThatSchema>>` (`serialized` | `serialization_error`)

So for the BigInt case you still know it was `SomeTypedError2`, you still read `"message2"`, but `details` is `{ ok: false, status: "serialization_error", … }` instead of a coherent body. Disposition (`deadLetter`, retry) is unchanged.

That’s exactly the queue-side behavior we already wanted; the missing piece was **named codes** instead of one blob called `typed`.

## Why this is better than today’s queue model

| Today | With `errors` map |
|-------|-------------------|
| One optional schema, no code | Many codes, each `true` or schema |
| Free-form `type` string overlaps with `typed` | `code` is the discriminator; no redundant `type` |
| Operators narrow on `attempt.typed.ok` only | Operators narrow on `attempt.code`, then on `details` |
| Same schema for every structured failure | Different shapes per code (like workflow callers) |

Reuse `ErrorDefinition` / `ErrorDefinitions` from `errors.ts` — no new concept.

## The one thing workflows don’t have: `deadLetter`

Workflow: throwing `ctx.errors.X(...)` **is** the terminal outcome.

Queue: the throw records an attempt **and** chooses retry vs dead-letter. So the factory can’t be identical — you need disposition on every queue error throw.

Least awkward shape, still mirroring workflow:

```typescript
// errors: { Cancelled: true }
ctx.errors.Cancelled(message, { deadLetter: boolean })

// errors: { ProviderRejected: schema }
ctx.errors.ProviderRejected(message, details, { deadLetter: boolean })
```

`deadLetter` stays required in the options bag; everything else matches workflow ergonomics.

Unhandled throws stay outside this map: no `code`, loose extracted `message`/`type`, `details` → `unspecified`, retry as today.

## Persisted attempt shape (sketch)

```typescript
type QueueHandlerAttempt<TErrors extends ErrorDefinitions> = {
  readonly attempt: number;
  readonly deadLetter: boolean;
  readonly code: (keyof TErrors & string) | null;  // null = unhandled
  readonly message: string | null;
  readonly details: CodeDetails<TErrors, TCode>;  // undefined for true codes;
                                                  // Typed<T> for schema codes;
                                                  // unspecified for unhandled
};
```

Where `CodeDetails` is keyed by which code was thrown — same idea as `ErrorValue<TErrors>` on the workflow caller side, but embedded in attempt history with `serialization_error` instead of halt.

## Workflow vs queue: same factory, different commit rules

| | Workflow `ctx.errors` | Queue `ctx.errors` |
|--|----------------------|-------------------|
| Declaration | `errors: { X: true \| schema }` | same |
| Throw | `(message)` or `(message, details)` | + `{ deadLetter }` |
| Identity persist | `code` + `message` always | same |
| Body persist | `details` validated at terminal commit | same validation |
| Body fails | **halt** (can’t honor external contract) | **`serialization_error`** on attempt (disposition already decided) |

So you unify **authoring** and **discrimination**; you don’t unify **failure handling on bad bodies** — and that’s correct.

## What goes away

- Single `error?: schema` on `defineQueue`
- `ctx.error({ … })` with overlapping loose fields
- `InferQueueTypedError` / `HasQueueErrorSchema` as “one anonymous typed slot”
- Free-form `type` on declared queue errors (the map key is the type)

You’d replace them with `InferQueueErrors<Q>`, `HasQueueErrors<Q>`, and `ErrorFactories<TErrors>` on `QueueHandlerContext`, plus per-code `details` on attempts.

## Edge cases worth deciding upfront

1. **Empty / omitted `errors` map** — handler ctx has no `ctx.errors`; only unhandled-throw path (like a workflow with no declared errors, but handlers can still fail loosely).

2. **Child / cross-service** — not applicable on queue attempts; codes are for operator triage, not external API. Good fit.

3. **Dead-letter UI / search** — `findMany(({ code }) => eq(code, "SomeTypedError2"))` becomes natural; better than searching loose `type` strings.

4. **Migration** — breaking change from current `error` + `ctx.error`; worth it if we’re still pre-runtime.

---

**Bottom line:** yes, extending `errors: { SomeTypedError1: true, SomeTypedError2: schema }` to queues is the right unification. You get workflow-style factories, code-level discrimination on attempts, always-safe `message`, and schema bodies that may degrade to `serialization_error` without losing the operational decision. The only queue-specific addition is `{ deadLetter }` on each throw.

If you want to move on this, next step is a type tranche: change `defineQueue`, `QueueHandlerContext`, `QueueHandlerAttempt`, regression tests in `13_queues.ts`, and docs — same pattern as the last queue pass.

---

**User**

one important distinction: `readonly message: string | null;` message can be null only if `code` is `null`. it seems to be true for the typed messages. is it, though? verify the assumption

---

**Cursor**

Tracing type definitions and docs for when `message` can be null versus when a declared `code` is present.


Your assumption is **true for declared / coded errors if we adopt workflow-style factories**, but it is **not true in the current queue types** — and it was never stated as an invariant for generic attempt records.

## Workflow declared errors — message is always `string` when `code` is set

`ErrorFactories` requires a `message` argument, and `ExplicitError` stores it as `string`:

```21:21:src/types/results.ts
  constructor(code: TCode, message: string, details: TDetails) {
```

Persisted caller-facing shape:

```36:46:src/types/results.ts
export type ErrorValue<TErrors> = {
  [K in keyof TErrors & string]: {
    readonly type: "ExplicitError";
    readonly code: K;
    readonly message: string;
    readonly details: TErrors[K] extends true
      ? undefined
      : ...
  };
}[keyof TErrors & string];
```

So for workflow failures: **`code` present ⇒ `message: string`** (not `null`). Empty string `""` is allowed; `null` is not.

Details failing validation at persist time would be a separate concern (halt, not null message) — it does not make `message` nullable on `ErrorValue`.

## Current queue model — assumption does **not** hold

Today there is no `code` on attempts; `QueueHandlerAttempt` extends `BaseError`:

```123:157:src/types/results.ts
export type BaseError = {
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
};
// ...
export type QueueHandlerAttempt<TTyped = never> = BaseError & {
  readonly attempt: number;
  readonly typed: Typed<TTyped>;
  readonly deadLetter: boolean;
};
```

`ctx.error` allows omitting `message`:

```159:164:src/types/results.ts
type QueueHandlerErrorLooseOptions = {
  readonly deadLetter: boolean;
  readonly message?: string | null;
  readonly type?: string | null;
  readonly details?: JsonInput;
};
```

Regression tests include `ctx.error({ deadLetter: false })` with no message at all. The class still gets a fallback via `super(options.message ?? options.type ?? "QueueHandlerError")`, but the **persisted attempt fields** are typed as independently nullable — nothing ties `message: null` to “no typed payload”.

So today you can have:
- `typed.status === "serialized"` (or `"serialization_error"`) with `message: null`
- `typed` populated while `type`/`message` are both null

The typed slot and the loose `message` field are not coupled.

## Proposed `errors` map on queues — assumption **should** become true

If queue handlers use the same factory shape as workflow:

```typescript
ctx.errors.SomeTypedError1("message", { deadLetter: true })
ctx.errors.SomeTypedError2("message2", details, { deadLetter: false })
```

then at the type level:

| Branch | `code` | `message` |
|--------|--------|-----------|
| Declared throw | `"SomeTypedError1" \| …` | **`string` (required)** |
| Unhandled throw | `null` | `string \| null` |

`serialization_error` on `details` does **not** clear `message` — only the structured body degrades; identity fields come from the factory call and should persist as-is.

That gives a clean discriminated union:

```typescript
type QueueHandlerAttempt<TErrors> =
  | { code: null; message: string | null; details: { status: "unspecified" }; … }
  | { code: K; message: string; details: CodeDetails<TErrors, K>; … }
```

## Generic `Failure` / step attempts — different rule

`Failure` / `Attempt` (steps, requests, topics) intentionally allow `message: null` with no `code` concept at all — REFACTOR explicitly says JS can `throw` anything. That’s the unhandled/loose-extraction path, not declared errors.

---

**Verdict:** For **typed declared errors** (workflow today; queue in the proposed design), **`message` should be `string`, never `null`, whenever `code` is set**. That matches your premise.

It is **not** true today on `QueueHandlerAttempt` because `message` is optional on `ctx.error` and not tied to `code`. If we move to `errors` + `ErrorFactories`, we should encode the invariant in the attempt type rather than reuse loose `BaseError` for the declared branch.

---

**User**

let's go ahead and implement the new api.

---

**Cursor**

Implementing the queue `errors` map and `ctx.errors` API. Exploring the codebase to identify all touchpoints.


Implementing the type system and updating all affected files.


Writing the updated regression tests and docs.


Fixing error inference when `errors` is omitted — TypeScript was inferring the wide `ErrorDefinitions` constraint instead of an empty map.


Using overloads so queues without `errors` get `Record<string, never>` instead of the wide `ErrorDefinitions` constraint.


Updating documentation and checking for remaining references.


Implemented the unified queue error API. Summary of what changed:

### API

**`defineQueue`** — `error?: schema` replaced with optional **`errors`** map (same as workflow: `true` or schema per code):

```typescript
defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  errors: {
    InvalidTemplate: true,
    ProviderRejected: z.object({ code: z.string(), orderId: z.string() }),
  },
});
```

Two overloads: omit `errors` entirely → no factories; pass `errors` → required on that overload.

**Handler context** — `ctx.error({...})` replaced with **`ctx.errors`**:

```typescript
throw ctx.errors.InvalidTemplate("Receipts are not supported", { deadLetter: true });
throw ctx.errors.ProviderRejected(
  "SMTP timed out",
  { code: "SMTP_TIMEOUT", orderId: "o-1" },
  { deadLetter: false },
);
```

### Types

- **`QueueHandlerDeclaredError`** — replaces `QueueHandlerError`; carries `code`, `message`, `details`, `deadLetter`
- **`QueueHandlerAttempt`** — discriminated union:
  - Declared: `code` + `message: string` + optional schema-backed `details`
  - Unhandled: `code: null`, `message: string | null`, loose `type`
- **`QueueHandlerAttemptDetails<T>`** — replaces `Typed<T>` for schema `details` slots
- Helpers: **`InferQueueErrors`**, **`HasQueueErrors`** (replacing `InferQueueTypedError` / `HasQueueErrorSchema`)

### Files touched

Types: `results.ts`, `messaging.ts`, `handlers.ts`, `helpers.ts`, `engine.ts`, `workflow-contract.ts`, `errors.ts`, `workflow.ts`  
Tests: `13_queues.ts` (rewritten)  
Docs: `docs/primitives/queues.md`, `docs/error-model.md`, `refactor/13_queues.MD`, `REFACTOR.MD`

`pnpm typecheck` passes. Runtime worker persistence is still stubbed — this is the type/API tranche only.

---

**User**

I see you're using `docs/queues.md` as a reference to the queues docs. but I've moved the references to the `docs/primitives/queues.md` for consistency.

---

**Cursor**

Searching for and updating stale `docs/queues.md` references to `docs/primitives/queues.md`.


Updated all remaining `docs/queues.md` references to `docs/primitives/queues.md`:

- **`REFACTOR.MD`** — Part 10 extraction pointer, Part 15b queue handlers, Part 16 scheduled delivery (4 links)
- **`refactor/18_scheduled_delivery.MD`** — 2 links

`refactor/13_queues.MD`, `docs/error-model.md`, and `docs/primitives/queues.md` were already on the primitives path. There is no `docs/queues.md` file in the repo anymore.

---

**User**

the next thing is the retention, correct? again, what was the issue with the retention model?

---

**Cursor**

Searching the codebase and docs for how queue retention was specified and why it was deferred.


Yes — **row retention on `defineQueue` is the main remaining definition-level gap** for queues. Message **TTL**/`delay` and the **`errors` / `ctx.errors`** model are settled in types and docs; retention is still explicitly deferred in `docs/primitives/queues.md`.

## Two different clocks

| Concept | Question it answers | When it starts |
|--------|---------------------|----------------|
| **`ttl` / `expires_at`** | How long may this message stay **in the queue lifecycle** (pending → claimed → done/dead)? | Eligibility model we locked: numeric `ttl` offsets from **`eligible_at`**, not enqueue |
| **`retention`** | How long do we **keep the DB row** after a **terminal** outcome? | After `processed` or `dead_lettered` (GC / audit policy) |

Confusing the two was part of why retention was pushed back — the eligibility/expiry model needed to land first.

## What the old model was

REFACTOR Part 10 (pre-redesign) had something like:

```typescript
retention: {
  processed: 86400,           // seconds after successful processing
  deadLettered: 86400 * 30,   // seconds after dead-lettering
}
// null on either = never delete
```

DDL had matching `processed_retention_deadline_at` / `dead_letter_retention_deadline_at` columns. A background sweeper deletes rows once past those deadlines.

That is **operator/storage policy**, not handler behavior. Workflows already have an analogous idea (`retention` / `RetentionSetter` for complete/failed/terminated); requests spec per-outcome retention too (`resolved` / `timedOut` / `cancelled`).

## What the “issue” was (why it’s not in the API yet)

Nothing was proven **wrong** with retention — it was **deferred**, not dropped:

1. **Wrong layer to design first** — While TTL vs delay semantics were still in flux, baking in GC policy would have been building on unstable lifecycle rules.

2. **No unified pattern yet** — Queue retention used `processed` / `deadLettered`; workflows use `RetentionSetter<"complete" | "failed" | "terminated">`; requests use another shape. We didn’t decide whether queues should reuse `RetentionSetter`, get a queue-specific map, or something else.

3. **Incomplete lifecycle coverage** — Old spec only named **processed** and **dead_lettered**. Open questions:
   - Pending rows that **expire via `ttl_expired`** — same retention as dead-lettered, or a third bucket?
   - **`queue_message_attempt`** rows — cascade with message delete, or separate retention?
   - **Claimed** then worker dies — row stays pending/claimed; retention usually shouldn’t apply until terminal.

4. **Tension with operator APIs** — `deadLetters.findMany` / `retry` / `purge` need rows to exist long enough for triage. Short `deadLettered` retention vs long operator expectations is a product choice, not obvious from the old defaults.

5. **Explicitly out of scope for the types tranche** — Same as runtime: define the delivery/error/attempt surface first; add retention when implementing storage and sweepers.

## What’s left to decide when you pick it up

Rough design checklist:

- **Shape**: `{ processed, deadLettered }` vs `RetentionSetter<"processed" | "deadLettered" | "ttlExpired"?>` vs align with workflow naming.
- **Defaults**: omit = forever? sensible seconds? per-queue vs global engine default?
- **Attempt rows**: ON DELETE CASCADE vs retain attempts for audit after message purge.
- **Interaction with dead-letter UX**: minimum retention vs “purge immediately after `purge()`”.
- **Call-time override**: workflows can `setRetention` on instances — do queues need anything similar, or is definition-only enough?

So: **yes, retention is the natural next queue design item** after errors — not because the old model failed, but because it was intentionally held until lifecycle semantics were stable, and because several GC/operator details were never fully nailed down. If you want to move on it, the first decision is probably **retention map shape + which terminal statuses get a knob** (especially `ttl_expired` vs `handler_reject`).

---

**User**

it seems like we have an interesting design decision at our hands currently. it's hard to pin down exactly every use case, so what I'm thinking about is maybe a model shift would be more beneficial? instead of forcing a status -> retention map, maybe we could allow devs to react to finalized rows in their own way and decide the retention with custom policies? basically I'm talking about a callback here that accepts a finalized row and returns a `number | null` - with null meaning no retention. just a proposal, what do you think? this would apply to the workflows as well, and to all of the primitives that need retention.

---

**Cursor**

Reviewing how retention is modeled across primitives so we can evaluate the callback proposal.


The callback idea is directionally strong, especially for queues and workflows where terminal rows differ a lot in “how long do we need this around?” A static status → seconds map is easy to explain but brittle once real operators show up.

## What you’re really proposing

At **finalize time** (processed, dead-lettered, workflow complete/failed/terminated, request resolved/timed out/cancelled, etc.):

1. Engine has a **typed terminal row** (or a narrow projection of it).
2. A **policy function** runs: `(row) => number | null`.
3. Engine persists **`retention_deadline_at = finalized_at + seconds`**, or no deadline if `null`.
4. A background sweeper deletes when `now > retention_deadline_at` — same as today, just a different way to **compute** the deadline.

That’s “react to finalized rows” without making retention part of the handler/workflow body. Good separation.

## Why it’s appealing

**Per-row policy instead of per-status buckets.** Queue dead letters are a good example: keep `handler_reject` on high-value payloads for 90 days, purge `invalid_payload` after a day — one status map can’t express that without multiplying statuses artificially.

**One pattern across primitives.** Workflows already have `RetentionSetter<"complete" | "failed" | "terminated">`; requests want `resolved` / `timedOut` / `cancelled`; queues want `processed` / `deadLettered` / maybe `ttl_expired`. A callback `(terminalRow) => seconds | null` avoids inventing a new status vocabulary per primitive.

**Static maps become sugar.** `{ processed: 86400, deadLettered: 2592000 }` is just:

```typescript
(row) => row.status === "processed" ? 86400 : row.status === "dead_lettered" ? 2592000 : null
```

Keep the object form for the 90% case; allow a function when you need it.

## Where it gets interesting (constraints)

**1. Run once at finalize, not on every sweep.**  
The callback must not be “sweeper asks policy what to do today.” It must compute the deadline **once** when the row becomes terminal and persist it. Otherwise replay, redeploys, and code changes rewrite history.

**2. Must be pure.**  
Input = persisted row fields only; output = seconds or `null`. No I/O, no clocks, no randomness. Same input → same deadline. That keeps finalize replay-safe (same story as workflow body rules, different plane).

**3. Registration vs definition.**  
Callbacks aren’t serializable in Postgres. For queues you already split **data** (`defineQueue`) from **runtime** (`client.queues.*.registerHandler`). Retention likely belongs on the **client/engine** side too, e.g. `registerRetentionPolicy`, not inside the JSON-ish definition — unless you only ever run user code in-process (which this engine mostly assumes anyway).

**4. Topics are a different beast.**  
Topic “retention” is log compaction: global `retentionSeconds`, consumer offsets, `neverExpire`, liveness. It’s not “this row reached a terminal state.” I wouldn’t force the same callback model there; keep topics on their existing model unless you redesign compaction separately.

**5. Layering with operator overrides.**  
Workflows already have `setRetention` on the handle. A sane stack:

- Definition/default: retention policy (static or callback).
- Optional operator override: `setRetention` / per-row deadline bump (audit use cases).
- Final persisted `retention_deadline_at` wins at sweep time.

**6. `null` meaning.**  
Your `null` = keep forever matches current `RetentionSetter` (`null` = never delete). Worth stating explicitly: **`null` is “no automatic purge,” not “delete immediately.”**

**7. Attempt / child rows.**  
Callback receives the **message/workflow/request row**. Decide separately whether `queue_message_attempt` rows cascade on message delete or get their own policy (usually CASCADE is enough).

## Recommendation

**Yes — adopt callback-shaped retention as the general model**, with static maps as shorthand, not as the only API:

```typescript
type RetentionPolicy<TRow> = (row: TRow) => number | null;

// shorthand
retention: { processed: 86400, deadLettered: 86400 * 30 }
// or
retention: (row) => row.reason === "invalid_payload" ? 3600 : 86400 * 30
```

For queues specifically, something like:

```typescript
client.queues.emailQueue.registerRetentionPolicy((row) => {
  if (row.status === "dead_lettered" && row.reason === "invalid_payload") return 3600;
  if (row.status === "dead_lettered") return 86400 * 30;
  if (row.status === "processed") return 86400;
  return null;
});
```

Typed on terminal row shape (`status`, `reason`, `payload`, `finalizedAt`, etc.).

Apply the same **`RetentionPolicy<WorkflowRow>`** (or terminal projection) to workflows and requests; leave topics on offset/log retention unless you want a second design pass.

## What I wouldn’t do

- Don’t run the callback in the workflow/handler body — wrong execution plane.
- Don’t use it for “archive to S3 then delete” in v1 — that’s a separate `onFinalized` hook if you need side effects; retention callback should stay **pure deadline selection**.
- Don’t drop static maps — they’re good defaults and documentation.

So: **model shift is worth it**, especially before you implement queue retention and before requests/workflow retention spread further. Next design step would be nailing the **terminal row type per primitive** and **register vs define** placement — I’d mirror handler registration for queues and keep workflow policy on `defineWorkflow` + optional `setRetention` override.

If you want to go further, we can sketch the exact `RetentionPolicy` types for queue vs workflow vs request and how they compose with dead-letter operator APIs.

---

**User**

I don't want static maps. It's hard to decide which statuses should go on the static map. 

You are right to notice that the retention policy likely belongs to the client. And I wonder whether we cannot somehow integrate setting retention in the current set of callbacks that are already present. for example, `throw ctx.errors.SomeError(..., { deadLetter: true, retention: dynamicallyCalculatedRetention() })`. this is neat, but again, the retention is a separate beast. it could, for example, potentially take into account the number of attempts and the contents of them - it's obviously kind of too far fetched, but a possible use case. It feels wrong to create a separate retention handler - but at the same time no other solution feels satisfactory. But again, the retention callback must be pure and synchronous: I kind of agree, but at the same time we don't want to load up all the attempts for every message: we can, but should we? maybe it's not that big of a deal: retention will be null while we're handling retention assigning on per-case basis.

---

**Cursor**

You're circling a good split: **disposition** (what happens to the message) vs **retention** (how long the row survives afterward). They often correlate but aren't the same decision, and retention sometimes needs more context than the handler had at throw time.

## Don't force one callback shape for everything

A single "retention handler" registered elsewhere feels wrong because retention isn't work you *do* — it's a **deadline you assign once** when the row becomes terminal. That puts it closer to policy than handler, but it doesn't need its own registration surface if you attach it where handlers already live.

A workable model:

### 1. Default: policy on handler registration (client)

```typescript
client.queues.emailQueue.registerHandler(handler, {
  retryPolicy: { ... },
  retentionPolicy: (ctx) => {
    if (ctx.status === "processed") return 86400;
    if (ctx.reason === "invalid_payload") return 3600;
    if (ctx.attemptCount > 10) return 86400 * 90;
    return 86400 * 30;
  },
});
```

No static map. The policy sees a **terminal snapshot** the engine builds at finalize — sync, pure, no I/O inside the function.

### 2. Optional override at disposition (handler_reject only)

```typescript
throw ctx.errors.ProviderRejected("...", details, {
  deadLetter: true,
  retention: 3600, // optional; omit => registration policy runs
});
```

Neat when the handler already knows ("this payload is junk → 1h"). It only covers **`handler_reject`** — not `max_attempts`, `ttl_expired`, or `invalid_payload`, which the engine finalizes without a handler throw. Those always go through `retentionPolicy`.

Precedence: **explicit `retention` on throw wins**; otherwise **`retentionPolicy` at finalize**; otherwise **`null` (keep forever)**.

That gives you integration with existing callbacks without pretending every terminal path goes through `ctx.errors`.

## What goes in the snapshot (attempt loading)

Your concern about loading all attempts is valid if the policy ran on every sweep or on hot paths. It shouldn't. Retention is assigned **once at finalize**, in the same transaction that marks the row terminal.

```typescript
type QueueRetentionContext<TErrors, TMessage> = {
  readonly status: "processed" | "dead_lettered";
  readonly reason: DeadLetterReason | null;
  readonly message: TMessage;           // decoded payload
  readonly attemptCount: number;
  readonly lastAttempt: QueueHandlerAttempt<TErrors> | null;
  readonly attempts?: readonly QueueHandlerAttempt<TErrors>[]; // optional tier
};
```

Practical default:

- Always pass **`attemptCount` + `lastAttempt`** — cheap, covers most policies.
- Include **`attempts`** (full array) only when the registered policy declares it needs it, *or* always load it at finalize anyway — for dead letters, `attemptCount` is bounded by `maxAttempts` (often single digits). Loading 5–20 small attempt rows once per dead letter is usually fine.

So: not "load attempts for every message in the queue," but "load attempts once when this message **terminates**." That's a very different cost profile.

Don't expose `AttemptAccessor` inside the policy — async/lazy loading fights purity and replay. **Engine loads, policy reads.**

## Why not only `retention` on throw?

Because retention often depends on things the handler doesn't have at throw time:

- **`max_attempts`** — engine decides; handler never runs the final throw.
- **`ttl_expired`** — no handler invocation.
- **`invalid_payload`** — fails before handler.
- Even on **`handler_reject`**, you might want policy like "retain longer if `attemptCount > 5`" — handler could pass that on throw, but duplicating logic is worse than a shared policy.

Throw-time `retention` is an **override/hint**, not the primary model.

## Workflows and other primitives

Same idea, different snapshot:

- **Workflow**: policy at terminal transition on `WorkflowRow` (status, error, args, …). No throw integration — body uses `ctx.errors` for failure, not retention. Operator `setRetention` stays an override on the persisted deadline.
- **Requests**: snapshot at resolved / timedOut / cancelled.
- **Topics**: still separate — log compaction, not terminal-row retention.

No static maps anywhere; shorthand like `{ processed: 86400 }` can be dropped entirely if you want one shape only.

## `null` while assigning

Two acceptable semantics:

1. **`retention_deadline_at` unset until finalize runs policy** — row exists, not eligible for sweep yet (finalize is immediate after terminal, so this is a brief internal state).
2. **`null` from policy = keep forever** — explicit forever, sweeper never deletes.

Both can coexist: no deadline column until finalize; policy returns `null` → column stays null forever.

## Recommendation

| Mechanism | Role |
|-----------|------|
| `retentionPolicy` on `registerHandler` (client) | Primary; all terminal paths |
| `retention?: number \| null` on `ctx.errors` disposition | Optional override for `handler_reject` |
| Engine-built sync snapshot at finalize | Pure policy input; attempts loaded once here |
| No static status maps | Policy function encodes whatever logic you need |
| No separate `registerRetentionPolicy` | Co-locate with handler registration |

That avoids a second handler species while keeping retention out of the replayed workflow body and out of the throw path for engine-owned terminals.

If you want to move toward types next, the smallest tranche would be: extend `QueueErrorDisposition` with optional `retention`, add `retentionPolicy?` to `QueueHandlerRegistrationOptions`, and define `QueueRetentionContext` — still no runtime sweeper required for the type contract.

---

**User**

ok. how does `readonly attemptCount: number;` and ` readonly lastAttempt: QueueHandlerAttempt<TErrors> | null;` save us from needing all the attempts? I mean they POTENTIALLY cover 80% of use cases. It's true. But this is half-assed. Let's include all the attempts, then, if we don't give the user an accessor. However, we use the accessor pattern somewhere else already: what do we use it for? 

> retention?: number | null on ctx.errors disposition

this was a bad idea. we're effectively smearing retention policies all over the codebase for no apparent reason. let's ditch this idea.

---

**Cursor**

Checking where the accessor pattern is used in the codebase and why.


You're right on both counts.

## `attemptCount` + `lastAttempt` was a compromise

They only help when policy cares about “how many tries” or “what failed last.” Anything like “did we ever see `serialization_error` on attempt 2?” or “pattern across tries” needs the full history. Offering a subset while **not** giving an accessor is the worst of both worlds: incomplete data without the escape hatch.

For retention policy, pass **all attempts**:

```typescript
type QueueRetentionContext<TErrors, TMessage> = {
  readonly status: "processed" | "dead_lettered";
  readonly reason: DeadLetterReason | null;
  readonly message: TMessage;
  readonly attempts: readonly QueueHandlerAttempt<TErrors>[];
};
```

Engine loads them **once at finalize** (same txn as marking terminal). Volume is bounded by `maxAttempts` and failed-tries-only for queues — typically small. Policy stays sync and pure; no lazy loading inside the function.

Agreed: **drop `retention` on `ctx.errors` disposition.** Retention belongs in one place (`retentionPolicy` on registration), not smeared across throws.

---

## What the accessor pattern is for elsewhere

`AttemptAccessor` / `QueueHandlerAttemptAccessor` is **not** for one-shot policy decisions at finalize. It’s for **lazy, async inspection** when the consumer may never need the full history:

| Surface | Who uses it | Why accessor, not an array |
|--------|-------------|----------------------------|
| **`CompensationInfo.attempts`** | `undo` in workflow/compensation body | May only call `.count()` or `.last()` to judge how aggressive undo should be; don’t load full log if unused |
| **`RequestCompensationInfo.attempts`** | Request compensation handler | Same — audit / proportionality |
| **`onConsumeError` → `event.attempts`** | Topic consumer exhaustion callback | Decide skip vs halt; often `.last()` is enough |
| **`deadLetterHandle.attempts()`** | **Operators** triaging after the fact | Introspection API; I/O on demand, possibly long after finalize |
| **`RequestCompensationUniqueHandle.attempts()`** | Client/operator introspection | Same |

Common thread: **optional, deferred, often human-paced reads** over persisted history. Async `last()` / `all()` / `count()` is fine because nothing requires a single synchronous snapshot with full data.

Retention is different:

- Runs **exactly once** per terminal row  
- Must be **sync and pure**  
- Policy may need **any** attempt  
→ Engine materializes `readonly attempts[]` into the context. No accessor.

So: **accessor for inspection over time; array for finalize-time policy.**

---

## Locked shape (queues)

```typescript
client.queues.emailQueue.registerHandler(handler, {
  retryPolicy: { ... },
  retentionPolicy: (ctx) => {
    if (ctx.status === "processed") return 86400;
    if (ctx.attempts.every((a) => a.code === "InvalidPayload")) return 3600;
    return 86400 * 30;
  },
});
```

- **`retentionPolicy?`** on `registerHandler` options (client)  
- **`null`** = keep forever  
- **`number`** = seconds from finalize  
- **No** static maps, **no** retention on `ctx.errors`  
- **Full `attempts`** in context  

Engine-only terminals (`max_attempts`, `ttl_expired`, `invalid_payload`) and successful **processed** paths use the same policy with the same snapshot shape.

Workflows/requests can follow the same pattern later: `RetentionPolicy` with a terminal row snapshot; workflows keep operator `setRetention` as an override on the stored deadline, not a second policy language.

If you want to move to types next, the tranche is: `QueueRetentionContext`, `RetentionPolicy` alias, optional `retentionPolicy` on `QueueHandlerRegistrationOptions`, and doc updates — no runtime sweeper yet.

---

**User**

ok, let's go back to the accessor. what is the difference between the current use case and the other use case, where we use the accessor? I understand that we don't want to expose any async operations and IO - but essentially, can you get back to me with the accessor usage? I find the use cases nearly similar: we want to enable introspection after something happen, but not include all the details eagerly.

---

**Cursor**

Reviewing accessor call sites to compare them with the retention-policy case.


The use cases **are** similar at a high level: something finished (or failed), and later code wants to inspect what happened without the engine having guessed upfront what you’ll need. The difference isn’t “introspection vs not” — it’s **who reads, when, whether they always read, and whether partial reads are common**.

## What accessor is used for today

**1. Compensation `undo` — `CompensationInfo.attempts`**

After a forward step completes, times out, or is terminated, `undo` gets an `AttemptAccessor`. Typical use: decide how hard to compensate — maybe only `await info.attempts.count()` or `await info.attempts.last()`, not the full log.

```typescript
// steps.md pattern
const forwardAttempts = await info.attempts.all(); // when you need the full story
```

**2. Request compensation — `RequestCompensationInfo.attempts`**

Same shape: forward request outcome + lazy attempt log for the compensation handler.

**3. Topic `onConsumeError` — `event.attempts`**

When retries are exhausted, the consumer chooses skip vs halt; often informed by recent failures, not necessarily every row.

**4. Operator / client introspection — `deadLetterHandle.attempts()`, request-compensation handle `attempts()`**

Human or tooling opens a handle **long after** finalize. May never call `attempts()` at all (only `fetchRow`). If they do, might iterate async or only fetch `last()`.

Across all of these: **read is optional, often partial, and may happen much later than the terminal transition.**

---

## Retention policy — why it felt different

Retention also runs “after something happened” and may care about attempts. The differences:

| | **Accessor use cases** | **Retention policy** |
|--|------------------------|----------------------|
| **Must run?** | No — you might never call `.all()` | Yes — every terminal row gets a deadline (or explicit `null`) |
| **When** | During `undo`, in a callback, or whenever an operator opens a handle | **At finalize**, in the same engine step as “mark terminal” |
| **Read pattern** | Often partial (`count`, `last`) | Policy may need **any** attempt; we said pass full `attempts[]` |
| **Who** | Workflow/compensation body, topic consumer, operator | Client code registered with the engine (not replayed workflow body) |
| **Async OK?** | Yes — `undo` is already async; operator I/O is async | We wanted **sync + pure** so finalize stays a simple “compute deadline, persist, done” |

So the split wasn’t really “introspection vs retention.” It was:

- **Lazy capability** — “here’s a handle to history; call when/if you need it.”
- **Mandatory snapshot** — “engine must run this once now and persist the result.”

If retention policy always runs and often needs the full attempt list, **lazy accessor buys nothing at finalize** — you’d end up doing `await ctx.attempts.all()` every time anyway.

---

## Where your intuition is right

For **dead-letter operator triage**, retention context and `deadLetterHandle.attempts()` are almost the same story:

- Message is terminal.
- Something might inspect attempts to decide… something.

The distinction there is **role**, not data:

- **Retention policy** (at finalize): engine-internal, runs once, output is **`retention_deadline_at`** persisted on the row.
- **`attempts()` on handle**: external introspection, runs zero or many times, output is **whatever the operator does** (retry, purge, dashboard).

Same underlying rows; different **consumers and side effects**.

Compensation is slightly different again: `undo` is **durable user logic** that *branches* on history but doesn’t set GC deadlines. Accessor fits “I might only need a count.”

---

## Do we need two shapes?

Not necessarily two **concepts** — two **loading strategies**:

1. **`AttemptAccessor`** (async, lazy) — history might not be read; partial reads are common; caller is async anyway.
2. **Preloaded readonly snapshot** — history is always loaded once; exposed as `readonly attempts[]` **or** a sync read-only view:

```typescript
// Same ergonomics, no IO — data already materialized at finalize
type AttemptSnapshot<T> = {
  readonly count: number;
  readonly last: T | null;
  readonly all: readonly T[];
};
```

Retention policy gets `AttemptSnapshot` (or plain `attempts[]`). Operators keep async `QueueHandlerAttemptAccessor` on the handle. Compensation keeps async `AttemptAccessor` so `undo` doesn’t pay for `.all()` when it only calls `.count()`.

That’s the honest answer to “why not accessor for retention?”: not because introspection is different, but because **retention always consumes the snapshot at finalize**, while accessor optimizes for **optional / partial / later** reads.

---

## Summary

- **Accessor** = deferred, optional introspection (compensation, callbacks, operator handles).
- **Retention policy** = mandatory, immediate, finalize-time decision; full attempts in a **sync preloaded snapshot** is consistent, not “half-assed,” as long as we don’t pretend lazy partial access is enough.
- **No `retention` on `ctx.errors`** — agreed; one policy on `registerHandler`.

If you want to push unification further, the clean line is: **async lazy accessor for callers that may skip or skim; sync snapshot (full array) for code the engine always runs once at finalize.** Same records, different materialization — not two different domain ideas.

---

**User**

what if we exposed a similar accessor on the retention decision callback and made the callback asynchronous? I know that the callback must be pure: and it is supposed to be, however, it's entirely out of our reach to force devs to maintain functional purity. Despite the IO, the accessor version is still going to be pure: there will be no further attempts made due to the fact that we've reached the final state. so the only thing holding us back from implementing this with the accessor is, it seems, a misconception that any async callback is impure by nature.

---

**Cursor**

You're right to push on this. The blocker was overstated.

## What we actually need from retention policy

Not **synchronous** and not **mathematically pure** in the FP sense. The engine needs:

1. **Terminal state is fixed** — no new attempts, no status changes while the policy runs.
2. **Input is only durable history** — terminal row + attempt log already committed (or read in the same finalize transaction).
3. **Output is a single deadline** — `number | null`, persisted once on the row.
4. **Same persisted inputs → same deadline** — deterministic for ops/replay of finalize, not “no `async` keyword.”

`await ctx.attempts.all()` against a dead message’s log doesn’t violate any of that. Neither does `await ctx.attempts.last()`. The accessor only reads history for a row that’s already final; nothing in the queue lifecycle can append attempts after that.

Calling that “impure” because it’s async conflates **I/O** with **nondeterminism**. Reading your own DB rows at finalize is the same class of thing as compensation doing `await info.attempts.count()` — and you already accept that on a **replayed** path.

## Accessor vs eager array — reframed

The real split isn’t purity; it’s **API uniformity**:

| Surface | When | Accessor |
|--------|------|----------|
| `CompensationInfo.attempts` | During `undo` | Async, lazy |
| `deadLetterHandle.attempts()` | Operator, anytime later | Async, lazy |
| **`retentionPolicy` ctx** | Once at finalize | **Same accessor** |

Same type (`QueueHandlerAttemptAccessor`), same methods, same mental model: “inspect attempt history after the fact.”

At finalize the implementation can still lazy-load on first `.all()` or prefetch internally — policy authors don’t care. They might only call `.count()`; no need to force a full array into the signature.

## Async retention callback is fine

```typescript
client.queues.emailQueue.registerHandler(handler, {
  retryPolicy: { ... },
  retentionPolicy: async (ctx) => {
    const attempts = await ctx.attempts.all();
    if (ctx.status === "dead_lettered" && attempts.length > 10) return 86400 * 90;
    return 86400;
  },
});
```

Engine: message terminal → build `ctx` (row + attempts accessor) → `await retentionPolicy(ctx)` → persist `retention_deadline_at` → commit.

That’s not a misconception to avoid async; it’s a normal async hook with a narrow contract.

## What we can’t enforce (and don’t need to)

Devs can still `fetch()` or write files inside `retentionPolicy`. Same as handlers, `undo`, or `onConsumeError`. Document **“depend only on `ctx`”**; don’t pretend the type system enforces purity.

The meaningful guarantee is **engine-side**: no new attempts after finalize starts, policy runs before the row is eligible for sweep, deadline written once.

## Terminology tweak

| Old framing | Better framing |
|-------------|----------------|
| “Pure sync callback” | **Finalize hook**: async allowed; must return `number \| null`; should depend only on terminal row + attempts |
| “Load all attempts eagerly” | **Accessor on ctx**; load what you need |
| “Async = impure” | **Async read of frozen durable state** is fine |

## One operational note (not a purity note)

Async policy **blocks finalize** until it resolves. Slow or hanging policy blocks the worker. Same as a slow handler. Timeouts on policy are an runtime/ops concern, not a reason to require sync.

---

**Bottom line:** Exposing the same attempt accessor on the retention context and making `retentionPolicy` async is coherent, aligns with the rest of the system, and isn’t weakened by async I/O as long as the row is terminal and the accessor only reflects persisted attempts. The earlier “sync + full array” push was optimization and overstated purity, not a hard requirement.

If you want to type this next: `retentionPolicy?: (ctx: QueueRetentionContext) => Promise<number | null>` with `ctx.attempts: QueueHandlerAttemptAccessor<TErrors>` (plus status, reason, message). No `retention` on throws, no static maps.

---

**User**

let's implement it. I think we've reached the consensus

---

**Cursor**

Implementing queue retention policy types: reviewing current handler registration and related types.


Checking what's implemented and whether anything is still missing from the consensus.


The retention policy consensus is in place. I fixed the remaining typecheck failures in the regression tests and synced the refactor doc.

**What’s implemented**

1. **Types** (`handlers.ts`, `messaging.ts`, `engine.ts`)
   - `QueueRetentionPolicy` — async `(ctx) => Promise<number | null>`
   - `QueueRetentionContext` — `{ status, reason, message, attempts }` at finalize
   - Optional `retentionPolicy` on `QueueHandlerRegistrationOptions`

2. **Regression tests** (`13_queues.ts`)
   - Policy typing, context shape, attempts accessor
   - `@ts-expect-error` for invalid return type (`"forever"`)

3. **Docs**
   - `docs/primitives/queues.md` — handler registration + retention section
   - `refactor/13_queues.MD` — runtime target includes finalize hook + sweeper

4. **`pnpm typecheck`** — passes

**Design recap**

- Retention lives on **`registerHandler`**, not `defineQueue` or `ctx.errors`
- Runs once when the message is terminal (`processed` | `dead_lettered`)
- `null` = keep forever; number = seconds until `retention_deadline_at`
- Policy can `await ctx.attempts.all()` — same accessor as dead-letter handles

**Still out of scope (runtime)**

The client worker is still stubbed (`client.ts`). Actual finalize hook, `retention_deadline_at` persistence, and sweeper GC belong in the queue runtime tranche tracked in `refactor/13_queues.MD`.

Want me to start the runtime piece next, or add a short cross-reference in `docs/error-model.md` (retention is registration-plane, separate from `deadLetter` disposition)?

---

**User**

I'd like us to finish the docs on queue. Let's not concern ourselves with the queue runtime Implementation yet.

---

**Cursor**

Reviewing queue docs and types to identify gaps and align documentation with the agreed API.


Expanding `queues.md` to match other primitive docs and updating `error-model.md` for retention and the queue vs workflow `ctx.errors` distinction.


Queue documentation is now aligned with the other primitive docs (`requests.md`, `topics.md`). No runtime changes.

### `docs/primitives/queues.md`

Expanded from a reference-style doc into a full primitive guide:

- **Why it exists** — how queues differ from topics, channels, requests, and steps
- **What it is NOT** — explicit boundaries (`MANUAL`, workflow `ctx.errors`, definition vs client config)
- **Examples** — definition, workflow enqueue, handler registration with retention, compensation enqueue
- **Message lifecycle** — pending → processing → processed / dead-lettered
- **Handler registration** — `Unsubscribe`, competing consumers, full `retryPolicy` field table, `maxAttempts: null` behavior
- **Row retention** — clarified separation from `deadLetter` disposition
- **`QueueHandlerAttemptAccessor`** — `last`, `all`, `count`, iteration APIs
- **Dead letters** — reason table, `purge`, branded `DeadLetterId`, expanded operator examples
- **Notes** — workflow slot vs client namespace, type regression pointer

### `docs/error-model.md`

- Clarified that handlers don't use the **workflow body's** `ctx.errors` (queue handlers use queue-definition `ctx.errors`)
- Added **`retentionPolicy`** on the registration plane, separate from throw disposition

### `refactor/13_queues.MD`

- Source coverage notes that docs cover types/operator surface; runtime remains deferred

If you want a follow-up, we could add a short cross-link from `docs/primitives/steps.md` compensation section back to the queue compensation example — but that's optional polish, not a gap in the queue doc itself.

---

**User**

use the writing-docs rule and rewrite the queues.md accordingly.

---

**Cursor**

Rewriting `queues.md` per the writing-docs rule: lead with working code, explain on its own terms, and move exhaustive reference material to the end.


Rewrote `docs/primitives/queues.md` to follow the writing-docs rule. Main changes:

**Structure**
- Opens with a short standalone description, then **Quick start** (define → enqueue → register handler) before reference material
- Moved all field tables, lifecycle, attempt shapes, and API matrices into a single **Reference** section at the end

**Removed**
- "Why it exists" and "What it is NOT" (contrast-first framing)
- Negative API callouts (`does not accept txOrConn`, `never on defineQueue`, etc.)
- Preemptive design defenses ("retention is independent of deadLetter", "no static status map")
- Heavy bolding and internal type names in explanatory prose (`HasDefaultTtl`, `QueueHandlerDeclaredError`, etc.)
- Type regression pointer (acceptance contract, not user docs)

**Kept as usage guidance**
- Delay/ttl semantics with a concrete numeric example (needed to use ttl correctly)
- `ctx.errors` + `deadLetter` with code examples
- Dead-letter operator flow with `retry` / `purge`
- Link to `error-model.md` and `steps.md` where the reader needs adjacent context

The doc now reads cold: problem → working code → deeper usage → exhaustive reference.

---

**User**

@docs/primitives/queues.md:45-49 i'd say this example is misleading, since we deserialize the payload before  we enter the handler.

---

**Cursor**

Updating the example to use post-decode business validation and aligning the error code name with that.


Good catch. The handler example now rejects an unsupported `template` value — business logic after decode — instead of re-validating the schema.

I also added a line in **Handling messages** that schema failures become `invalid_payload` dead letters before the handler runs, and aligned the enqueue payloads with the updated message shape (`template` field).

---

**User**

ok. what next? we seem to have uncovered some inconsistencies with the queue handler design that might also translate to request handler design as well with the MANUAL return. what do you think?

---

**Cursor**

Reviewing request and queue handler designs side by side to give a grounded comparison.


Yes — the queue work surfaced a pattern that applies to requests, but the **symmetry is partial**, not one-to-one.

## What queues clarified

Three separations that were easy to blur in docs and API shape:

1. **Engine boundary vs handler logic** — schema decode happens before the handler; handler code operates on decoded values. Our bad `isValid(message)` example was conflating those layers.

2. **Definition vs registration** — the queue *contract* (`message`, optional `errors`) lives on `defineQueue`; *operational* policy (`retryPolicy`, `retentionPolicy`) lives on `registerHandler`.

3. **Outcome disposition vs terminal storage** — `deadLetter` on a throw answers “retry or dead-letter now?”; `retentionPolicy` answers “how long to keep the row after terminal?” Those are different axes.

Requests already have (1) implicitly in docs (“decoded payload”) but it isn’t stated as clearly as we now do for queues. They’re weaker on (2) and have a fuzzier version of (3).

## How this maps to requests + `MANUAL`

Requests are structurally different: the handler has a **success path that returns `TResponse`**, not `void`. That changes what “intentional outcome” means.

| Queue handler | Request handler (conceptual parallel) |
|---------------|----------------------------------------|
| `return` | `return response` — invocation **resolved** |
| `throw` + retry | `throw` — failed attempt, retry per policy |
| `throw ctx.errors.X(..., { deadLetter: true })` | No direct analog — “give up permanently” is usually **`return` a domain response** (e.g. `{ approved: false }`), not a sentinel |
| `throw ctx.errors.X(..., { deadLetter: false })` | `throw` (optionally `AttemptError` for structured attempts) |
| Dead-letter (terminal) | `manual`, `cancelled`, or workflow observes `timeout` — different terminal/intermediate states |
| — | `return MANUAL` — **park** the invocation for external resolution (non-terminal) |

So I would **not** rush to give requests a full `defineRequest({ errors })` + `ctx.errors` map just for parity. For requests, “business rejection” often *is* a valid response. `MANUAL` means something queues don't have: **defer without resolving**.

The real inconsistencies with requests are elsewhere:

### 1. `MANUAL` isn’t wired for forward handlers yet

Docs and REFACTOR say forward handlers return `TResponse | MANUAL`. Types today scope `MANUAL` to **compensation** handlers only (`workflow.ts`, `14_requests.ts`). That’s the same class of gap we closed for queues in types — docs ahead of implementation.

### 2. `MANUAL` is unstructured

Queue declared errors give you `code`, `message`, optional `details`, and `deadLetter` on every intentional throw. `MANUAL` is a bare sentinel — no reason, no typed attempt record for “why we parked this.” If operators query `status: manual`, they get payload but not a structured escalation reason unless you bolt it on elsewhere.

That may be fine (manual mode *is* the signal), but it’s asymmetric with queue attempt history.

### 3. Registration-plane policy is underspecified

Queues now have `retentionPolicy` on `registerHandler`. REFACTOR still has request `retention: { resolved, timedOut, cancelled }` on `defineRequest` — the same “static map on definition” smell we rejected for queues. If requests get retention, I’d put it on **`registerRequestHandler`** with a terminal context, same pattern.

Similarly `onExhausted` belongs on registration (docs say yes; forward handler types don’t have it yet).

### 4. Docs/examples risk the same mistake

A request handler example that “validates” the payload shape in-handler would be misleading for the same reason. Permanent domain outcomes should be **`return`**, transient faults **`throw`**, external resolution **`return MANUAL`**.

## What I’d do next

**Short term (low controversy):**

1. **Requests doc pass** under `writing-docs` — same structure as queues; explicit “payload is decoded before handler runs”; examples that use business logic, not schema re-validation.
2. **Types tranche for requests** — forward `registerRequestHandler` with `TResponse | typeof MANUAL`, required `retryPolicy`, optional `onExhausted`, mirror queue registration shape.
3. **Fix `MANUAL` typing** — one sentinel for forward + compensation (divergence #5 in `requests_divergence.md`).

**Design decision (worth a short discussion before coding):**

4. **Retention for requests** — adopt queue-style `retentionPolicy(ctx)` on `registerRequestHandler` with terminal statuses (`resolved`, `cancelled`, `timedOut`?), drop static retention map from `defineRequest` if it’s still in REFACTOR.
5. **Structured manual escalation** — optional, not required for parity:
   - *Minimal:* keep `MANUAL`, document that attempt rows only cover throws; entering manual mode is its own persisted transition.
   - *Richer:* `return ctx.manual("waiting for inventory", { ... })` or optional `errors` map for **throws only** (still not for successful rejection responses).

I would **not** add `defineRequest.errors` + `ctx.errors` unless you have a concrete need for typed **failed-attempt** vocabulary beyond `AttemptError` — requests already have a first-class success channel (`response`) that queues lack.

## Bottom line

The transferable lesson is **layer separation** (decode → handler logic → disposition → retention), not “requests should look exactly like queues.” `MANUAL` is the request-native disposition for “park for external resolution”; queue `deadLetter` is terminal rejection. The actionable inconsistencies are: forward `MANUAL` not in types, registration options incomplete, retention placement undecided, and docs that could repeat the pre-decode confusion.

If you want to continue, I’d start with the **requests types + doc pass** (parallel to what we just did for queues) and treat retention / structured manual as a follow-up design choice.

---

**User**

well, I'd argue here. you see, a business decision to return something as a response is in fact a correct case. however, let's consider the idea of manual resolution. It is a return currently, however, the return lacks any metadata for the operator to decide the manual resolution strategy. I know that it's mostly an overkill, but for the requests we lack both:

1. structured errors
2. manual resolution metadata

Which seems to be the same case as we had with `deadLetter: true` for the queue handlers, but for requests we could make it `manual: true`. What do you think?

---

**Cursor**

Your instinct is right, and I think the queue work actually **sharpens** the request design rather than forcing a copy-paste.

## Where I agree

Returning a typed response for a business outcome (`{ approved: false }`, `{ kind: "rejected", reason: "..." }`) is correct — that **is** resolution. Manual mode is a different thing: the invocation stays open, and someone else must act. Today `return MANUAL` encodes that state transition with **no operator-facing structure**.

So yes, requests are missing the same two layers queues now have:

1. **Declared handler vocabulary** — typed codes + optional `details` on intentional non-resolution paths
2. **Disposition** — what the engine does with that vocabulary (`deadLetter` for queues; **`manual`** for requests)

Bare `MANUAL` is the request equivalent of throwing an undeclared error with no message — it works, but operators and retention policies can't reason about *why* something is waiting.

## The key design move: `manual: true`, not `return MANUAL`

I'd push this one step further than "add metadata to the return."

For queues, **all intentional non-success is `throw ctx.errors(...)`** because `return` means processed. For requests, **`return` should mean resolved** — only `TResponse`. Manual mode should not be a second return channel.

That gives you symmetry:

| Request handler | Expression |
|-----------------|------------|
| Resolved (including business rejection) | `return response` |
| Park for external resolution | `throw ctx.errors.X(message, { manual: true })` or `throw ctx.errors.X(message, details, { manual: true })` |
| Transient fault, retry | `throw ctx.errors.X(..., { manual: false })` or unhandled `throw` |

```typescript
const humanReview = defineRequest({
  name: "humanReview",
  payload: z.object({ documentId: z.string() }),
  response: z.object({ decision: z.enum(["approve", "reject"]), note: z.string() }),
  errors: {
    NeedsSeniorApproval: z.object({ tier: z.number() }),
    RulesEngineUnavailable: true,
  },
});

client.registerRequestHandler(humanReview, async (payload, ctx) => {
  const auto = await tryRulesEngine(payload, { signal: ctx.signal });
  if (auto) return auto;

  throw ctx.errors.NeedsSeniorApproval(
    "Document exceeds auto-approval tier",
    { tier: 3 },
    { manual: true },
  );
}, { retryPolicy: { maxAttempts: 3, timeoutSeconds: 60 } });
```

An operator querying `status: "manual"` gets `code`, `message`, and typed `details` — same ergonomics as dead-letter inspection on queues.

`return MANUAL` becomes unnecessary; `onExhausted` would **`throw ctx.errors....({ manual: true })`** (or a dedicated code) instead of returning the sentinel.

## Structured errors without polluting the response schema

The `errors` map should cover **handler operational outcomes**, not business results:

- **In the response schema:** "approved / rejected / priced / unavailable" — things the workflow awaits as the contract
- **In the errors map:** "why we're in manual", "why this attempt failed" — things operators and attempt logs need

That keeps business rejection as `return` and avoids stuffing operator metadata into `TResponse` just because manual mode exists.

## What gets persisted

Rough parallel to queues:

- **Failed attempts** (`manual: false` or unhandled throw): attempt rows with declared `code` / `message` / `details` (queue-style `serialized` / `serialization_error` union is worth reusing)
- **Manual transition** (`manual: true`): persist the declared error on the request row (or a dedicated manual snapshot) when status becomes `manual` — what operators search on
- **Resolved**: response row as today

Retention policy on `registerRequestHandler` can then branch on terminal/manual context the same way queue `retentionPolicy` branches on `status` / `reason`.

## Caveats I'd flag upfront

1. **`manual: true` is not terminal** — unlike `deadLetter: true`. The invocation stays open until `resolve`, `cancel`, or workflow timeout. Docs need to say that clearly.

2. **Compensation handlers** — they also use `MANUAL` today. Decide whether compensation gets the same `ctx.errors` + `{ manual: true }` pattern, or stays a separate smaller surface (compensation manual might mean "block until operator skips" — related but not identical).

3. **Optional `errors` map** — same as queues: omit it, you only get unstructured throws + retry; no typed manual escalation.

4. **Not overkill if optional** — teams doing simple auto-resolve → manual can use a single `Escalated: true` code; teams doing tiered routing get structure without forcing everyone to model business outcomes as errors.

## Bottom line

I think **`defineRequest({ errors })` + `throw ctx.errors.X(..., { manual: true | false })`** is the right unification:

- `manual: true` ≈ queue `deadLetter: true` in role (intentional disposition with metadata)
- `return TResponse` stays the only resolution path
- bare `MANUAL` can be retired

If you want to proceed, the natural sequence is: types + `14_requests.ts` regression (mirror `13_queues.ts`), rewrite `requests.md` under writing-docs, then update `error-model.md` and REFACTOR Part 11. I wouldn't touch runtime yet, same as queues.

Want me to start with a concrete type sketch for `RequestHandlerDeclaredError` and the registration options, or write the design into a short ADR-style note first?

---

**User**

the compensation must have its own error map. 

> manual: true is not terminal — unlike deadLetter: true. The invocation stays open until resolve, cancel, or workflow timeout. Docs need to say that clearly.

correct

so effectively the error model looks familiar, but has slightly different behavior based on the primitive.

---

**Cursor**

Yes — that's the right mental model: **one familiar authoring pattern**, **primitive-specific recognition rules**.

## Shared shape

Each execution plane that needs structured handler outcomes declares an **`errors`** map (`true` or schema per code) and gets **`ctx.errors.<Code>(...)`** factories. Intentional non-success is always **`throw`**, never confused with the success channel.

The difference is what the **disposition flag** does — or whether there is one at all.

## By primitive

| Plane | Success channel | Declared errors | Disposition | Effect |
|-------|----------------|-----------------|-------------|--------|
| **Workflow body** | `return` | `defineWorkflow.errors` | *(none)* | Terminal `failed` + compensation |
| **Queue handler** | `return` (void) | `defineQueue.errors` | `{ deadLetter: true \| false }` | Dead-letter now vs retry |
| **Request handler** | `return` response | `defineRequest.errors` | `{ manual: true \| false }` | Enter `manual` with metadata vs retry |
| **Request compensation** | `return` result | **compensation's own `errors` map** | `{ manual: true \| false }` (likely same) | Park compensation vs retry compensation |
| **Step handler** | `return` | — | — | `AttemptError` / ordinary throw → retry |
| **Topic consumer** | `return` (void) | — | — | `UnrecoverableError` vs retry |

Workflow is the outlier: no disposition because there is no retry loop — declared throw is always terminal business failure.

## Request forward vs compensation

Two separate maps, two separate `ctx.errors` namespaces:

```typescript
defineRequest({
  name: "humanReview",
  payload: ...,
  response: ...,
  errors: { NeedsSeniorApproval: z.object({ tier: z.number() }) },
  compensation: {
    result: z.object({ released: z.boolean() }),
    errors: { ReleaseBlocked: true },
  },
});
```

Forward handler: `return` resolves the request; `throw ctx.errors.X(..., { manual: true })` parks the **invocation** until `resolve` / `cancel` / workflow timeout.

Compensation handler: `return` reports compensation outcome; its **own** `ctx.errors` with `{ manual: true }` parks the **compensation block** until operator action — same pattern, different row/lifecycle.

Bare `MANUAL` retires on both paths.

## What docs should stress for requests

`manual: true` is **not** resolution and **not** terminal. The request stays open. Operators (or automations) use the persisted `code` / `message` / `details` to decide strategy, then call `resolve` or `cancel`. Workflow timeout remains a separate observation on the call site.

Business outcomes stay in **`return response`** — that's the contract the workflow awaits.

## error-model.md framing

One section, three handler dispositions:

- **Queues** — `deadLetter`: terminal reject vs retry  
- **Requests** (forward + compensation) — `manual`: park vs retry  
- **Workflow** — no disposition; throw is always terminal failure  

Same factories, different state machines underneath.

If you want to move forward, the next concrete step is a types tranche: `defineRequest.errors`, compensation `errors`, `RequestHandlerDeclaredError` + `{ manual }`, mirror `13_queues.ts` in `14_requests.ts`, then docs. Say the word and I'll start there.

---

**User**

let's begin the refactor

---

**Cursor**

Starting the request-handler error model refactor using the queue implementation as a template. Exploring the codebase to map current types and registration surfaces.


Implementing types systematically, starting with `results.ts`.


Writing regression tests and updating dependent files.


Fixing type inference issues:


The request handler error model refactor is in place at the types layer. `pnpm typecheck` passes.

## What changed

### API shape (mirrors queues, with `manual` disposition)

- **`defineRequest({ errors })`** — forward handler error map
- **`compensation: { errors, result? }`** — separate compensation error map
- **`throw ctx.errors.X(..., { manual: true | false })`** — replaces `return MANUAL`
- **`return response`** — only path for resolution (including business rejection)
- **`RequestHandlerDeclaredError`** — exported alongside `QueueHandlerDeclaredError`
- **`MANUAL`** — removed from public exports

### Types added

- `RequestErrorDisposition`, `RequestErrorFactories`, `RequestHandlerDeclaredError`
- `RequestHandlerAttempt*` types (parallel to queue attempts, with `manual` instead of `deadLetter`)
- `RequestHandlerContext` / `RequestCompensationHandlerContext` with `ctx.errors`
- `InferRequestErrors`, `HasRequestErrors`, `InferRequestCompensationErrors`, `HasRequestCompensationErrors`

### Registration

- **`client.requests.<name>.registerHandler`** — typed like queue registration
- **`registerRequestCompensationHandler`** — compensation `ctx.errors`, return type is result-only (throws for manual)

### Tests & docs updated

- `14_requests.ts` — full acceptance suite for forward + compensation errors
- `08_compensation_model.ts`, `refactor/17_handler_early_termination.ts`, `13_queues.ts`, `refactor/20_public_exports_and_connection.ts`
- `docs/error-model.md`, `refactor/14_requests.MD`

## Design recap

| Primitive | Disposition | Terminal? |
|-----------|-------------|-----------|
| Queue | `deadLetter: true/false` | `true` → dead-letter |
| Request (forward + compensation) | `manual: true/false` | `true` → `status: manual`, stays open |

## Still out of scope (next tranches)

1. **`docs/primitives/requests.md`** — rewrite under writing-docs (still describes `MANUAL`)
2. **REFACTOR.MD Part 11** — sync with new API
3. **Runtime** — recognize `RequestHandlerDeclaredError`, persist manual metadata, worker behavior
4. **`retentionPolicy`** on request registration (if you want queue parity)

Want me to do the `requests.md` doc pass next, or continue into REFACTOR Part 11?

---

**User**

let's rewrite the requests docs.

---

**Cursor**

Rewriting `requests.md` to match the queues doc style and updating the linked async-resolution doc.


Rewrote `docs/primitives/requests.md` following the same pattern as `queues.md` and the writing-docs rule.

**Structure**
- Short intro, then **Quick start** (define → await → register handler)
- **Calling from workflows** — direct await vs `{ priority, timeout }` union
- **Handling requests** — `return` for resolution, `ctx.errors` + `{ manual }`, business rejection via return
- **Manual resolution** — query, `resolve`, `cancel`
- **Compensation** — separate `errors` map, `registerRequestCompensationHandler`
- **Example** — waitlist pattern (trimmed from the old flight-booking narrative)
- **Reference** — lifecycle statuses, handler outcomes, attempts, compensation `info`, client API

**Removed**
- "What it is / Why / What it is NOT" contrast framing
- `MANUAL` sentinel and `client.registerRequestHandler(def, …)` (API is `client.requests.<name>.registerHandler`)
- Long inline flight-booking walkthrough prose

**Also updated** `docs/resolving-requests-asynchronously.md` to replace `MANUAL` with `throw ctx.errors.X(..., { manual: true })` so the cross-link stays accurate.

---

**User**

> Optional onExhausted runs when handler retries are exhausted. It receives the same ctx.errors surface and must return a response or throw with { manual: true }:

Is this true, however? I think we should change that to "any error thrown within the onExhausted callback will lead to request moving to manual resolution mode" - and we can even remove the `manual` flag from the `ctx.errors` in case of the request compensation context. It's either a response or a move to manual: there is no third way we can go.

So: regular request context: we can choose whether we move to manual on throw or not. onExhausted: there will be no retries, so it's any throw = move to manual or return a result. Sounds like a plan?

---

**Cursor**

Aligning types and docs with that model: `manual` stays on the forward handler; `onExhausted` and compensation treat any throw as manual escalation.


Implementing separate error factory types: dispositioned for the forward handler, manual-only for `onExhausted` and compensation.


Yes — that split is the right model, and it's now reflected in types, regression tests, and docs.

**Forward handler** (regular `registerHandler` context):
- `return response` → resolve
- `throw ctx.errors.X(..., { manual: true })` → manual
- `throw ctx.errors.X(..., { manual: false })` or unhandled throw → retry

**`onExhausted`**, **compensation handlers**, and **compensation `onExhausted`**:
- `return` → resolve / report compensation outcome
- **Any throw** (including `ctx.errors.X(...)`) → manual
- No `{ manual }` on `ctx.errors` there — `RequestManualEscalationErrorFactories` mirrors workflow-style factories: `(message)` or `(message, details)` only
- `retryPolicy` removed from `onExhausted` blocks (no retries left at that point)

The old doc line was wrong: `onExhausted` doesn't share the forward handler's disposition surface. In exhaustion/compensation contexts there really are only two outcomes — return or move to manual via throw.

`pnpm typecheck` passes. Regression tests include `@ts-expect-error` for `{ manual }` on compensation and `onExhausted` contexts. Updated: `docs/primitives/requests.md`, `docs/error-model.md`, `docs/resolving-requests-asynchronously.md`, and `refactor/14_requests.MD`.

---

**User**

ok. sanity check: have we done all the requests-related refactors: docs, types, regression tests, REFACTOR.MD correction?

---

**Cursor**

Auditing request-related work across docs, types, regression tests, and REFACTOR.MD.


**Short answer:** The **types + regression + user-facing docs** tranche for the new request error model is done. **`REFACTOR.MD` and several working notes are not updated** — that's the main gap.

### Done

| Area | Status | Notes |
|------|--------|-------|
| **Types** | ✅ | `defineRequest` + forward `errors`; compensation `errors`; `RequestErrorFactories` vs `RequestManualEscalationErrorFactories`; `client.requests.<name>.registerHandler`; forward + compensation `onExhausted` (no `retryPolicy` on exhaustion); `RequestHandlerDeclaredError` / attempt types; `MANUAL` removed from exports |
| **Regression tests** | ✅ | `14_requests.ts` (forward `{ manual }`, `onExhausted`, compensation, client `registerHandler`, manual resolution queries); `08_compensation_model.ts`; `refactor/17_handler_early_termination.ts` (uses `ctx.errors`, not `MANUAL`); `refactor/20_public_exports_and_connection.ts` (`MANUAL` not public) |
| **User docs** | ✅ | `docs/primitives/requests.md`, `docs/error-model.md`, `docs/resolving-requests-asynchronously.md` |
| **Step spec** | ✅ | `refactor/14_requests.MD` reflects current API |

`pnpm typecheck` is green.

### Not done / stale

| Area | Status | What's wrong |
|------|--------|--------------|
| **`REFACTOR.MD` Part 11** | ❌ | Still has `request:` (not `payload:`), `MANUAL` sentinel, `client.registerRequestHandler(def, …)`, `onExhausted` returning `MANUAL` with its own `retryPolicy`, compensation handlers returning `MANUAL` — all superseded |
| **`REFACTOR.MD` Part 15b** | ❌ | Still documents `return MANUAL` for check-or-wait; current model is `throw ctx.errors.X(..., { manual: true })` |
| **`REFACTOR.MD` exports / breaking changes** | ❌ | Still lists `MANUAL` as a new export (~line 2951) and mentions MANUAL return (~3079) |
| **`docs/primitives/requests_divergence.md`** | ❌ | Describes pre-tranche state (no client `registerHandler`, `MANUAL` for compensation only, forward `onExhausted` missing) — all resolved in types |
| **Other `refactor/*.MD` notes** | ⚠️ | `08_compensation_model.MD`, `17_handler_early_termination.MD`, `20_public_exports_and_connection.MD` still reference `MANUAL` return |

### Minor doc nit (not blocking)

In `docs/primitives/requests.md` line 122, *"Every `ctx.errors` call requires `{ manual }`"* is only true for the **forward handler** context — `onExhausted` and compensation use the manual-escalation surface (no `{ manual }`).

### Explicitly deferred (not part of this tranche)

- **Runtime** — `client.ts` `registerHandler` / `resolve` / `cancel` are still stubs
- **`retention`** on `defineRequest` — spec-only in REFACTOR, not in types
- **Queues-style extraction banner** for Part 11 (`> Extracted → docs/primitives/requests.md`) — queues have this; requests don't yet

---

**Verdict:** For the **error-model / handler-API refactor** you drove (ctx.errors, onExhausted/compensation semantics, client registration shape), **types + tests + user docs are complete**. **`REFACTOR.MD` correction was explicitly deferred and is still the outstanding piece**, along with updating or deleting `requests_divergence.md` and the stale `refactor/*.MD` cross-references.

Want me to do the REFACTOR.MD Part 11 + 15b sync next (mirroring what was done for queues)?

---

**User**

> docs/primitives/requests_divergence.md

I think this can be safely removed, since we've gone beyond what the document used to propose, it seems.

> REFACTOR.MD Part 11
> REFACTOR.MD Part 15b
> REFACTOR.MD exports / breaking changes

must be fixed, but again, I thought the model was to link to the proper docs/primitive/[name].md file instead of rewriting the refactor docs.

> Other refactor/*.MD notes

this is questionable. let's not touch these files for now.

> Runtime

No runtime yet

> retention on defineRequest

We're gonna need to discuss this separately.

> Queues-style extraction banner

What is that?

---

**Cursor**

Checking how queues extraction was done in REFACTOR.MD, then applying the same pattern for requests.


Applying the queues extraction pattern: removing the divergence doc and replacing REFACTOR.MD Part 11 with a canonical link banner.


**Extraction banner** — the pattern used for queues in `REFACTOR.MD` Part 10: instead of keeping a full duplicate spec in the monolith, the section is replaced with a one-line pointer that the canonical design lives in `docs/primitives/[name].md`:

```1698:1706:REFACTOR.MD
## Part 10: Queues

> **Extracted → [docs/primitives/queues.md](docs/primitives/queues.md)** (canonical). This section now lives in its own document; the design there is authoritative.

---

## Part 11: Requests

> **Extracted → [docs/primitives/requests.md](docs/primitives/requests.md)** (canonical). This section now lives in its own document; the design there is authoritative.
```

`REFACTOR.MD` stays the index for cross-cutting architecture; per-primitive user-facing API docs are authoritative in `docs/primitives/`.

---

**Done in this pass:**

- Deleted `docs/primitives/requests_divergence.md` (nothing referenced it)
- Replaced **Part 11** (~330 lines of stale `MANUAL` / `registerRequestHandler` / Postgres content) with the extraction banner above
- Updated **Part 15b** — request section now points to `requests.md` (same shape as queue handlers → `queues.md`); removed `MANUAL` return semantics
- Fixed **exports** — `MANUAL` → `RequestHandlerDeclaredError`
- Fixed **breaking changes** — manual escalation via `ctx.errors` + link to requests doc
- Updated the `compensations.requests` cross-ref to point at `docs/primitives/requests.md`

**Left untouched** (per your call): `refactor/*.MD` step notes, runtime, retention.

**Note:** Part 11's old content included Postgres schema, compensation query surface (`skip`, `findUnique`), and `retention` — none of that is in `requests.md` yet. If any of it still needs to live somewhere in-repo, that's a separate doc decision (retention you already flagged for later).

---

**User**

ok, as for retention. I think we can do a similar thing as we did with the queues retentionPolicy. it doesn't seem vastly different: the final statuses are, the overall shape is, but the everything else seems practically the same

---

**Cursor**

Comparing queue `retentionPolicy` with the request types and docs so we can mirror the same pattern.


Implementing request `retentionPolicy` on handler registration, mirroring the queue pattern.


Agreed — the queue pattern maps cleanly. The differences are mostly naming:

| | Queues | Requests |
|---|--------|----------|
| **Terminal statuses** | `processed`, `dead_lettered` | `resolved`, `timedOut`, `cancelled` |
| **Non-terminal** | (none that skip retention) | `manual` — retention runs only after later `resolve` → `resolved` or `cancel` |
| **Context payload** | `message` | `payload` + `response` when `status === "resolved"` |
| **Extra context** | `reason` (dead-letter) | — |
| **Where it lives** | `registerHandler` options | same |
| **Return** | `number \| null` seconds | same |

This replaces the old `defineRequest({ retention: { resolved, timedOut, cancelled } })` static map with the same dynamic callback model queues use.

**Implemented (types + tests + docs, no runtime):**

- `RequestTerminalStatus`, `RequestRetentionContext` (discriminated union), `RequestRetentionPolicy` in `handlers.ts`
- `retentionPolicy?` on `RequestHandlerRegistrationOptions`
- Regression coverage in `14_requests.ts`
- Docs in `requests.md`, `error-model.md`, `refactor/14_requests.MD`

**Not in scope:** compensation-instance retention (separate entity/status set) — can add the same pattern on `registerRequestCompensationHandler` later if you want parity there.

`pnpm typecheck` passes. Worth discussing separately: whether `timedOut` vs `cancelled` should carry any extra metadata in the retention context (queues have `reason` for dead letters).

---

**User**

can you remind me the semantics of cancelling a request?

---

**Cursor**

**`cancel`** is an operator action on a forward request handle (`client.requests.<name>.get(id).cancel()`). It is the counterpart to **`resolve`**: it ends the wait **without** recording a typed response.

### What it does

- **Not a resolution** — no `response` is written. The request’s response type is never produced for the workflow (see [resolving-requests-asynchronously.md](docs/resolving-requests-asynchronously.md): cancellations are explicitly “not resolution”).
- **Row becomes terminal** — durable status moves to `cancelled` (`cancelledAt` is set on the row). That’s distinct from `timedOut` (workflow call-time deadline elapsed) and `resolved`.
- **Stops waiting** — from `pending`, `claimed`, or `manual`, an external actor can abandon the invocation instead of resolving it.
- **Idempotent** — `RequestCancelOutcome` is either `{ status: "cancelled" }` or `{ status: "already_terminal", current: … }` if it was already `resolved`, `timedOut`, or `cancelled`.

### Workflow-side observation

- If the workflow called the request **with** `{ timeout, … }`, the await returns a union and failure looks like `{ ok: false, status: "timeout" }` — same shape as a call-time timeout (docs don’t expose a separate `"cancelled"` variant on the workflow result).
- If the workflow called **without** timeout options, the await is typed as the response directly; how cancel surfaces there isn’t spelled out in the current docs (runtime not implemented yet).

### Related semantics

- **`manual` is not terminal** — a parked request stays open until `resolve`, `cancel`, or workflow timeout. `cancel` is one way to close it without approving/rejecting via a typed response.
- **Handler in flight** — `resolve` on a claimed request is specified to interrupt the handler via `AbortSignal`; `cancel` is the symmetric “give up on this invocation” path (exact interrupt behavior for cancel is implied but not as explicitly documented as for `resolve`).
- **`retentionPolicy`** — runs at finalize; `cancelled` is a terminal status like `resolved` and `timedOut`.
- **Compensation** — separate lifecycle; cancelling the forward request is not the same as running or skipping request compensation.

### Mental model

| Action | Response recorded? | Row status | Workflow gets typed response? |
|--------|-------------------|------------|-------------------------------|
| `resolve(response)` | Yes | `resolved` | Yes (or `{ ok: true, result }` with timeout opts) |
| `cancel()` | No | `cancelled` | No — failure/timeout observation only |
| Call-time timeout | No | `timedOut` | No — `{ ok: false, status: "timeout" }` |

So **`cancel` = operator abandonment**: “we’re not going to fulfill this request with a typed answer.” That’s different from a business rejection, which should still be `return { decision: "reject", … }` from the handler (a normal `resolved` outcome).

---

**User**

I think this is a bad idea overall. The effects aren't clear. What happens is: we don't get a typed response, neither do we get any sensible behavior. I think what the client should be able to do is to move a request to manual externally, which will stop any running attempts. `cancel` = `timeout` is very questionable: timeout is caller concern. What do you think? Let's discuss the semantics.

---

**Cursor**

Reviewing how timeout, manual, and cancel are modeled today so we can discuss alternatives concretely.


I agree the current `cancel` design is weak. Here is how I would frame it.

## What is wrong today

`cancel` sits between three things that should stay separate:

1. **Business outcome** — typed `response` (including rejection encoded in the schema).
2. **Handler/operator escalation** — park for external resolution (`manual`).
3. **Caller observation boundary** — workflow `timeout` on the call.

`cancel` is none of these. It records no response, does not enter a well-defined escalation state with operator metadata, and on the workflow side it is documented as masquerading as `{ ok: false, status: "timeout" }`. That conflates **“operator gave up”** with **“caller’s deadline elapsed”**, which are different causes and usually deserve different domain handling.

It also leaves a hole when the workflow did **not** pass `timeout`: the row becomes `cancelled`, but the await is still typed as `TResponse` — so there is no honest workflow-level story.

## A cleaner split of concerns

| Actor | Question they answer | Mechanism |
|-------|---------------------|-----------|
| **Handler** | Can I fulfill this programmatically? | `return response` |
| **Handler** | I need a human/external actor | `throw ctx.errors.X(..., { manual: true })` |
| **Handler** | Transient fault | `throw` with `{ manual: false }` / unhandled → retry |
| **External client** | Stop automation, hand to a human | **Escalate to `manual`** (new explicit API) |
| **External client** | Record the typed outcome | `resolve(response)` |
| **Workflow caller** | How long may *I* wait? | `{ timeout }` on the call → `{ ok: false, status: "timeout" }` |

Under this model, **timeout is only the caller’s concern**. The row gets `timedOut` when the workflow’s observation deadline passes without a response. Nothing else should surface as `"timeout"` to the workflow.

## Your proposal: external → `manual`

That fits well. Something like `escalateToManual(...)` (name TBD) would:

- Be valid from `pending` or `claimed` (and no-op / `already_terminal` from `resolved` / `timedOut`).
- **Abort the in-flight handler** (`AbortSignal`), same as `resolve` on a claimed request.
- **Stop the retry loop** — no further handler attempts.
- Move the row to **`manual`** with optional escalation metadata (`code`, `message`, `details`) for operator UIs and audit.

That is a clear effect: *“automation is done trying; a human or external resolver must `resolve`.”*

It mirrors what the handler already does with `{ manual: true }`, but initiated from outside — useful when:

- a handler is stuck retrying and nobody wants to wait for exhaustion/`onExhausted`;
- ops sees a request in `pending`/`claimed` and wants to take over;
- an admin UI says “escalate this ticket.”

`manual` stays **non-terminal**: the invocation remains open until `resolve` or the **workflow’s** call-time timeout fires.

## Drop `cancel` (or don’t add it)

I would **remove `cancel`** rather than repurpose it.

“What if we never want to fulfill this?” still has honest answers:

- **Business rejection** → `resolve({ decision: "reject", ... })` (a real response, not an error).
- **Caller stops waiting** → workflow passed `timeout`; branch on `{ ok: false, status: "timeout" }`.
- **Caller stops waiting without a timeout on the call** → that is a workflow authoring choice; the engine should not let an external actor fake a timeout the caller did not declare.
- **Abort the whole workflow** → workflow termination / declared `ctx.errors`, not a request primitive hack.

So external clients get **`resolve`** and **`escalateToManual`**, not a third “void outcome.”

## Lifecycle after the change

```
pending / claimed ──handler manual throw──► manual ──resolve──► resolved
        │                                        ▲
        │                                        │
        └── external escalateToManual ───────────┘

(any non-terminal) + workflow call timeout ──► timedOut   (caller observation only)
manual + workflow call timeout ──────────────► timedOut   (still no typed response)
```

Terminal row statuses: **`resolved`**, **`timedOut`**. Drop **`cancelled`** (and `cancelledAt`) unless there is a separate product need — I do not see one that `timedOut` + `manual` + `resolve` do not cover.

`retentionPolicy` terminal set becomes `resolved | timedOut`.

## Open questions for you

1. **Metadata on external escalation** — should `escalateToManual` require / allow the same shape as a declared handler error (`code` + optional `details`), or a generic `{ reason: string }`? Tying it to the request’s `errors` map keeps operator UI consistent with handler-originated manual rows.

2. **From `manual` already** — `escalateToManual` → `already_terminal` with `current: "manual"`, or idempotent success?

3. **Workflow without `timeout`** — if external escalates to `manual` and nobody ever `resolve`s, the workflow waits indefinitely. Is that acceptable (explicit “we’re waiting for a human forever”), or should we require `timeout` on any request call that can reach `manual`? I lean toward leaving it as caller choice, not engine enforcement.

4. **Compensation** — forward `timedOut` vs never-resolved already feeds `RequestCompensationInfo`. Removing `cancelled` simplifies that story.

---

**Summary:** I agree with you. `cancel` is the awkward primitive; **external `escalateToManual` + `resolve`**, with **`timedOut` only from the workflow caller’s `timeout`**, is a much clearer model. If you want to go that direction, the type/doc tranche would be: remove `cancel` / `cancelled`, add handle method for external manual escalation, fix workflow result docs so `"timeout"` is never an alias for operator abandonment, and adjust retention terminal statuses.

Which of the open questions above do you want to nail down before we change types?

---

**User**

So, we're landing on:

- `.resolve`
- `.escalateToManual`

Both of them stop the currently running attempt. But `.resolve` actually puts the return value unblocking the workflow, while the escalation only moves the request to await manual resolution.

The open question is what we're looking at argument-wise. Resolve is easy. Escalation? What if we allowed to assign any error shape, untyped as well? What do you think?

---

**Cursor**

Checking how handler-originated manual escalation is typed today so we can compare external escalation shapes.


I think **untyped + optional typed** is the right landing zone. Here is how I would reason about it.

## What escalation is storing

`escalateToManual` is not a workflow outcome. It is **operator-facing metadata** explaining why automation stopped and a human must act. That is the same job as `throw ctx.errors.X(..., { manual: true })` from the handler: park the row, abort the attempt, persist something queryable for UIs/runbooks.

So the persistence shape should match handler-originated manual rows:

- `message` — always present (human-readable)
- `code` — optional (`string` when declared, `null` when not)
- `details` — optional, schema-validated when `code` is declared

Workflow still waits until `resolve` or the caller’s `timeout`.

## Recommendation: typed when you can, untyped always allowed

```typescript
// Always valid
escalateToManual({ message: "Ops took over — vendor API degraded" });

// When defineRequest declares errors — also valid, compile-time checked
escalateToManual({
  code: "NeedsSeniorReviewer",
  message: "Escalated from admin console",
});

escalateToManual({
  code: "RulesEngineUnavailable",
  message: "Rules engine down",
  details: { ruleId: "R-42" },
});
```

Type-level shape (conceptually):

```typescript
type RequestEscalationInput<TErrors extends ErrorDefinitions> =
  | { readonly message: string }
  | {
      [K in keyof TErrors & string]: TErrors[K] extends true
        ? { readonly code: K; readonly message: string }
        : {
            readonly code: K;
            readonly message: string;
            readonly details: SchemaInvocationInput<TErrors[K]>;
          };
    }[keyof TErrors & string];
```

When `errors` is omitted on `defineRequest`, only the `{ message }` branch exists at compile time — which matches reality (no declared codes to validate against).

### Why allow untyped even when `errors` exists

- Admin consoles often have free-text reasons not worth declaring on the definition.
- External systems (PagerDuty, Zendesk) may supply a string, not a code from your map.
- Handler path can be strict; **external path should be more permissive** — ops is the backstop.

Runtime still validates: if `code` is provided and matches a declared entry, validate `details` against that schema; if `code` is absent, persist `code: null` and skip details validation (or allow opaque `details` later if you need it — I would start without details on untyped).

### Why not *only* untyped

If you only allow `{ message: string }`, you lose:

- `findMany(({ escalation }) => eq(escalation.code, "NeedsSeniorReviewer"))`-style queries
- Consistency with handler-originated manual rows in the same inbox
- Compile-time safety when the console *does* know the code

Typed branches are optional sugar on top of a universal untyped floor.

## Symmetry with handler manual throws

| Source | Typed escalation | Untyped escalation |
|--------|------------------|-------------------|
| Handler | `throw ctx.errors.X(msg, { manual: true })` | unhandled throw with `manual: false` retries; unhandled doesn’t park — so handler untyped manual is really just `message`-only if you add a generic code, or use a declared `OpsEscalation: true` |
| External | `escalateToManual({ code, message, details? })` | `escalateToManual({ message })` |

Handlers **require** `{ manual }` because retry vs park is ambiguous. External `escalateToManual` has no ambiguity — it always parks. That is why external API can be simpler than `ctx.errors`.

## `resolve` vs `escalateToManual` (shared behavior)

Both should:

- Abort the in-flight attempt (`AbortSignal`)
- Be valid from `pending` / `claimed` (and `escalateToManual` from those; `resolve` from `manual` too)

They diverge only on terminal effect for the workflow:

- **`resolve`** → `resolved`, typed response recorded, workflow unblocks
- **`escalateToManual`** → `manual`, no response, workflow keeps waiting (until `resolve` or caller `timeout`)

## Small API details I would nail down

1. **`message` required** on every escalation — even typed ones. Code is taxonomy; message is what operators read.

2. **No bare string overload** — `escalateToManual("reason")` is cute but `{ message }` scales if you add `actor`, `source`, `txOrConn` later.

3. **Already `manual`** — idempotent success or `{ status: "already_manual" }`? I would lean **idempotent success** (maybe refresh metadata only if you want “re-escalate with new note” — optional follow-up).

4. **Already `resolved` / `timedOut`** — `already_terminal`, same as today’s cancel outcome pattern.

5. **Drop `cancel` / `cancelled`** — as discussed; `timedOut` stays caller-only.

## What I would avoid

- **Requiring a declared code** for external escalation — too rigid for ops.
- **Letting external escalation pass arbitrary `code` + unvalidated `details`** — either the code is in the map (validate details) or omit code.
- **A third “void outcome”** besides `resolve` and `manual` — that was the `cancel` problem.

---

**Bottom line:** yes — allow **any escalation shape** in the sense of **untyped `{ message }` always**, plus **typed `{ code, message, details? }` when the request declares `errors`**. That gives operators freedom without giving up typed inboxes where you want them.

If that matches your intent, next step is typing `escalateToManual` on `RequestHandleExternal` and threading the same escalation record into `RequestRow` (and removing `cancel`). Want `details` on untyped escalations (opaque JSON) in v1, or strictly `message` only until someone asks?

---

**User**

agreed 2-5, but let's revisit the shape. I was thinking to allow setting the exact attempt shape. there is the issue of serialization_error, which we shouldn't be able to write, but rather if a type is provided, we expect the typed shape to be present.

---

**Cursor**

Reviewing the request attempt record shapes to propose an `escalateToManual` input that mirrors them without allowing `serialization_error`.


The attempt record is the right **read model**; the write API should be a **projection** of it — same discriminant, minus engine-owned fields, with `details` in **input** form rather than **persisted** form.

## Read vs write

**Persisted attempt** (`RequestHandlerAttempt`):

```typescript
// Declared
{ attempt, manual: true, code, message, details: RequestHandlerAttemptDetails<T> }

// Unhandled  
{ attempt, manual: true, code: null, message, type, details: { status: "unspecified" } }
```

where `RequestHandlerAttemptDetails<T>` can be `serialized | serialization_error | unspecified`.

**Escalation input** should mirror the discriminant (`code: null` vs declared `code`) but:

| Field | Escalation input |
|-------|------------------|
| `attempt` | omitted — engine assigns (next index, or synthetic “escalation” row) |
| `manual` | omitted — always `true` |
| `details` (declared + schema) | **plain schema input**, not the persisted union |
| `details` (declared + `true`) | omitted (`undefined` on read) |
| `details` (unhandled) | omitted — engine writes `{ status: "unspecified" }` |
| `serialization_error` | **not representable** in input — engine-only |

So callers never write persistence outcomes; they write **facts**. The engine validates, wraps as `{ ok: true, status: "serialized", result }`, or records `serialization_error` if validation fails (same as handler throws).

## Proposed input type

```typescript
type RequestManualEscalationInput<TErrors extends ErrorDefinitions> =
  | {
      readonly code: null;
      readonly message: string | null;
      readonly type: string | null;
    }
  | ([keyof TErrors & string] extends [never]
      ? never
      : {
          [K in keyof TErrors & string]: TErrors[K] extends true
            ? { readonly code: K; readonly message: string }
            : {
                readonly code: K;
                readonly message: string;
                readonly details: SchemaInvocationInput<TErrors[K]>;
              };
        }[keyof TErrors & string]);
```

`escalateToManual(record: RequestManualEscalationInput<TErrors>, opts?)`.

That is “exact attempt shape” in the sense of **same union structure** as `RequestHandlerAttempt`, with the writable slice extracted and `details` normalized to input.

You could name it `RequestHandlerAttemptEscalationInput` and document it as `Omit<attempt, manual>` + details input transform — makes the relationship obvious in code.

## Why this is better than `{ message }` / loose `code?`

- **Query parity** — `findMany` on manual inbox sees the same `code` / `message` / `details` whether the handler or an external actor escalated.
- **Type safety** — schema-backed codes require `details` at compile time; `true` codes forbid it.
- **No fake persistence states** — `serialization_error` and `unspecified` on declared codes are engine outputs only.
- **Untyped still works** — `code: null` branch matches `UnhandledRequestHandlerAttempt` (minus engine fields).

## `message` on the unhandled branch

Attempt records allow `message: string | null` (genuine unhandled throws). For external escalation you previously wanted `message` required — that slightly breaks “exact shape” fidelity.

Two options:

1. **Faithful** — keep `message: string | null` on `code: null`; ops can pass `null` (weaker inbox).
2. **Ops-oriented** — require `message: string` on external input only; engine still persists into the unhandled attempt shape.

I’d pick **(2)** for `escalateToManual` only: external actors should always supply a reason. Handler path keeps nullable message for real faults.

## Engine behavior (short)

1. Abort in-flight attempt (`AbortSignal`).
2. Validate input against `errors` map when `code` is set.
3. Append attempt row with `manual: true` and persisted `details` union.
4. Set row `status: manual`, set `manualAt`.
5. Do **not** unblock workflow.

`resolve` does the same abort, then writes response and `resolved`.

## Edge cases

- **No `errors` on definition** — only `code: null` branch type-checks.
- **Invalid `code` at runtime** — reject (don’t fall back to untyped); typed map is the allowlist when you use `code`.
- **Already `manual`** — idempotent success (agreed); optional: refresh last escalation attempt vs no-op.
- **`resolved` / `timedOut`** — `already_terminal`.

## What we drop

- `cancel` / `cancelled`
- Any input form that accepts `details: { status: "serialization_error", ... }` or `serialized` wrappers — use a helper type if needed:

```typescript
type RequestHandlerAttemptDetailsInput<TDetails> = SchemaInvocationInput<...>;
// explicitly NOT RequestHandlerAttemptDetails<TDetails>
```

---

**Summary:** yes — model escalation input as the **writable projection of the attempt record**: same `code`/`message`/`type` discriminant, schema `details` as raw input, engine owns `attempt`, `manual`, and the `details` persistence union including `serialization_error`.

If you want to proceed to types, the one decision left is **nullable vs required `message` on `code: null`** for external escalation. I’d go required `message: string` there.

---

**User**

all right, seems like we've landed on the exact api shape. let's implement it.

---

**Cursor**

Implementing `escalateToManual` and removing `cancel`/`cancelled` across types, tests, docs, and client stubs.


Implemented the agreed operator API (types + tests + docs; runtime still stubbed).

### API

**`RequestHandleExternal`**
- `resolve(response)` — unchanged; aborts in-flight attempt, records response, unblocks workflow
- `escalateToManual(escalation)` — replaces `cancel`; aborts in-flight attempt, moves to `manual`, no workflow response

**`RequestManualEscalationInput<TErrors>`** — writable projection of attempt records:
- Untyped: `{ code: null, message: string, type: string | null }`
- Declared: `{ code, message }` or `{ code, message, details }` (schema input, not persisted `serialized` / `serialization_error`)

**`RequestEscalateToManualOutcome`**: `{ status: "manual" }` | `{ status: "already_terminal", current }`

### Removed
- `cancel()` / `RequestCancelOutcome`
- `cancelled` from `RequestStatus`
- `cancelledAt` from `RequestRow`
- `cancelled` from `RequestTerminalStatus` / retention context

### Updated
- `src/types/results.ts`, `handlers.ts`, `schema.ts`, `engine.ts`, `client.ts`
- `14_requests.ts` — escalation typing + handle usage
- `docs/primitives/requests.md`, `error-model.md`, `resolving-requests-asynchronously.md`, `refactor/14_requests.MD`

`pnpm typecheck` passes.

---

**User**

untyped requires explicit `code: null`? that seems bad. can we simply implicitly expect untyped error, but if the code is specified, expect the specific shape?

---

**Cursor**

Updating the escalation input type so untyped escalations omit `code`; declared codes require the typed shape.


Adding `code?: never` on the untyped branch so extra `code` properties don't structurally match.


Done. Untyped escalation is now message-only:

```typescript
// untyped
{ message: "Ops took over", type?: "AdminConsole" }

// declared
{ code: "NeedsHumanReview", message: "..." }
{ code: "RulesEngineRejected", message: "...", details: { ruleId: "R-42" } }
```

`code: null` is not part of the input API — the engine persists `code: null` on the attempt row for untyped escalations.

The untyped branch uses `code?: never` so `{ message, code: ... }` cannot structurally match the message-only branch (which was letting schema codes slip through without `details`). `pnpm typecheck` passes.

---

**User**

> Not in scope: compensation-instance retention (separate entity/status set) — can add the same pattern on registerRequestCompensationHandler later if you want parity there.

What did you mean by that? Don't we have compensation registration yet?

---

**Cursor**

Yes — **compensation registration is already there.** I was only talking about **retention**, not registration.

### What exists today

**`registerRequestCompensationHandler`** is implemented and typed:

- Declared on compensable `defineRequest` (`compensation: true | { result?, errors? }`)
- Registered separately from the forward handler (like the design doc says)
- Options: `retryPolicy`, `onExhausted`, `maxConcurrent`
- Handler gets compensation `ctx.errors` (manual-escalation surface)
- Covered in `08_compensation_model.ts` and `14_requests.ts`
- Exported from `workflow.ts` / `index.ts`

**Forward request registration** is the parallel path:

- `client.requests.<name>.registerHandler` (+ `retentionPolicy`, `onExhausted`, etc.)

So there are **two registrations** for a compensable request: forward handler on the client namespace, compensation handler via `registerRequestCompensationHandler`.

### What I meant by “compensation-instance retention”

Retention applies to **durable rows** when they reach a **terminal** state. Those rows differ:

| Entity | Registration | Terminal statuses (today) | `retentionPolicy` |
|--------|----------------|---------------------------|-------------------|
| **Forward request** | `client.requests.*.registerHandler` | `resolved`, `timedOut` | ✅ added |
| **Compensation instance** | `registerRequestCompensationHandler` | `completed`, `skipped` (and `manual` is non-terminal) | ❌ not added |

Compensation invocations are their own lightweight rows (`RequestCompensationStatus`, `RequestCompensationRow`, query/skip surface in types). When we added `retentionPolicy`, we only wired it for **forward** request finalization — not for “this compensation instance row is done, how long do we keep it?”

That’s the parity gap: same *pattern* could later go on `RequestCompensationHandlerOptions`, with a `RequestCompensationRetentionContext` (payload, compensation result, terminal status, attempts, etc.).

### Short version

- **Registration** — compensation: yes, already.
- **Retention on compensation rows** — not yet; I deferred it because it’s a separate entity/status set from forward requests.

If you want parity now, we can add `retentionPolicy` to `registerRequestCompensationHandler` in a follow-up.

---

**User**

Ok, what's the current state of the compensation handler registration? Does it also have the retries, the fallback to manual, the manual resolution and the escalateToManual?

---

**Cursor**

Here is the current state, split by **handler registration** vs **operator handle** — compensation is only half-aligned with forward requests.

## Registration (`registerRequestCompensationHandler`)

**Exists and is typed** (runtime is still a stub that validates and returns `noopUnsubscribe`).

| Capability | Compensation | Forward request |
|------------|--------------|-----------------|
| **Retries** | Yes — `retryPolicy` is **required** (`timeoutSeconds`, optional `maxAttempts`, `totalTimeoutSeconds`, …) | Yes — `retryPolicy` optional |
| **`onExhausted`** | Yes — `return` reports compensation outcome; **any throw** → `manual` | Yes — same manual-only throw surface |
| **`ctx.errors`** | Compensation block’s own `errors` map; factories have **no `{ manual }`** — any throw parks | Forward map; `{ manual: true \| false }` chooses park vs retry |
| **`retentionPolicy`** | No | Yes |
| **Where it registers** | `registerRequestCompensationHandler(def, …)` (module export) | `client.requests.<name>.registerHandler(…)` |

Handler context types:

```147:165:src/types/definitions/handlers.ts
/**
 * Request compensation handler context — uses the compensation block's own
 * `errors` map. `return` reports outcome; any `throw` moves to manual mode.
 */
export interface RequestCompensationHandlerContext<...> {
  readonly errors: RequestManualEscalationErrorFactories<TErrors>;
}

/**
 * Request compensation `onExhausted` context — same manual-only throw semantics
 * as {@link RequestOnExhaustedHandlerContext}.
 */
export interface RequestCompensationOnExhaustedHandlerContext<...> {
  readonly errors: RequestManualEscalationErrorFactories<TErrors>;
}
```

So: **retries yes**, **exhaustion → manual yes** (via `onExhausted` throw, same as forward). **No `{ manual }` flag** on compensation — intentional throws always park.

`08_compensation_model.ts` exercises retry + `onExhausted` + compensation `ctx.errors`.

---

## Operator surface (manual resolution)

This is where compensation **diverges** from forward requests.

**Forward request handle** (`client.requests.<name>.get(id)`):

- `resolve(response)` — typed forward response, unblocks workflow
- `escalateToManual(escalation)` — parks without response, aborts in-flight attempt

**Request compensation instance handle** (`workflowInstance.compensations.requests.<name>.findUnique(…)`):

```233:246:src/types/engine.ts
export interface RequestCompensationUniqueHandleExternal<...> {
  readonly id: RequestCompensationInstanceId;
  attempts(opts?: FetchOptions): Promise<FindUniqueResult<AttemptAccessor>>;
  skip(...args): Promise<SkipOutcome>;
}
```

| Operator action | Compensation instance | Forward request |
|-----------------|----------------------|-----------------|
| **Complete with typed outcome** | `skip(result)` (compensation **result** schema, or no-arg if `void`) | `resolve(response)` |
| **External escalate to manual** | **Not on the handle** | `escalateToManual(escalation)` |
| **Query manual rows** | Yes — `status: "manual"` on `RequestCompensationRow` | Yes — `status: "manual"` on request row |

So compensation **does** have a manual state (`RequestCompensationStatus` includes `manual`), but “manual resolution” today means:

1. Handler/`onExhausted` throw → row goes to `manual`, retries stop  
2. Operator finishes via **`skip(result)`** — not `resolve`, because there is no forward response to record  
3. **No `escalateToManual`** on the compensation handle — external “take over and park” only happens if you add that API (or something triggers the handler path)

---

## Summary

- **Retries + exhaustion fallback to manual**: yes on compensation registration, same spirit as forward.  
- **`resolve` / `escalateToManual`**: **forward only**. Compensation uses **`skip(result)`** instead of `resolve`, and has **no** `escalateToManual` yet.  
- **Runtime**: neither forward nor compensation handlers actually run; types/docs/regression only.

If you want parity, the open design question is whether compensation instances should get `escalateToManual` on `RequestCompensationUniqueHandleExternal` (with a compensation-scoped escalation input), or whether `skip` is intentionally the only operator verb besides re-running the handler after manual throws.

---

**User**

I mean I don't really find compensation vastly different from the request itself with the exception of it not returning its result into a workflow, but rather the result is supposed to serve as metadata of sorts. Other than that is there any reason we'd want to create a different api for request compensations?

---

**Cursor**

Checking how compensation `skip` differs from forward `resolve` in the type model.


Your instinct is mostly right: **request compensation is the same handler pattern as a forward request**, with a different **consumer** of the outcome.

## What is actually the same

- Separate handler registration with `retryPolicy`, optional `onExhausted`
- Handler `return` = success path
- `ctx.errors` on a **compensation-local** error map (manual-escalation surface — any throw parks)
- `manual` as non-terminal “automation stopped, operator must finish”
- Attempt log, abort in-flight work on operator action
- Queryable rows (`findUnique` / `findMany` on the compensation namespace)

The workflow doesn’t `await` the compensation result like a forward request; it becomes **metadata on the compensation instance** (`result` column, observable on the parent workflow). That’s the main product difference, not a reason for a totally different handler model.

## Where the API diverges today (and why)

The divergence is mostly **historical naming from step compensation blocks**, not a deep semantic need:

| | Forward request | Request compensation (today) |
|--|-----------------|------------------------------|
| Handler success | `return response` → `resolved` | `return result` → `completed` |
| Operator completes | `resolve(response)` → `resolved` | `skip(result)` → **`skipped`** |
| Operator parks | `escalateToManual(...)` → `manual` | **missing on handle** (only handler/`onExhausted` throw) |
| Caller timeout | `timedOut` on row | N/A (forward outcome is in `info`) |

So the odd one out is really **`skip` vs `resolve`**, plus **`completed` vs `skipped`** as two “success” terminals. That made sense for **step compensation blocks** (“operator abandoned `undo` but supplied a result”). For **request compensation**, it’s less obvious — you’re not skipping an `undo` body; you’re finishing the same kind of “external handler job” as a forward request.

## Is there a strong reason to keep a different operator API?

**Not really**, unless you explicitly want:

1. **Audit distinction** — “handler completed this” (`completed`) vs “operator asserted this without handler success” (`skipped`). If that matters, you can keep it as **status**, not as a different verb.
2. **Cross-primitive uniformity with step compensation** — one `skip(result)` everywhere on compensation *instances*. That’s consistency across compensation *kinds*, not across request forward vs request compensation.

Neither requires a separate *model*. They’re choices about **terminal status labels** and **method names**.

## What I’d align on (if you want parity)

**Handler registration** — same shape as forward (already close):

- `retryPolicy`, `onExhausted`, optional `retentionPolicy`
- Same error/escalation semantics on handler + exhaustion paths

**Operator handle** — mirror forward, different payload type:

- `resolve(result)` — record compensation `result`, terminal `completed` (or `resolved`-analogue)
- `escalateToManual(escalation)` — same `RequestManualEscalationInput` shape but typed against **compensation `errors`**

Optional: keep `skip(result)` as a **deprecated alias** for `resolve`, or reserve `skip` for “terminal without claiming handler success” if you still want `skipped` in the audit trail.

**Registration home** — `registerRequestCompensationHandler(def, …)` vs `client.requests.*.registerHandler` is organizational (global forward queue vs per-definition compensation worker). You could unify under client later; that’s ergonomics, not semantics.

## Bottom line

There isn’t a deep reason request compensation needs a **different** operator API — only:

- different **result schema** (`compensation.result` vs `response`)
- different **downstream effect** (metadata on compensation row, not workflow await)
- optional **status** choice (`completed` only vs `completed` + `skipped` for operator override)

If you’re fine with operator completion looking like handler completion in the audit log, **`resolve` + `escalateToManual` on `RequestCompensationUniqueHandleExternal`** is the coherent design and we can treat `skip` as step-compensation legacy unless you still want the `skipped` terminal for request compensation specifically.

Want to go ahead and unify compensation handles to `resolve` / `escalateToManual` (and decide whether operator completion is `completed` or `skipped`)?

---

**User**

maybe we could call the action `.skip` instead of `.resolve`. other than that it seems identical. what do you think? I really find no difference between a request and a compensation of a request other than the fact that `.resolve`ing a compensation isn't really a thing, since the result isn't being used anywhere, so it's rather a `.skip` with metadata attached. Other than that it seems the same, completely and utterly.

---

**Cursor**

I think that framing holds up. The meaningful split is **who consumes the outcome**, not the handler machinery.

**Forward request**
- Outcome **is** the workflow handoff → `resolve(response)` is the right verb.
- Park automation → `escalateToManual(...)`.
- Same row: retries, manual, call-time `timedOut`.

**Request compensation**
- Outcome is **instance metadata** (observable on the parent, not replayed into an `await`) → **`skip(result)`** is the right verb: “close this out and attach the compensation record.”
- Park automation → **`escalateToManual(...)`** (same escalation input shape, compensation `errors` map).
- Same machinery: retries, `onExhausted`, manual mode, attempt log, abort in-flight handler.

So the operator surface is symmetric except the completion verb:

| | Forward | Compensation |
|--|---------|--------------|
| Handler success | `return` → `resolved` | `return` → `completed` |
| Operator finish | `resolve(response)` | `skip(result)` |
| Operator park | `escalateToManual(...)` | `escalateToManual(...)` *(not on handle yet)* |

The only subtlety worth keeping explicit: **`completed` vs `skipped`** as terminal statuses. Handler `return` → `completed`; operator `skip(result)` → `skipped`. That’s audit (“handler did it” vs “operator asserted metadata”), not a different API model. If you ever don’t care about that distinction, you could collapse to one terminal status later — but you don’t need `resolve` on compensation either way.

What I would **not** do: add `resolve` on compensation handles. Your “skip with metadata” description matches the product reality and matches step-compensation vocabulary.

What’s **missing today** for “completely and utterly the same”:
1. **`escalateToManual` on `RequestCompensationUniqueHandleExternal`** (compensation-scoped escalation input).
2. **`retentionPolicy` on `registerRequestCompensationHandler`** (optional parity).
3. **Docs** stating compensation manual resolution as `skip` + `escalateToManual`, not a separate subsystem.

Registration can stay `registerRequestCompensationHandler(def, …)` vs `client.requests.*.registerHandler` — that’s just where the worker lives, not a semantic fork.

**Bottom line:** `skip` + `escalateToManual` on compensation, `resolve` + `escalateToManual` on forward — same pattern, two completion verbs reflecting “workflow payload” vs “metadata record.” I’d ship that unless you want to drop the `completed`/`skipped` audit split.

---

**User**

yeah, the retention though... however, it feel like retentionPolicy belongs on the request itself, not the compensation. compensation is inseparable from the request, so there seems to be no possible scenario where a compensation has a different retention policy from the request itself. what do you think?

---

**Cursor**

Your read matches how I'd model it.

Compensation isn't a separate product primitive — it's a **follow-on lifecycle for the same request definition**. Operators think in terms of `reserveFlightTicket`, not "forward retention vs compensation retention." If there's no scenario where you'd want compensation rows kept longer (or shorter) than the forward invocation they belong to, **`retentionPolicy` shouldn't live on `registerRequestCompensationHandler`**.

### One policy, two row types

Persistence still has **two rows** (forward invocation + compensation instance), but one registration policy can govern both:

- **`retentionPolicy` on the request side** — where we have it today: `client.requests.<name>.registerHandler(..., { retentionPolicy })` (or eventually on `defineRequest` if you move it there).
- When the **forward** row hits `resolved` / `timedOut`, run the policy → set `retention_deadline_at` on the request row.
- When the **compensation** row hits `completed` / `skipped`, run the **same** registered policy (maybe with a richer context: forward payload, compensation result, which terminal status, attempts) → set `retention_deadline_at` on the compensation row.

Same callback, same request name, no second registration knob.

### Why not on compensation registration

- Compensation handler is already a satellite of the definition (`compensation` block + separate `registerRequestCompensationHandler`). Retention is a **storage/GC** concern for the request *family*, not handler implementation detail.
- Avoids drift ("forward kept 7 days, compensation kept 90" by misconfiguration).
- Matches your mental model: compensation is the same thing, minus workflow `await`.

### One lifecycle edge case

Forward can be **`resolved`** while compensation is still **`running`** or **`manual`**. Retention needs a rule so you don't GC the forward row (or its correlation metadata) while compensation is still open. Reasonable options:

1. **Forward retention starts only when both are terminal** (if compensable), or  
2. **Compensation row carries the authoritative deadline** and forward row gets the same `retention_deadline_at` when compensation finishes, or  
3. **Forward retention is deferred** until compensation instance reaches a terminal status.

That's engine policy, not a second `retentionPolicy` registration — still one policy, possibly invoked once at the end of the combined lifecycle or twice with coordinated deadlines.

### Naming / operator API (consistent with earlier)

- Forward: `resolve` + `escalateToManual` + retention from request registration  
- Compensation: `skip(result)` + `escalateToManual` + **same** retention registration (no `retentionPolicy` on compensation handler)

### Bottom line

Yes — **retention belongs on the request, not on compensation registration.** Compensation finalization should call into the policy already registered for that request name (or defined on `defineRequest` if you consolidate there). I wouldn't add `retentionPolicy` to `RequestCompensationHandlerOptions` unless you later discover a genuine need to decouple GC — and you haven't found one.

If you want to implement next: add `escalateToManual` on the compensation handle, document `skip` + shared retention, and explicitly defer forward retention for compensable requests until the compensation story is closed (or document whichever coupling rule you pick).

---

**User**

all right. also the unification is a pressuring need here: `registerRequestCompensationHandler` was never supposed to exist, `client.requests.*.registerHandler` should be the only way.

with that in mind, let's proceed with the implementation.

---

**Cursor**

Unifying compensation registration into `client.requests.*.registerHandler` and adding `escalateToManual` on compensation handles. Exploring the current registration and client surfaces.


Implementing unified registration: updating types, then tests and docs.


Several type errors remain from the unification — I'll inspect the core type definitions and fix them systematically.


Fixing the core type issues first — missing imports and inference helpers are blocking compensation registration.


Compensation inference fails because `RequestCompensationConfig` with concrete schemas doesn't satisfy the default `RequestCompensationDefinition` — widening those constraints next.


Typecheck passes. Updating docs and adding the compensation handle `escalateToManual` introspection test.


Implementation is complete. `registerRequestCompensationHandler` is gone; compensation registers only through unified `client.requests.*.registerHandler`.

### Unified registration API

```typescript
client.requests.myRequest.registerHandler(forwardHandler, {
  retryPolicy: { ... },
  onExhausted?: { callback },
  retentionPolicy?: async (ctx) => number | null,  // forward + compensation rows
  compensation?: {                                  // compensable definitions only
    handler: async (payload, info, ctx) => result,
    retryPolicy: { timeoutSeconds, ... },           // required when handler is set
    onExhausted?: { callback },
    maxConcurrent?: number,
  },
});
```

### What changed

**Types**
- `RequestHandlerRegistrationOptions` includes optional `compensation` nested block
- Non-compensable requests get `compensation?: never`
- Fixed compensation inference (`InferRequestCompensationDef`, wider `RequestCompensationConfig` bounds) so concrete Zod schemas type-check
- `RequestCompensationUniqueHandleExternal` supports `escalateToManual` with compensation error typing

**Removed**
- `registerRequestCompensationHandler` from `workflow.ts` and exports
- `RequestCompensationHandlerOptions`

**Regression tests**
- `14_requests.ts` — merged compensation into main `registerHandler`; non-compensable `@ts-expect-error` on `compensation` block
- `08_compensation_model.ts` — uses `createWorkflowClient` + unified registration
- `12_introspection.ts` — compensation handle `escalateToManual` typing

**Docs**
- `docs/primitives/requests.md` — compensation section rewritten for unified registration, shared `retentionPolicy`, operator `skip` / `escalateToManual`
- `refactor/14_requests.MD` — updated checklist

`pnpm typecheck` passes.

Note: `refactor/08_compensation_model.MD` still references the old separate registration API — say if you want that aligned too.

---

**User**

a couple of questions:

1. `onExhausted?: { callback }` do we only have the callback in the object? Why the nest there?
2. `maxConcurrent?: number,` - why do we have it on compensation, but missing on the forward handler?

---

**Cursor**

Checking the type definitions and how similar options are shaped elsewhere in the codebase.


Good catches — both are worth unpacking against what's actually in the types today.

### 1. `onExhausted?: { callback }` — why the nest?

**Today it's mostly a structural placeholder.** Both forward and compensation use the same shape:

```234:241:src/types/definitions/handlers.ts
  readonly retryPolicy?: RequestHandlerRetryPolicy;
  readonly maxConcurrent?: number;
  readonly onExhausted?: {
    readonly callback: (
      payload: TPayload,
      opts: RequestOnExhaustedHandlerContext<TErrors>,
    ) => Promise<TResponse>;
  };
```

The nest made more sense when exhaustion was modeled as a **small options bag** rather than a bare function. An older refactor sketch for compensation even had `onExhausted?: { callback, retryPolicy }` — sibling fields under one exhaustion hook.

The current model is different: **`onExhausted` is terminal for retries** (`return` resolves / reports outcome; any `throw` → manual). So a nested `retryPolicy` under `onExhausted` would contradict that. What's left is only `callback`, which means the wrapper is arguably redundant *right now*.

**Reasons to keep the object:**
- Room for future exhaustion-only knobs without breaking call sites (e.g. `label`, `timeoutSeconds` for the callback itself, metrics hooks)
- Symmetry between forward and compensation exhaustion blocks

**Reasons to flatten it:**
- Less ceremony when there's only one field
- `onExhausted: async (payload, ctx) => { ... }` reads more naturally

So: not a hard requirement — it's inherited shape + extension headroom. If you prefer flat, that's a reasonable simplification.

---

### 2. `maxConcurrent` on compensation but not forward?

**Forward does have it** — same level as `retryPolicy` and `onExhausted`:

```234:235:src/types/definitions/handlers.ts
  readonly retryPolicy?: RequestHandlerRetryPolicy;
  readonly maxConcurrent?: number;
```

Compensation also has it inside the `compensation` block:

```207:208:src/types/definitions/handlers.ts
      readonly retryPolicy: RequestCompensationRetryOptions;
      readonly maxConcurrent?: number;
```

So the API is symmetric: each handler lane (forward vs compensation) can cap its own concurrency independently. That matches queues, where `maxConcurrent` sits on `QueueHandlerRegistrationOptions` too.

What *is* missing is **docs** — `docs/primitives/requests.md` never mentions `maxConcurrent` for requests, while `queues.md` does. That's a documentation gap, not a type asymmetry.

---

**Summary:** the `onExhausted` wrapper is debatable today (legacy/extension slot); `maxConcurrent` exists on both forward and compensation, docs just don't say so yet.

If you want to tighten the API, the two clean moves would be flatten `onExhausted` to a function, and document `maxConcurrent` on requests (or drop it from one side if you decide concurrency should only be forward-global). Happy to implement either direction.

---

**User**

I wonder whether the onExhausted is a good overall unit to use. Because if it throws a transient error, it is never re-executed. But it's hard to pinpoint what a transient error is. And it's hard to say that retryPolicy isn't required on the callback: we may wanna retry the transient errors. But which errors are transient? It's a tricky question that we've been trying to solve for every primitive handler so far. Any thoughts? No implementation yet.

---

**Cursor**

Reviewing how retries and exhaustion are modeled across primitives so the answer matches the codebase.


You're pointing at a real cross-primitive tension, not a small API wart.

## The core problem

Every handler eventually hits the same fork:

1. **Retry** — might succeed later (transient infra, rate limits, downstream blips)
2. **Stop with a terminal disposition** — dead-letter, manual, skip, resolve with a fallback, etc.

The hard part isn't syntax; it's **who decides** which branch applies for a given failure. Natalia has mostly answered that with **explicit disposition flags** (requests: `{ manual }`, queues: `{ deadLetter }`, topics: `UnrecoverableError` vs everything else). That pushes the "is this transient?" question to the author at the throw site.

`onExhausted` breaks that pattern. It's a **second execution lane** with different rules:

- Forward handler: throws can retry (`manual: false`) or park (`manual: true`)
- `onExhausted`: **no retries at all** — `return` resolves, any `throw` → manual

So if `onExhausted` does real IO (notify a queue, call a fallback API, write audit state), it faces the same transient failures as the main handler, but with **no retry loop and no `{ manual }` knob**. That's the mismatch you're feeling.

## What `onExhausted` is good for vs what people want from it

**Fits well when it's a disposition hook**, not a mini-handler:

- Inspect attempt history and decide: synthesize a response, or escalate to manual with a structured message
- Pure, fast logic with no flaky external calls
- "Retries are done; here's how we close the invocation without another handler attempt budget"

**Fits poorly when it's "phase 2 of the handler"**:

- Different code path that still talks to the same unreliable dependencies
- "Try the backup provider once" or "re-fetch with relaxed validation"
- Anything where you'd naturally want `retryPolicy` again

That second use case is really **more handler attempts with different branching**, not exhaustion semantics.

Topics got this separation cleaner: `onConsumeError` doesn't re-run the consumer — it returns `"skip" | "halt"` for an **already-finished** failure event. Queues avoid a separate callback entirely: exhaustion **is** dead-lettering, and operators can `retry()` from the dead-letter handle.

Requests sit in an awkward middle: `onExhausted` looks like a handler (can `return` a full response), but behaves like a terminal disposition path (one shot, throw → manual).

## Why "just add `retryPolicy` to `onExhausted`" doesn't cleanly solve it

You'd recreate the forward handler inside a nested object:

- Same `{ manual }` question on exhaustion throws — do we reintroduce `{ manual: false }` there?
- Same ambiguity about unhandled throws
- Two retry budgets to reason about ("did we exhaust the handler or the exhaustion callback?")
- Compensation `onExhausted` would need the same treatment → proliferation

You don't eliminate "what is transient?" — you **relocate** it to a smaller, weirder context with worse ergonomics.

There's also a product question: if exhaustion callbacks retry, when are attempts truly exhausted?

## A consistent framing across primitives

I'd think in three layers, not two:

| Layer | Question | Who answers |
|-------|----------|-------------|
| **Attempt loop** | Should this invocation of *this code* run again? | Disposition at throw site (`manual` / `deadLetter` / not `UnrecoverableError`) + `retryPolicy` |
| **Exhaustion** | Attempt budget is spent — what's the **final** outcome? | Disposition hook only — no IO retries |
| **Post-terminal ops** | Operator / async actor resolves later | `manual`, dead-letter retry, `resolve` on handle |

`onExhausted` belongs in the **exhaustion** row. The moment it needs its own retry policy, it's probably **attempt loop** work that was filed under the wrong layer.

## Practical guidance (without changing types)

**If exhaustion logic might hit transient errors:**

1. **Keep flaky work in the forward handler** — use `{ manual: false }` for retriable codes, branch on attempt count if you expose it (today forward `ctx` doesn't surface attempts, which nudges people toward `onExhausted` for attempt-aware logic — that's a design pressure worth noting).
2. **Escalate to manual early** — `manual: true` before the budget runs out, let an async actor / operator path do retried IO outside the handler loop.
3. **Use `onExhausted` only to decide** — return a synthetic response from cached attempt metadata, or throw to manual with "retries exhausted, needs human." No network calls.

**If you need a genuine second phase with its own retry budget**, that's semantically a **separate handler lane** (or just more main-handler attempts), not an exhaustion callback. Naming it `onExhausted` is what creates the confusion.

## Where this leaves `onExhausted` as a unit

Three viable directions to debate (still no implementation):

1. **Narrow it** — document and type it as a **terminal disposition callback** (topics-shaped: return resolve | throw manual; discourage IO). Maybe rename toward `onAttemptsExhausted` / `resolveOnExhaustion` to signal "not a retried handler."

2. **Remove it** — exhaustion auto-parks to manual with full attempt history; operators/async listeners resolve (you already have the waitlist pattern). Queues-style: terminal state + external retry surface.

3. **Unify into one handler** — expose attempt number (or `ctx.attempts`) on forward handler context so "late-phase logic" lives in one function with one retry policy and explicit `{ manual }` per throw. `onExhausted` becomes unnecessary for most cases.

My lean: **(1) or (3), not nested retry on `onExhausted`**. The disposition-flag model works when there's a single retried loop. Adding a second loop under exhaustion fights the model you've built for queues and forward requests.

Compensation handlers have the same shape — any throw → manual, no `{ manual: false }` — so whatever you decide for request `onExhausted` should apply there too for consistency.

Happy to go deeper on any of the three directions, or compare how attempt exposure on forward `ctx` would change the waitlist / rules-engine examples in `requests.md`.

---

**User**

I feel like onExhausted should go. It seems like we wanna default to manual onExhausted and that'll be it. What do you think?

---

**Cursor**

Checking what the codebase specifies when retries exhaust without a callback.


I agree — for requests, **`onExhausted` should go**, and **exhaustion → `manual`** is the right default.

## Why it fits requests

Requests already treat `manual` as the non-terminal "needs external completion" state. That matches what most `onExhausted` callbacks do today: throw (often with a nicer message) to land in manual anyway. The doc example is literally that — notify, then throw to manual.

So the callback is mostly **ceremony** around a default the engine could apply:

> Retries exhausted → `status: manual`, persist attempt history, stop claiming.

That gives you one retried lane (forward handler + `{ manual }`) and one post-exhaustion outcome (manual). No third execution context with different throw semantics and no retries.

It also matches the direction from the last discussion: exhaustion is a **disposition**, not a mini-handler. Queues dead-letter on exhaust; requests park in manual. Both are "stop retrying, surface to ops/async resolution."

## What you lose (and how small it is)

The only real capability `onExhausted` adds beyond default-manual is **`return` → auto-resolve on exhaustion** — e.g. after N failures, synthesize `{ decision: "reject", note: "auto-rejected after retries" }` without human involvement.

That's valid, but it's a **business outcome**, not an exhaustion hook. It belongs in:

- the forward handler (branch on attempt count, if you expose attempts on `ctx`), or
- `throw ctx.errors.X(..., { manual: true })` early when you already know you want external/async resolution, or
- an event listener / operator path resolving waiting `manual` rows (the waitlist pattern you already document)

If you can't do IO reliably in `onExhausted`, you probably shouldn't rely on it for automated fallback resolution either.

## Default manual — what to nail down

The design detail worth specifying (types/docs, not necessarily new API):

**What metadata does exhaustion-manual carry?**

I'd lean toward:

- `status: manual`
- Escalation derived from **last failed attempt** (`code`, `message`, `details`, `manual: false` history)
- Optional engine-level marker so operators can distinguish "handler chose manual" vs "retries exhausted" (e.g. `type: "attempts_exhausted"` or similar on the manual row)

That way `findMany(({ status }) => eq(status, "manual"))` still works, and operators see *why* it's waiting without a custom callback.

## Apply consistently

If forward `onExhausted` goes, **compensation `onExhausted` should go too** — same problem, same fix: compensation handler exhausts → compensation block → manual, with attempt history attached.

## Compared to other primitives

| Primitive | On exhaust |
|-----------|------------|
| Queues | Dead-letter (`max_attempts`) — terminal, operator can `retry()` |
| Topics | Consumer policy (`onConsumeError`) — offset decision, not re-run |
| Requests | **Manual** — non-terminal, `resolve` / `escalateToManual` on handle |

Requests don't need a topics-style policy callback *and* a handler exhaustion callback. Manual **is** the policy: "stop retrying, leave the invocation open for external completion."

## Bottom line

Removing `onExhausted` simplifies the model, removes the transient-retry ambiguity, and aligns with how the primitive is actually used. Default exhaustion → manual is coherent; document what gets persisted on that transition and drop the nested `{ callback }` shape.

The one thing to decide before implementation: whether you need a first-class way to **auto-resolve without manual** on exhaustion. If yes, expose attempt count on forward `ctx` rather than bringing back `onExhausted`. If no, exhaustion → manual is enough.

I'd proceed with removal unless you have a concrete case for resolve-on-exhaust that can't live in the forward handler or an async manual resolver.

---

**User**

let's remove it. it doesn't have a compelling use case.

---

**Cursor**

Removing `onExhausted` from types, tests, and docs. Searching the codebase for all references.


Applying the changes across types, tests, and docs.


`onExhausted` is removed. Exhaustion now defaults to **`manual`** with persisted attempt history.

### Types
- Removed `onExhausted` from `RequestHandlerRegistrationOptions` and `RequestCompensationRegistrationOptions`
- Removed `RequestOnExhaustedHandlerContext` and `RequestCompensationOnExhaustedHandlerContext`
- Updated `RequestManualEscalationErrorFactories` comment (compensation handlers only)

### Tests
- `14_requests.ts` — dropped exhaustion callback section and shape assert field
- `08_compensation_model.ts` — removed compensation `onExhausted` block

### Docs
- `docs/primitives/requests.md` — exhaustion → manual; updated compensation example and reference table
- `docs/error-model.md`, `docs/resolving-requests-asynchronously.md`
- `refactor/14_requests.MD`, `REFACTOR.MD`

`pnpm typecheck` passes.

**New rule (documented, runtime still stubbed):** forward handler retry budget exhausted → `status: manual`; compensation handler retry budget exhausted → compensation block → `manual`. No third callback lane.

Note: `refactor/03_call_time_options.MD` and `refactor/08_compensation_model.MD` still mention the old API — say if you want those aligned too.

---

**User**

align the docs as well

---

**Cursor**

Updating the remaining stale refactor docs and fixing the error-model wording.


All aligned. Updates:

**`refactor/03_call_time_options.MD`** — deferred step 14 now lists retry policy, `{ manual }`, exhaustion → `manual`, and `retentionPolicy` (no `onExhausted` / `MANUAL`).

**`refactor/08_compensation_model.MD`** — rewritten request compensation section:
- Unified `client.requests.*.registerHandler(..., { compensation: ... })`
- Removed `registerRequestCompensationHandler` and `onExhausted`
- Updated acceptance contract (items 8–11) for throw → manual and exhaustion → manual

**`docs/error-model.md`** — handlers intro no longer mentions "exhaustion callbacks."

**`docs/primitives/requests.md`** — tightened exhaustion → manual wording (removed negative "no separate callback" phrasing per doc style).

No remaining `onExhausted`, `registerRequestCompensationHandler`, or "exhaustion callback" references in the repo.

---

**User**

the requests.md doesn't seem to have any mention of a  request compensation. let's add it.

---

**Cursor**

Expanding the Compensation section with declaration, handler semantics, operator actions, and a reference subsection—the current section is too thin.


Expanded **Request compensation** in `docs/primitives/requests.md` — renamed from the brief “Compensation” blurb and built out as its own section. It now covers:

1. **When it runs** — workflow failure → compensation blocks for compensable request invocations  
2. **Declaration** — `compensation: true` vs `{ result?, errors? }`, separate error maps  
3. **Registration** — unified `registerHandler` with required `compensation.retryPolicy`, `maxConcurrent`, shared `retentionPolicy`  
4. **`info` shape** — branching on `completed` / `timed_out` / `terminated` with `attempts`  
5. **Handler outcomes table** — return, throw, retry exhaustion  
6. **Operator actions** — `compensations.requests.<slot>`, `skip`, `escalateToManual`  
7. **Reference** — compensation lifecycle status table + note on step dependency rules  

Also links to [step compensation](./steps.md) for readers coming from that side.

---

**User**

@docs/primitives/requests.md:238 in case of the handler, I'm looking at `info, ctx` and not finding a justification as to why we've decided to keep `info` as a separate entity from the context. Let's explore the possibility of unifying them as a single context entity. Obviously, the `payload` can go there as well, but it's really common for the handler to use `payload`, but never even touch the `context`. But let's explore.

---

**Cursor**

Reviewing how compensation and forward handlers structure `payload`, `info`, and `ctx` across primitives.


The split made more sense for **step** `undo` than it does for **request** compensation handlers. Here’s a concise read of why it exists today and what unification could look like.

## Why `info` is separate today

It’s inherited from **step compensation**, not invented for requests:

```200:212:src/types/definitions/steps.ts
  readonly undo: (
    ctx: CompensationContext<...>,  // rich: steps, requests, channels, signal, …
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
    info: CompensationInfo<...>,    // read-only forward outcome snapshot
  ) => Promise<...>;
```

There, `ctx` is the **execution environment** (dependencies you can call). `args` and `info` are **inputs describing this undo**: original call args + how the forward step ended. Three different roles.

Request compensation collapsed that into a **thin client handler**:

```182:186:src/types/definitions/handlers.ts
      readonly handler: (
        payload: TPayload,
        info: RequestCompensationInfo<TForwardResponse>,
        opts: RequestCompensationHandlerContext<TCompensationErrors>,
      ) => Promise<...>;
```

`opts`/`ctx` is only `signal` + `errors` — no `ctx.steps`, no primitives. So you get three parameters where two of them (`payload`, `info`) are really **read-only inputs**, and one (`ctx`) is **runtime capability**. That’s the awkward part: `info` isn’t “context” in the step sense, but it isn’t “the message” either. It’s forward-outcome metadata that most handlers need alongside `payload`.

## How other handlers do it

| Handler | Shape | Pattern |
|--------|--------|---------|
| Forward request | `(payload, ctx)` | Domain input first, capabilities second |
| Queue | `(message, ctx)` | Same |
| Topic | `(record, { signal })` | Same (minimal ctx) |
| Request compensation | `(payload, info, ctx)` | **Extra middle arg** |

Forward and queue handlers already treat “the thing you’re acting on” as positional and “how you act” as `ctx`. Compensation is the outlier with a second input bag (`info`).

## Unification options

### A. Merge `info` into `ctx`, keep `payload` positional (my lean)

```typescript
compensation: {
  handler: async (payload, ctx) => {
    if (ctx.forward.status === "completed") {
      await release(ctx.forward.response.reservationId, { signal: ctx.signal });
    }
    throw ctx.errors.ReleaseBlocked("Cannot release");
  },
  retryPolicy: { timeoutSeconds: 30 },
},
```

```typescript
interface RequestCompensationHandlerContext<TErrors, TPayload, TForwardResponse> {
  readonly signal: AbortSignal;
  readonly errors: RequestManualEscalationErrorFactories<TErrors>;
  readonly forward: RequestCompensationInfo<TForwardResponse>;
  // optional later: readonly payload: TPayload  — see below
}
```

**Pros**

- Same arity as forward handler: `(payload, ctx)`.
- `info` sits next to `signal`/`errors` — all “engine-provided,” not “the business record.”
- Narrowing stays clean: `if (ctx.forward.status === "completed")` → `ctx.forward.response`.
- Simple handlers that only use `payload` stay one-liners; they ignore `ctx.forward` entirely (same as ignoring `ctx.signal` today).

**Cons**

- Slightly more nesting when you only touch forward outcome (`ctx.forward` vs `info`).

Naming: `forward` reads better than `info` on the context object.

---

### B. Single `ctx` with `payload` inside

```typescript
handler: async (ctx) => {
  const { payload, forward, signal, errors } = ctx;
}
```

**Pros**

- One parameter; easy to extend (`ctx.attempts`, block id, etc.).
- Mirrors retention callbacks (`RequestRetentionContext` is already a status-discriminated ctx with payload + attempts).

**Cons**

- Every handler pays `ctx.payload` for the common case.
- Breaks the queue/topic/forward convention unless you change all handlers for symmetry.

---

### C. Domain bundle + runtime ctx

```typescript
handler: async (input, ctx) => {
  const { payload, forward } = input;
}
```

**Pros**

- Clear split: `input` = immutable facts, `ctx` = capabilities.

**Cons**

- Still two bags to learn; worse ergonomics than A for the common “use payload, branch on status” case.

---

### D. Keep three parameters

Only justified if you expect request compensation `ctx` to grow into a **rich** environment (like step `CompensationContext`). Right now it doesn’t, and client-side handlers likely never will — they don’t replay inside the workflow.

## Payload: positional vs on `ctx`

Your instinct matches usage:

- **Forward**: `(payload, ctx)` — payload is the star; many handlers never touch `ctx` except `signal`.
- **Compensation**: same — you almost always need `payload` + forward outcome; `ctx` is often just `signal` + maybe `errors`.

So I’d **keep `payload` positional** and merge only `info` → `ctx.forward`. Putting `payload` on `ctx` as well is consistent with B but hurts the common path unless you also change forward handlers (bigger break, weaker win).

If you later add `ctx.attempt` on the **forward** handler for in-handler exhaustion branching, compensation could expose `ctx.forward.attempts` (already on `info`) — one place for “what the engine knows about this invocation.”

## Step compensation: change or not?

I would **not** unify step `undo` the same way. There, `ctx` is genuinely different from `info` (live dependency surface vs forward snapshot). Request compensation is a **client handler**; unifying there doesn’t oblige you to change step `undo`.

## Recommendation

**Merge `RequestCompensationInfo` into `RequestCompensationHandlerContext` as `forward` (or `outcome`), signature `(payload, ctx)`.**

- Aligns request forward + compensation registration ergonomics.
- Drops the unjustified third parameter.
- Rename type param `opts` → `ctx` in types while you’re there.

If you want to go further later, a single `(ctx)` with `ctx.payload` is viable but I’d treat that as a cross-primitive handler-shape change (requests + queues + topics), not compensation-only.

If this direction sounds right, next step is a small type + regression + docs pass — no runtime behavior change, just the handler surface.

---

**User**

ok, we may really wanna follow the same pattern everywhere, same as the main pattern: the workflow execute function. I think this should be the reference point. If I remember correctly, it's `ctx, args`- honestly, it seems like the best option out there. In case of a compensation, `args` are a part of the context. I wonder, whether we shouldn't simply make args a part of the context as well to get rid of this inconsistency across the board. It costs us `{ args }` instead of `ctx, args`, which is 100% better when considering the alternative of sometimes omitting args as the second argument or using it as a part of the context object for some non-apparent reason. What do you think?

---

**Cursor**

Checking how `execute` and handlers are shaped across the codebase to give a grounded opinion.


You're pointing at a real inconsistency. Worth separating **what the reference actually is today** from **where you're proposing to go**.

## What "workflow execute" is today

The typed contract is **`(ctx, args)`**, not args-on-ctx:

```168:184:src/types/definitions/workflow-definition.ts
  execute(
    ctx: WorkflowContext<...>,
    args: StandardSchemaV1.InferOutput<TArgs>,
  ): Promise<StandardSchemaV1.InferInput<TResultSchema>>;
```

So if workflow execute is the north star **literally**, the unification target is **`ctx` first, domain input second** — not single-parameter `(ctx)`.

But the codebase already diverges:

| Surface | Today |
|--------|--------|
| Workflow `execute` | `(ctx, args)` |
| Step `execute` | `(args, { signal })` — **args first**, no real ctx |
| Request / queue handler | `(payload/message, ctx)` — **domain first** |
| Topic consumer | `(record, { signal })` |
| Step `undo` | `(ctx, args, info)` |
| Request compensation | `(payload, info, ctx)` |

There isn't one pattern; there are three orderings and two arity models. Your discomfort with `info` as a third bag is a symptom of that.

## Your proposal: single `(ctx)`, domain input on the object

Something like:

```typescript
// workflow
async execute(ctx) {
  const { orderId } = ctx.args;
}

// request handler
async (ctx) => {
  await process(ctx.payload, { signal: ctx.signal });
}

// request compensation
async (ctx) => {
  if (ctx.forward.status === "completed") {
    await release(ctx.forward.response.reservationId, { signal: ctx.signal });
  }
}

// step undo
async undo(ctx) {
  const { chargeId } = ctx.args;
  if (ctx.forward.status === "completed") { ... }
}
```

I think this is **stronger** than standardizing on `(ctx, args)` everywhere, for a few reasons:

**1. One arity rule**

Every callback is `(ctx) =>`. No "sometimes second param, sometimes nested, sometimes three params." Compensation's `info` becomes `ctx.forward` (or `ctx.outcome`) — same slot step `undo` would use. That directly fixes the problem you raised at line 238.

**2. You already do this for some callbacks**

`retentionPolicy` is ctx-only with `payload`, `status`, `response`, `attempts` inside. Compensation and retention are "engine invokes your code with a snapshot" — same shape family as handlers. Putting `payload` + forward outcome on one ctx object is consistent with that.

**3. Extensibility without signature churn**

Adding `ctx.attempt`, block id, trace fields, etc. doesn't change arity. With `(payload, ctx)` or `(ctx, args, info)` every addition fights the signature.

**4. Destructuring cost is small**

`async ({ payload, signal, errors }) =>` is not worse than `(payload, ctx)` for the common case. For handlers that only touch domain input, `async ({ payload }) =>` is fine.

## vs `(ctx, args)` everywhere

Aligning handlers to **`(ctx, args)`** like workflow execute would fix **order** (ctx first) but not **arity**:

- Request compensation still wants forward outcome somewhere → `ctx.forward` anyway, or back to a third param.
- Step `undo` still wants `(ctx, args, info)` unless `info` moves onto ctx.
- Step `execute` still isn't really a `WorkflowContext` — it's `{ signal }`. You'd have `(ctx, args)` where `ctx` is tiny, which feels like ceremony without benefit.

So **`(ctx, args)` everywhere is a half-step**. Single `(ctx)` with typed fields is the full step and matches "compensation args are part of context."

## Naming: one field or domain-specific?

I'd **not** force `ctx.args` on requests when the definition says `payload`, or `ctx.args` on queues when it's `message`. Use **domain names on a handler-specific ctx type**:

| Handler | Domain field |
|---------|----------------|
| Workflow / step execute / step undo | `ctx.args` |
| Request forward / compensation | `ctx.payload` |
| Queue | `ctx.message` |
| Topic | `ctx.record` / `ctx.records` |

Same rule (**one parameter, input lives on ctx**), but names match the primitive. A universal `ctx.input` reads generic and fights the schema vocabulary.

Forward outcome on compensation (step + request): **`ctx.forward`** — parallel to today's `info`, but clearly "read-only snapshot of forward settlement," not execution environment.

## What I'd push back on slightly

**Workflow `execute` is the one place `(ctx, args)` is deeply established** — docs, every example, mental model of "body receives args." Moving to `ctx.args` is a **large** break for arguably the most-written callback in the system.

Two reasonable tiers:

1. **Handlers + undo only** → `(ctx)` with payload/args/message on ctx; leave workflow `execute` as `(ctx, args)` until a later pass.
2. **Everything including workflow** → true single pattern; bigger migration, cleaner long-term story.

I'd lean tier 1 first unless you're ready for a repo-wide signature migration. Philosophically though, **yes** — if the goal is one rule, tier 2 is the honest end state.

**Step `execute`** is the other odd one: it's a worker stub, not a workflow body. `(ctx)` with `{ args, signal }` (and maybe `errors` later) is fine; it doesn't need `WorkflowContext`.

## Recommendation

**Agree with the direction: single `(ctx)`, domain input on ctx, forward outcome as `ctx.forward` for compensation.**

That gives you:

- Request compensation: `(ctx)` with `payload`, `forward`, `signal`, `errors`
- Step undo: `(ctx)` with `args`, `forward`, plus existing rich compensation `ctx`
- Request/queue/topic handlers: `(ctx)` with `payload`/`message`/`record`
- Optionally later: workflow `execute(ctx)` with `ctx.args`

It's better than `(ctx, args)` everywhere because it absorbs `info` without a third parameter and matches retention-style callbacks you already have.

The alternative — keep positional domain input because "handlers use payload more than ctx" — optimizes for arity-1 ergonomics in one primitive at the cost of permanent **"where does forward outcome live?"** ambiguity. Putting rarely-used fields on ctx is cheap; putting sometimes-second-arg-sometimes-on-ctx is expensive forever.

If you want to proceed, I'd spec the ctx types per surface (`RequestCompensationHandlerContext` gains `payload` + `forward`), do request compensation first (smallest surface), then request/queue handlers, then step undo, then workflow execute last if you want full uniformity.

---

**User**

I think the refactor, even though is hefty, can be done in a sweep and for every primitive and callback there is. However, I wonder, whether it'd be worth to split the refactor into subtasks that refactor every callback type separately. Seems like a better choice overall. What do you think?

---

**Cursor**

I’d split it — not because the change is too big for one sweep mechanically, but because **callback families have different ctx shapes, different docs, and different regression files**. Per-type subtasks give you reviewable PRs, clear acceptance criteria, and a place to settle naming (`ctx.payload` vs `ctx.args`, `ctx.forward`, etc.) once before copying the pattern everywhere.

A single mega-PR is possible if everything is still types + regression tests + docs (no runtime yet), but it becomes hard to review, easy to miss one signature, and painful when one primitive needs a slightly different field name.

## Why per-callback subtasks fit this repo

You already organize work that way: `14_requests.ts`, `13_queues.ts`, `08_compensation_model.ts`, `refactor/14_requests.MD`, etc. Each subtask can be **“one callback surface + its ctx type + its regression file + its doc section”** — same shape as the request work you’ve been doing.

Also, the unification isn’t one mechanical rename. Each surface has different fields:

| Callback | Domain on ctx | Extra on ctx |
|----------|---------------|--------------|
| Workflow `execute` | `args` | full `WorkflowContext` |
| Step `execute` | `args` | `signal` (minimal) |
| Step `undo` | `args` | `forward` + rich compensation ctx |
| Request forward handler | `payload` | `signal`, `errors` |
| Request compensation handler | `payload` | `forward`, `signal`, `errors` |
| Queue handler | `message` | `signal`, `errors` |
| Topic consumer | `record` / `records` | `signal` |
| Retention policies | already ctx-only | align naming only |

Splitting lets you nail **one row** of that table, merge it, then replicate the pattern.

## Suggested subtasks (order matters a bit)

**0. Meta / convention doc (small, first)**  
One short internal note (could be a `refactor/XX_handler_context.MD` or a section in error-model):  
- Rule: every callback is `(ctx) =>`  
- Domain field names per primitive  
- Forward outcome: `ctx.forward`  
- No second positional domain arg  

Everything else references this so you don’t re-debate in each PR.

**1. Request compensation handler** (smallest net-new design)  
`(payload, info, ctx)` → `(ctx)` with `ctx.payload`, `ctx.forward`. Touches `handlers.ts`, `14_requests.ts`, `08_compensation_model.ts`, compensation section of `requests.md`. Good pilot — you were just discussing this.

**2. Request forward handler**  
`(payload, ctx)` → `(ctx)` with `ctx.payload`. Same files, mostly. Establishes handler pattern for client registration.

**3. Queue handler**  
`(message, ctx)` → `(ctx)` with `ctx.message`. `13_queues.ts`, `queues.md`.

**4. Step `execute`**  
`(args, { signal })` → `(ctx)` with `ctx.args`, `ctx.signal`. Steps docs + step regression files. Inverts order from today — worth its own PR.

**5. Step `undo`**  
`(ctx, args, info)` → `(ctx)` with `ctx.args`, `ctx.forward` on existing `CompensationContext` (or a narrowed undo ctx). `08_compensation_model.ts`, `steps.md`. Depends on naming from (0) and (1).

**6. Topic consumer(s)**  
`(record, { signal })` / batch variant → `(ctx)`. Topics docs + any regression tests.

**7. Workflow `execute`**  
`(ctx, args)` → `(ctx)` with `ctx.args`. Largest blast radius in examples and every workflow regression file — do last so handler/undo patterns are settled and docs stay consistent.

**8. Stragglers / alignment pass**  
- Retention policies (`RequestRetentionContext` already has `payload` — verify naming)  
- `onExhausted`-style callbacks if any remain  
- `defineRequest` transitional `registerHandler` on definition object  
- Topic batch, external workflow handlers if they exist  
- Grep for `(args,`, `(payload,`, `{ signal }` second-param patterns  
- `REFACTOR.MD` banner sections  

## What not to split too finely

Don’t do “rename `info` → `forward`” as a separate task from “merge into ctx” for the same handler — that’s one semantic change. Do **one PR per callback kind**, not one PR per field.

## Single sweep vs split — tradeoff

| | Per-type subtasks | One sweep |
|--|-------------------|-----------|
| Review | Easy | Hard |
| Consistency | Risk of drift between PRs unless (0) exists | Uniform |
| Typecheck | Green after each merge | Green once at end |
| Docs | Incremental | Big bang |
| Rollback | Revert one surface | Revert everything |

Given you’re still in **types + regression + docs** land, split is clearly better. If runtime stubs existed per handler, I’d still split but keep a **compat shim** only if needed — you probably don’t need shims for type-only work.

## Practical recommendation

**Yes — split by callback type, with a tiny “convention” task first and workflow `execute` last.**

Rough size: 7–8 focused PRs, each touching 2–5 files, each ending with `pnpm typecheck`. Request compensation → forward → queue → step execute → step undo → topics → workflow execute → grep cleanup.

If you want, next step could be drafting the convention doc + the exact `RequestCompensationHandlerContext` shape for subtask 1 so the rest copy paste the same pattern.

---

**User**

before we create task descriptions, are there any questions we should resolve before we move on to the refactor?

---

**Cursor**

Scanning callback surfaces across the codebase to surface open design questions before we write task descriptions.


Yes — a handful of decisions are worth locking before writing task descriptions. Grouped by “must decide” vs “can decide in task 0” vs “explicitly out of scope.”

## Must decide first (blocks task specs)

### 1. Scope: what counts as a “callback”?

Not everything is a handler with domain input:

| Surface | Today | Question |
|--------|--------|----------|
| Workflow `execute` | `(ctx, args)` | In scope → `ctx.args`? |
| Step `execute` | `(args, { signal })` | In scope |
| Step `undo` | `(ctx, args, info)` | In scope → `ctx.args`, `ctx.forward`? |
| Request / queue handlers | `(payload/message, ctx)` | In scope |
| Request compensation | `(payload, info, ctx)` | In scope |
| Topic consumer | `(record, opts)` | In scope |
| Topic batch consumer | `(records, opts)` | In scope |
| Topic `onConsumeError` | `(_ctx, event)` in regression tests | **Policy callback** — unify to `(ctx)` with `ctx.event`? |
| `ctx.scope(..., callback)` | `(ctx, handles)` | **Orchestration** — second arg is handles, not domain input. Change to `ctx.handles` or leave as two-param? |
| Retention policies | already `(ctx)` | Naming alignment only? |
| `idempotencyKeyFactory` | `(args) => string` | Factory, not handler — `(args)` vs `(ctx)` with `ctx.args`? |

Recommendation: **decide explicitly** whether scope / onConsumeError / factories are in the same refactor or a follow-up. Task descriptions get messy if this stays fuzzy.

### 2. Forward-outcome naming and shape

For step `undo` and request compensation:

- **`forward` vs `info` vs `outcome`** on ctx?
- Step completed branch uses **`result`**; request uses **`response`**. Keep those names inside `ctx.forward`, or normalize (e.g. always `response`)?

This affects every compensation task and docs.

### 3. Domain field names on ctx

Proposed: primitive-specific names on typed ctx (`ctx.args`, `ctx.payload`, `ctx.message`, `ctx.record`, `ctx.records` for batch).

Confirm that’s final — not a universal `ctx.input` or always `ctx.args`.

### 4. Workflows / steps without args

Many tests use `async execute(ctx)` with no args schema. After unification:

- Is `ctx.args` **`void`** / omitted from type when no schema?
- Or always present (possibly `undefined`)?

Same for step `execute` and `idempotencyKeyFactory`.

### 5. Context type naming / hierarchy

Today:

- `HandlerContext` = `{ signal }`
- `RequestHandlerContext` = + `errors`
- `CompensationContext` = rich workflow-like surface (step undo)
- `RequestCompensationHandlerContext` = thin handler surface

After merge:

- Does request compensation extend a shared **`HandlerContext`** with `payload`, `forward`, `signal`, `errors`?
- Do we rename to avoid “CompensationContext” (step undo) vs “RequestCompensationHandlerContext” (client handler) confusion?

Worth one naming table in the convention doc.

### 6. Topics: what’s actually being refactored?

Types are split:

- `TopicDefinition.registerConsumer(record, opts)` — stub on definition
- `client.registerTopicConsumer` — documented + regression in `refactor/15_topics.ts`, not necessarily in main `src/types/engine.ts`

Decide whether topic tasks target **regression + docs only**, or **wire client types into `engine.ts` first**, then unify signatures.

---

## Should decide in task 0 (convention doc), can iterate slightly

### 7. Batch topic handler

If unified: `ctx.records` (non-empty readonly array) + `ctx.signal` on same ctx type?

### 8. Retention policies

Already ctx-only with `payload` / `message` inside. Task = verify names match handler ctx, or leave as-is (terminal snapshot ≠ handler ctx)?

### 9. Transitional APIs

`defineRequest.registerHandler` on the definition object — **same signature as client** after refactor? (I'd say yes.)

### 10. Future fields on handler ctx

Do tasks **reserve** slots now (e.g. `ctx.attempts` on forward request handler for in-handler branching), or strictly move existing fields only?

I'd default **existing fields only** unless you want attempt access in the same sweep.

---

## Explicitly out of scope (don’t block tasks, but note)

- **`MANUAL` return value** — `refactor/17_handler_early_termination.MD` still describes it; current model is throw-based. Separate from ctx refactor; don’t mix into handler-context tasks.
- **`RetentionSetter`** — object map, not a callback.
- **Runtime / stubs** — types + regression + docs only unless you say otherwise.

---

## Suggested pre-task checklist (short)

1. **Inventory sign-off** — list every in-scope callback; mark scope / onConsumeError / factories in or out.  
2. **Convention doc** — one param `(ctx)`; domain field names; `ctx.forward` shape; void-args rules.  
3. **Topic scope** — regression-only vs engine types.  
4. **Scope callbacks** — in or out of v1.  
5. **Subtask order** — you already lean compensation → forward handlers → queue → step execute → step undo → topics → workflow execute last.

---

## My take

The **blockers** before task descriptions are really **#1 (inventory)**, **#2 (`forward` + result/response)**, **#3 (domain names)**, **#4 (void args)**, and **#6 (topics surface)**. The rest can live in task 0’s convention doc.

If you want to move fast: I’d propose defaults — `(ctx)` everywhere handlers run; **`ctx.forward`** with **status-specific fields unchanged** (`result` vs `response`); **scope stays `(ctx, handles)`** for v1; **onConsumeError → `(ctx)` with `ctx.event`**; **factories stay `(args)`** until a dedicated pass; **topics task = regression + docs + engine stubs when they exist**.

Want to nail those five blockers in this thread, or should I draft the convention doc with those defaults for you to edit?

---

**User**

> Scope: what counts as a “callback”?

Let's simply say that everything accepts a `ctx` object. This allows to escape the ambiguity: you know that every callback accepts a single `ctx` object that has a set of attirbutes you need to handle the event.

idempotencyKeyFactory is not a handler: it's a factory function that accepts a set of arguments. So there is no point in refactoring such callbacks.

`(ctx, handles)` in `scope` callback looks very tempting to leave as is, but we unify anyway - same as the `(ctx, args)` in workflow execute.

> Forward-outcome naming and shape

I don't think we should normalize every context object to have an expected form. I think we should accept that every context is different and encourage to explore context objects to understand what they provide, instead of relying on a forcefully unified api.

> Domain field names on ctx

Yes, the previous answer actually addresses this as well.

> Workflows / steps without args

Omitted. Key presence with undefined set isn't the same as key absence.

> Context type naming / hierarchy

We don't need to keep any type hierarchies intact, unless they really represent a shared type surface. Type hierarchies should only be built if and only if they aid when refactoring code (changing shape, types, fields, etc.). If types are truly independent, we shouldn't force a hierarchy.

> Topics: what’s actually being refactored?

We have to dive in on the topic of topics. I need more info on what's conflicting with the new model before I make a decision.

> Batch topic handler

Yes, we join all the args to a single context

> Retention policies

What do you mean?

> Transitional APIs

defineRequest.registerHandler shouldn't exist. If we have this "transitional api" it should be removed. There should be no "transitional api" anywhere: we're not keeping any backwards compat, since we're in the phase of active public api development, we don't even have a runtime yet.

> Future fields on handler ctx

Why would we reserve any slots? We don't need that.

> MANUAL return value

I suppose this is just a stale reference. We can remove it / rewrite it / remove the document entirely if it's redundant at this point.

> RetentionSetter — object map, not a callback.

What do you mean? Now retentionPolicy decides the retention after a record has moved to a final state, so we effectively don't need to have different retention timestamps for different outcomes, but rather we have a single one being set on finalized. This means that `.setRetention` effectively becomes a `.setRetention(number | Date | null)`.

> Runtime / stubs

No runtime yet, just the types

---

**Cursor**

Gathering specifics on topics, retention, and transitional APIs so we can align with your decisions.


Your answers lock most of the convention. Below is a synthesized spec, then the two areas you asked to clarify (topics, retention).

## Locked convention (from your answers)

**Rule:** every callback takes a single `ctx`. No second positional parameter — including workflow `execute`, `scope`, handlers, and policy callbacks.

**Out of scope for ctx refactor:**
- `idempotencyKeyFactory` — stays `(args) => string`
- `RetentionSetter` — not a callback (see retention section below; you may simplify it separately)

**Context shapes:**
- No forced unified schema across primitives — each `ctx` type documents its own fields
- Domain names stay primitive-specific (`args`, `payload`, `message`, `record`, `records`)
- When a definition has no args schema, **`args` is omitted** from the type (not `undefined`)

**Types:**
- Drop artificial hierarchies unless they reflect a real shared surface
- No reserved/future slots on ctx
- Remove all “transitional” APIs — notably **`defineRequest.registerHandler`** on the definition object

**Scope:** `scope` callback becomes `(ctx)` with **`ctx.handles`** (or equivalent), not `(ctx, handles)`

**MANUAL:** stale — `refactor/17_handler_early_termination.MD` describes a model you’ve superseded; trim or delete when touching that area

---

## Retention policies — what I meant

Two different “retention” mechanisms exist today:

| Mechanism | Where | Shape today |
|-----------|--------|-------------|
| **`retentionPolicy`** | Request / queue **handler registration** | Already `(ctx) => number \| null` at **terminal finalize** (`RequestRetentionContext`, `QueueRetentionContext` with `payload`/`message`, `status`, `attempts`) |
| **`RetentionSetter`** | Workflow **definition** + operator **`setRetention`** | Per-status map: `{ complete?: seconds, failed?: seconds, terminated?: seconds }` |

My question was only: **for the ctx sweep, do we touch retention policies?** They already match the one-`ctx` rule. Handler registration wouldn’t change shape — maybe only field naming if we want `ctx.payload` on handlers to match `ctx.payload` on retention ctx (requests already align).

Your **`RetentionSetter` point is separate** and I agree with the direction: if finalize-time policy is “one deadline per row when it becomes terminal,” then operator **`setRetention`** simplifying to **`number | Date | null`** (not a per-status map) is consistent with request/queue `retentionPolicy`. That’s a **workflow retention simplification task**, not part of handler-ctx unification — but worth noting in the backlog so docs/types don’t keep two mental models forever.

---

## Topics — what conflicts with the new model

Topics are the outlier: **most of the topic API isn’t in `src/` yet**, so the ctx refactor can’t be “rename only.”

### What typechecks today (`src/` only)

From `TopicDefinition`:

```typescript
registerConsumer(
  name: string,
  handler: (record, opts: TopicConsumerContext) => Promise<void>,
  options?: { retryPolicy?, neverExpire? },
): Unsubscribe;
```

- Handler: **`(record, opts)`** — opposite order from workflow `(ctx, args)`, and two params
- `TopicConsumerContext` = `{ signal }` only
- Record is **bare decoded payload**, not `TopicRecord` with `id` / `metadata`
- No `onConsumeError`, batch, filter, or client registration on `WorkflowClient`

### What docs + `refactor/15_topics.ts` describe (not in `tsconfig` include)

That file lives under `refactor/`, **outside** `src/**/*`, so it doesn’t run in `pnpm typecheck`. It assumes types that **don’t exist in `src/types`** (`TopicRecord`, `registerTopicConsumer`, `ctx.topics`, workflow `topics:` slot, etc.).

| Surface | Aspirational signature | After your rule |
|---------|----------------------|-----------------|
| Single consumer | `(record, { signal })` | `(ctx)` with `ctx.record`, `ctx.signal` |
| Batch consumer | `(records, opts)` | `(ctx)` with `ctx.records`, `ctx.signal` |
| `onConsumeError` | `(_ctx, event)` in regression file | `(ctx)` with `ctx.event`, `ctx.signal` |

So the **ctx model doesn’t conflict** with topics — it’s straightforward once types exist. The conflict is **API surface not being built yet**, plus open product choices in `topics_divergence.md`:

1. **Registration site:** `client.registerTopicConsumer(topic, …)` (docs) vs `TopicDefinition.registerConsumer` (current stub) — pick one, delete the other  
2. **Record shape:** bare payload (code) vs `TopicRecord<{ id, payload, metadata }>` (docs) — affects whether ctx field is `record: TPayload` vs `record: TopicRecord<…>`  
3. **Batch consumer:** in first cut or not  
4. **`onConsumeError`:** keep skip/halt + `neverExpire` narrowing or not  
5. **Publish path:** `ctx.topics` on workflow vs elsewhere — unrelated to handler ctx but blocks “full topics” task

### Recommendation for topics in the ctx refactor program

**Split into two tasks:**

1. **Topics API task (prerequisite or parallel):** land canonical types in `src/types` — client registration, `TopicRecord`, `onConsumeError` event types, move/duplicate `refactor/15_topics.ts` → `src/types-regression-tests/15_topics.ts` so it typechecks. Resolve divergence checklist items 3–6 at minimum.

2. **Topics ctx task:** apply `(ctx)` to consumer, batch consumer, and `onConsumeError.callback` on those new types.

If you try to do ctx-only on topics now, you’d only change the **stub** `TopicDefinition.registerConsumer(record, opts)` → `(ctx)` — then rip it out when client API lands. Better to **decide client vs definition registration first**, then implement once with `(ctx)`.

---

## Transitional API cleanup (action item)

`RequestDefinition` still has:

```56:72:src/types/definitions/requests.ts
  registerHandler(
    handler: (payload, opts: RequestHandlerContext<TErrors>) => Promise<...>,
    options?: ...
  ): Unsubscribe;
```

Comment says “transitional.” Per your rule: **remove from type + any stub in `workflow.ts`**, client-only registration (like queues). Can be its own small task before or with request handler ctx work.

---

## Updated task list (reflecting your decisions)

| # | Task | Notes |
|---|------|--------|
| 0 | Convention doc | Single `ctx`; omitted vs absent keys; factories out of scope |
| 1 | Remove transitional APIs | `defineRequest.registerHandler`, grep “transitional” |
| 2 | Request compensation handler ctx | `(ctx)` + `payload`, `forward`, `signal`, `errors` |
| 3 | Request forward handler ctx | `(ctx)` + `payload`, … |
| 4 | Queue handler ctx | `(ctx)` + `message`, … |
| 5 | Step execute ctx | `(ctx)` + `args`, `signal` |
| 6 | Step undo ctx | `(ctx)` + `args`, `forward` on compensation ctx |
| 7 | Workflow execute + scope | `(ctx)` + `args`; scope + `handles` on ctx |
| 8 | Topics API + ctx | **Blocked on divergence decisions**; then consumer/batch/onConsumeError |
| 9 | Stale docs | `17_handler_early_termination.MD`, `RetentionSetter` simplification (optional separate) |

---

## What I’d decide next on topics (minimal)

To unblock task 8 without reopening everything:

1. **Client registration** (`client.registerTopicConsumer`) — matches requests/queues  
2. **`TopicRecord` with metadata** — matches docs and consumer filters  
3. **Batch consumer in scope** — you already said yes to `ctx.records`  
4. **`onConsumeError` stays** — callback becomes `(ctx)` with `ctx.event`

Publish / workflow `topics:` slot can land in the same topics API task or follow — doesn’t block handler ctx shape.

If that matches your intent, next step is writing task 0 + task 1 descriptions, then request compensation (task 2) as the first handler migration. Want me to draft those task descriptions in `refactor/` format?

---

**User**

I think we've basically done task 0 here in this discussion. With that in mind, let's go ahead and draft task 1 prompt handoff for an agent. no explicit need to follow any predefined format, just make sure we're being clear on the task. the next message from you is the handoff I can copy and literally paste to another agent to complete the task.

---

**Cursor**

Searching the codebase for transitional APIs and `registerHandler` on definitions so the handoff is accurate.


## Task 1: Remove transitional definition-level handler registration APIs

### Context

This repo is in **active public API development** — no runtime, types + regression tests + docs only. There is **no backwards compatibility** requirement.

**Task 0 (convention, already decided):** Handler/workflow callbacks will eventually unify to a **single `ctx` argument**. That is **out of scope for this task** — do not change handler signatures `(payload, ctx)` etc. yet.

**This task:** Remove “transitional” registration methods that live on **definition objects** instead of the **client**. Registration belongs only on:

- `client.requests.<definitionName>.registerHandler(...)`
- `client.queues.<definitionName>.registerHandler(...)`

(Topics will get `client.registerTopicConsumer(...)` later; for now remove the definition-level stub.)

Queues are already correct: `QueueDefinition` is data-only (no `registerHandler`). Requests and topics are not.

---

### Goal

Make request and topic **definitions data-only** — schema + metadata fields only, same spirit as `QueueDefinition`. No stub `registerHandler` / `registerConsumer` on objects returned from `defineRequest()` / `defineTopic()`.

---

### Required changes

#### 1. `RequestDefinition` — remove `registerHandler`

**File:** `src/types/definitions/requests.ts`

- Remove the `registerHandler(...)` method from `RequestDefinition`.
- Remove the comment about “early API shaping” / “durable registration also lives on client”.
- Drop imports only used by that method (`RequestHandlerContext`, `RequestHandlerRegistrationOptions`, `Unsubscribe`, etc.) if they become unused in this file.

**File:** `src/workflow.ts`

- In `defineRequest()` return value, remove `registerHandler: () => noopUnsubscribe`.
- Update the `defineRequest` doc comment — remove mention of transitional `registerHandler` stub.

**File:** `src/types/definitions/workflow-contract.ts`

- `RequestInterface` is currently `Omit<RequestDefinition, "registerHandler">`. After removal, simplify: `RequestInterface` can equal `RequestDefinition` directly (or a plain type alias). Remove the “without registerHandler” workaround if it’s no longer needed.

Keep the **runtime validation** in `workflow.ts` that rejects `registerHandler` on **request/queue interfaces** in the contract layer (~lines 1165–1199) — that guard is still valid for `WorkflowInterface` / `implement()` authoring.

#### 2. `TopicDefinition` — remove `registerConsumer`

**File:** `src/types/definitions/messaging.ts`

- Remove `registerConsumer(...)` from `TopicDefinition`.
- Update the doc comment — topics are data-only; consumer registration will live on the client (not implemented yet).
- Remove unused imports (`TopicConsumerContext`, `HandlerRetryOptions`, `Unsubscribe`, etc.) if nothing else in the file needs them.

**File:** `src/workflow.ts`

- In `defineTopic()` return value, remove `registerConsumer: () => noopUnsubscribe`.
- Update `defineTopic` doc comment accordingly.

Do **not** add `client.registerTopicConsumer` in this task — only remove the transitional definition API.

#### 3. Verify client registration is untouched

These must **remain** as-is (stubs on client namespaces):

- `src/types/engine.ts` — `RequestNamespaceExternal.registerHandler`, `QueueNamespaceExternal.registerHandler`
- `src/client.ts` — client accessor stubs for `registerHandler`

Regression tests already use **client** registration (`14_requests.ts`, `13_queues.ts`, `08_compensation_model.ts`). They should not need changes unless something incorrectly called `someRequest.registerHandler(...)`.

#### 4. Docs / refactor notes (light touch)

- Grep for “transitional”, `defineRequest` + `registerHandler`, `TopicDefinition` + `registerConsumer`.
- Update any **user-facing docs** that imply registration on the definition object. `docs/primitives/requests.md` and `queues.md` already describe client registration — confirm no regression.
- **`refactor/17_handler_early_termination.ts`** (outside `src/`, not typechecked) still calls `manualRequest.registerHandler` and `earlyTopic.registerConsumer` — either delete those calls, rewrite to note “client-only registration (types TBD)”, or leave a `@ts-expect-error` with a comment. Prefer fixing so the file doesn’t document a removed API; low priority if moving the file isn’t in scope.

Do **not** rewrite `REFACTOR.MD` wholesale.

#### 5. Stale `MANUAL` doc

**Optional in this task (only if you touch the file anyway):** `refactor/17_handler_early_termination.MD` describes `MANUAL` return and definition-level registration — stale. Trim or add a one-line banner that the doc is obsolete relative to throw-based manual escalation and client-only registration. Not blocking for typecheck.

---

### Out of scope

- Unified `(ctx)` handler signatures (Task 2+).
- Adding `client.registerTopicConsumer` or other topic client APIs.
- Runtime implementation.
- `idempotencyKeyFactory` — stays `(args) =>`.
- `RetentionSetter` / `setRetention` simplification.
- Git commit unless explicitly requested.

---

### Verification

```bash
pnpm typecheck
```

Must pass with zero errors.

Optionally:

```bash
pnpm lint
```

Fix any new lint issues in touched files.

---

### Acceptance criteria

1. `RequestDefinition` has **no** `registerHandler` — only `name`, `payload`, `response`, optional `errors`, optional `compensation`.
2. `TopicDefinition` has **no** `registerConsumer` — only `name`, `record`, optional `metadata`, optional `retentionSeconds`.
3. `defineRequest()` / `defineTopic()` return objects without those stub methods.
4. Client `registerHandler` on requests/queues unchanged and still typechecks.
5. All tests under `src/types-regression-tests/` still typecheck.
6. No remaining comments in `src/` claiming definition-level handler registration is intentional/transitional.

---

### Files likely touched

- `src/types/definitions/requests.ts`
- `src/types/definitions/messaging.ts`
- `src/types/definitions/workflow-contract.ts`
- `src/workflow.ts`
- Possibly `refactor/17_handler_early_termination.ts` (non-typechecked)
- Minor doc grep fixes if any doc references definition-level registration

---

### Reference

`QueueDefinition` in `src/types/definitions/messaging.ts` is the pattern to match: definition = schemas + config, handlers register on `client.queues.<name>`.

---

**User**

next up: task 2. 

---

**Cursor**

Checking the codebase state after task 1 to draft an accurate task 2 handoff.


## Task 2: Unify request compensation handler to single `(ctx)`

### Context

**Task 0 convention (locked):** Every callback takes **one argument** — a `ctx` object. Domain inputs and engine-provided data live **on** `ctx`, not as extra positional parameters. Primitives keep **their own** ctx shapes (no forced cross-primitive schema). When a definition has no args/payload schema, that key is **omitted** from the type (not `undefined`).

**Task 1 (done):** Request/topic definitions are data-only. Handler registration is **client-only**: `client.requests.<definitionName>.registerHandler(...)`.

**This task:** Change **only** the **request compensation handler** nested under `registerHandler(..., { compensation: { handler, ... } })`.

**Out of scope for this task:**
- Forward request handler — still `(payload, ctx)` until Task 3
- Step `undo`, queue handlers, workflow `execute`, scope, topics
- Runtime implementation (stubs stay stubs)
- Renaming `RequestCompensationInfo` globally or changing step `CompensationInfo`

---

### Goal

Replace:

```typescript
compensation: {
  handler: async (payload, info, ctx) => { ... },
  retryPolicy: { ... },
}
```

With:

```typescript
compensation: {
  handler: async (ctx) => {
    ctx.payload;
    ctx.forward;   // RequestCompensationInfo<TForwardResponse>
    ctx.signal;
    ctx.errors;
  },
  retryPolicy: { ... },
}
```

---

### Target type shape

Extend `RequestCompensationHandlerContext` in `src/types/definitions/handlers.ts`:

```typescript
export interface RequestCompensationHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TPayload = unknown,
  TForwardResponse = unknown,
> extends HandlerContext {
  readonly payload: TPayload;
  readonly forward: RequestCompensationInfo<TForwardResponse>;
  readonly errors: RequestManualEscalationErrorFactories<TErrors>;
}
```

Update `RequestCompensationRegistrationOptions` so `handler` is:

```typescript
readonly handler: (
  ctx: RequestCompensationHandlerContext<
    TCompensationErrors,
    TPayload,
    TForwardResponse
  >,
) => Promise<RequestCompensationHandlerReturn<TCompensation>>;
```

Remove the three-parameter form entirely. Parameter name should be `ctx` (not `opts`).

Keep **`RequestCompensationInfo<TResponse>`** as a standalone type in `src/types/definitions/steps.ts` — it is the type of **`ctx.forward`**. Update its doc comment: forward outcome is read from `ctx.forward`, not a separate `info` argument.

**Field naming (decided):**
- `payload` — original request payload (same name as forward handler will use in Task 3)
- `forward` — forward invocation snapshot (`RequestCompensationInfo`); keep internal union shape (`response` on `completed`, `reason` on `timed_out`, etc.) — do **not** normalize to step `result` naming

---

### Files to change

#### Types

- `src/types/definitions/handlers.ts` — ctx interface + `RequestCompensationRegistrationOptions.handler` signature
- `src/types/definitions/steps.ts` — comment on `RequestCompensationInfo` only (unless exports need adjustment)

Ensure public re-exports through `src/types.ts` / barrel files still export `RequestCompensationHandlerContext` and `RequestCompensationInfo` if they did before.

#### Regression tests

- `src/types-regression-tests/14_requests.ts` — main compensation block (~243+): rewrite handler to `(ctx)`, update type asserts:
  - `ctx.payload` typed as request payload
  - `ctx.forward extends RequestCompensationInfo<...>`
  - `ctx extends RequestCompensationHandlerContext<compensation errors, payload, forward response>`
  - Branch on `ctx.forward.status`, use `ctx.forward.response` when completed
  - Keep `@ts-expect-error` that compensation `ctx.errors` do not take `{ manual }`
- `src/types-regression-tests/08_compensation_model.ts` — both compensation handlers (`compApproval`, `compManualReview`): same migration

Do **not** change forward handler signatures in these files (`async (payload, ctx)` stays).

#### Docs

- `docs/primitives/requests.md` — compensation registration example + “Forward outcome” section: single `(ctx)`, `ctx.payload`, `ctx.forward`, `ctx.errors`, `ctx.signal`. Fix typo `"completed"c` on line ~239 if still present.
- `refactor/08_compensation_model.MD` — update example/signature prose to match (light touch)

Skip broad `REFACTOR.MD` edits unless one line directly references the old 3-arg compensation handler.

---

### Behavior / semantics (unchanged)

Only the **handler invocation shape** changes. These rules stay as documented:

- Compensation `ctx.errors`: `(message)` or `(message, details)` only — no `{ manual }`
- `return` reports compensation outcome; any `throw` → manual
- Retry exhaustion → manual (no `onExhausted`)
- `compensation.retryPolicy` required when `handler` is set
- Non-compensable requests: `compensation?: never` on registration options

---

### Verification

```bash
pnpm typecheck
```

Must pass with zero errors.

Optionally `pnpm lint` on touched files.

---

### Acceptance criteria

1. `RequestCompensationRegistrationOptions.handler` accepts **exactly one** argument: `RequestCompensationHandlerContext<TErrors, TPayload, TForwardResponse>`.
2. Context includes **`payload`**, **`forward`**, **`signal`**, **`errors`** (compensation error map).
3. No remaining `(payload, info, ctx)` or `(payload, info, opts)` compensation handlers in `src/`.
4. Forward request handlers still use `(payload, ctx)` — unchanged.
5. `14_requests.ts` and `08_compensation_model.ts` typecheck with updated asserts.
6. `docs/primitives/requests.md` compensation section matches the new signature.

---

### Follow-up (do not do here)

- **Task 3:** Forward request handler → `(ctx)` with `ctx.payload`
- **Task 6:** Step `undo` → `(ctx)` with `ctx.args`, `ctx.forward` on compensation ctx

---

### Git

Do **not** commit unless explicitly asked.

