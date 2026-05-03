# 03 Call Time Options

## Goal

Replace the legacy builder-chain configuration with explicit call-time
options. Operation accessors become small overloaded functions whose return
type widens to a discriminated union when a workflow-side timeout is
provided. Failure recovery happens in ordinary sequential code by
inspecting the returned union — no `.failure(cb)` builder.

This step also formalises the buffered-op return-type rule: every buffered
operation in the public API returns plain `void`. The new attached child
workflow entry exposes a `channels.X.send` surface (a buffered op) and is
no longer just a bare `WorkflowEntry`.

## Source Coverage

- `REFACTOR.MD` Part 5: Call-Time Options and Timeout Semantics.
- `REFACTOR.MD` Part 1.2: Buffered vs Awaitable operations table —
  buffered ops return `void` synchronously.
- `REFACTOR.MD` Summary of Public API Changes — "Removed call types and
  methods" subsection and "Context changes" table.

## Public API Target

### Retry / boundary types

- `RetryPolicyOptions` describes retry behavior only:
  `intervalSeconds`, `backoffRate`, `maxIntervalSeconds`,
  `timeoutSeconds` (per-attempt).
- `StepBoundary` describes workflow-side observation boundaries:
  - `number` — relative seconds.
  - `Date` — absolute deadline.
  - `{ maxAttempts; seconds? }` — attempt cap, optional wall-clock cap.
  - `{ seconds; maxAttempts? }` — wall-clock cap, optional attempt cap.
  - `{ deadline: Date; maxAttempts? }` — absolute deadline, optional attempt cap.

### Step accessor — three overloads

Per REFACTOR.MD Part 5 §"Steps", steps have a richer call-time surface
than child workflows or requests because steps are retried by the
workflow executor itself.

- `(args)` — retries forever per the definition's policy; awaits to `T`.
- `(args, { retry })` — overrides retry behavior; still awaits to `T`.
- `(args, { retry?, timeout })` — adds a workflow-side observation
  boundary; awaits to
  `{ ok: true; result: T } | { ok: false; status: "timeout" }`.

### Child workflow accessor — two overloads

Child workflows are not retried by the parent — they either run to
completion, fail with a typed `error: ErrorValue<TChildErrors>`, or (when
a timeout is supplied) the parent observation times out.

- `(startOpts)` — awaits to `{ ok: true; result } | { ok: false; status: "failed"; error }`.
- `(startOpts, { retry?, timeout })` — adds `{ ok: false; status: "timeout" }`.

The returned entry is an `AttachedChildWorkflowEntry<W, TAwaited>` —
awaitable for the union AND exposing the child's declared `channels.X.send`
surface as a buffered op. Attached children deliberately have **no**
`idempotencyKey`: they are not globally addressable.

`startDetached(opts)` is a buffered operation that returns a
`ForeignWorkflowHandle<W>` synchronously. Detached children are
globally-addressable root workflows with their own `idempotencyKey`.

### Request accessor — two overloads

Requests delegate resolution. The workflow does not know or care who
fulfils a request, so retry/exhaustion configuration lives on the handler
registration, not the call site.

- `(payload)` — awaits to the response directly; no workflow-side
  timeout (the workflow waits indefinitely).
- `(payload, { priority?, timeout })` — `timeout` is required when an
  options bag is supplied; awaits to
  `{ ok: true; result } | { ok: false; status: "timeout" }`.

`priority` defaults to 0 and only needs to be set when the caller wants
to shift it; there is no `priority`-only overload.

### Buffered operations

Per REFACTOR.MD Part 1.2, every buffered operation returns plain `void`
synchronously. Step 03 sweeps the existing buffered surfaces:

- `streams.X.write(data)` — `void` (the assigned offset is observable
  externally via the stream's read APIs, not on the write call).
- `events.X.set()` — `void`.
- `channels.X.send(payload)` on attached child entries, foreign
  workflow handles, and detached child handles — `void`.

Awaitable reads (`channel.receiveNowait`, `patch`) keep their existing
shape — they belong to a different category in Part 1.2 ("awaitable
read") and resolve to a value rather than dispatching work.

### Removed

- `.resolve(ctx)`, `.retry(...)`, `.timeout(...)`, `.failure(...)`,
  `.complete(...)`, `.compensate(...)`, `.priority(...)` builders are
  not present on entries (also removed in step 01).
- `RequestTimeoutCallOptions` is gone — it merged into
  `RequestCallOptions` (which now requires `timeout` when supplied).

## Affected Areas

- `src/types/context/call-builders.ts` — `ChildWorkflowAccessor` (2 call
  overloads + `startDetached`), `RequestAccessor` (2 overloads),
  `AttachedChildWorkflowEntry`, `ChannelSendSurface`,
  `ForeignWorkflowHandle`.
- `src/types/context/io-accessors.ts` — `StreamAccessor.write`,
  `EventAccessor.set` return `void`.
- `src/types.ts` — exports `AttachedChildWorkflowEntry`,
  `ChannelSendSurface`; drops `RequestTimeoutCallOptions`.

## Acceptance Contract

The paired file `src/types-regression-tests/03_call_time_options.ts`
verifies:

1. `RetryPolicyOptions` accepts only `intervalSeconds`, `backoffRate`,
   `maxIntervalSeconds`, `timeoutSeconds`. Legacy `deadlineSeconds` is
   rejected.
2. `StepBoundary` accepts the five documented forms; legacy
   `deadlineUntil` shape is rejected.
3. Step accessors expose three overloads producing `T` / `T` / timeout
   union respectively.
4. Child workflow accessors expose two call overloads — without timeout
   the awaited value is the success-or-failure union; with timeout it
   adds the `timeout` variant.
5. The attached child entry is awaitable AND extends `ChannelSendSurface`;
   it has no `idempotencyKey`.
6. `channels.X.send(...)` on the attached entry returns plain `void`.
7. `startDetached(opts)` returns a `ForeignWorkflowHandle<W>` with
   `idempotencyKey` and `channels`. The handle is not awaitable.
8. Request accessors expose two overloads — the second requires
   `timeout` when supplied; `priority` alone is rejected.
9. Removed builder methods (`.retry`, `.timeout`, `.priority`, etc.) are
   not present on entries.

## Out of Scope (Deferred)

- Scope orchestration over entries (`ctx.scope`, `ctx.all`, `ctx.first`,
  etc.) — step 07.
- `ctx.join` and `ctx.match` semantics — step 07.
- `ScheduledDeliveryOptions` (`delaySeconds` / `scheduledAt` on starts) —
  step 18.
- `idempotencyKeyFactory` derivation rules for root and detached starts —
  step 19.
- The full request handler registration surface (with `onExhausted`,
  `MANUAL`) — step 14.
