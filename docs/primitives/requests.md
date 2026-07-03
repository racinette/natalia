# Requests

A request is a typed, durable call from a workflow to the outside world. The workflow posts a payload and waits until a typed response is recorded. Handler code runs on the client — not inside `execute` — and replay reproduces the same response once it exists.

## Quick start

Define the request:

```typescript
const humanReview = defineRequest({
  name: "humanReview",
  payload: z.object({
    documentId: z.string(),
    summary: z.string(),
  }),
  response: z.object({
    decision: z.enum(["approve", "reject"]),
    note: z.string(),
  }),
  errors: {
    NeedsSeniorReviewer: true,
    RulesEngineUnavailable: z.object({ ruleId: z.string() }),
  },
});
```

Declare it on a workflow and await it from `execute`:

```typescript
const onboarding = defineWorkflow({
  name: "onboarding",
  requests: { humanReview },
  result: z.object({ approved: z.boolean() }),
  async execute(ctx) {
    const { decision } = await ctx.requests.humanReview({
      documentId: "doc-1",
      summary: "New vendor application",
    });
    return { approved: decision === "approve" };
  },
});
```

Register a handler on the client (keyed by the definition's `name`, not the workflow-local slot):

```typescript
const unregister = client.requests.humanReview.registerHandler(
  async (payload, ctx) => {
    const auto = await tryRulesEngine(payload, { signal: ctx.signal });
    if (auto) {
      return auto;
    }
    throw ctx.errors.NeedsSeniorReviewer("No rule matched — escalate to senior reviewer", {
      manual: true,
    });
  },
  {
    retryPolicy: {
      timeoutSeconds: 60,
      maxAttempts: 3,
      intervalSeconds: 5,
      backoffRate: 2,
    },
  },
);
```

`return` supplies the response and resolves the invocation. `throw ctx.errors.X(..., { manual: true })` parks it for external resolution. `throw ctx.errors.X(..., { manual: false })` records a failed attempt and retries per `retryPolicy`.

## Calling from workflows

Workflows reference a request in `requests: { slot: myRequest }` and call `ctx.requests.<slot>(payload)` or `ctx.requests.<slot>(payload, opts)`.

Without options, the await resolves to the response type directly:

```typescript
const { decision, note } = await ctx.requests.humanReview({
  documentId: "doc-2",
  summary: "High-risk change",
});
```

With options, pass `priority` and `timeout` together. The await returns a result union — branch on `ok`:

```typescript
const review = await ctx.requests.humanReview(
  { documentId: "doc-2", summary: "High-risk change" },
  { priority: 1, timeout: 3600 },
);

if (!review.ok) {
  throw ctx.errors.ReviewTimedOut("Reviewer did not respond in time", {
    documentId: "doc-2",
  });
}

const { decision, note } = review.result;
```

`timeout` is a number (seconds) or a `Date`. It bounds how long this workflow invocation waits for a response. Retry policy, attempt limits, and manual escalation belong on handler registration.

The workflow slot (`humanReview` above) is only for `ctx.requests`. The client namespace uses `defineRequest`'s `name` field.

## Handling requests

Handlers register with `client.requests.<definitionName>.registerHandler(handler, options)`. The handler receives the decoded payload and a context with `signal` and `errors`. Payloads that fail schema decode never reach the handler.

Declare an optional `errors` map on `defineRequest` for typed throw helpers:

```typescript
// errors: { NeedsSeniorReviewer: true }
throw ctx.errors.NeedsSeniorReviewer("Escalate to senior reviewer", { manual: true });

// errors: { RulesEngineUnavailable: schema }
throw ctx.errors.RulesEngineUnavailable(
  "Rules engine timed out",
  { ruleId: "R-42" },
  { manual: false },
);
```

Every forward-handler `ctx.errors` call requires `{ manual }`. `manual: true` moves the invocation to `status: manual` with persisted `code`, `message`, and optional `details` for operators. The request stays open until something calls `resolve`, or the workflow observes a call-time `timeout`. `manual: false` records a failed attempt and retries.

Business outcomes belong in `return response` — including rejection. A declined approval is still a resolved request:

```typescript
return { decision: "reject", note: "Policy violation" };
```

When handler retries are exhausted, the engine moves the invocation to `manual` with persisted attempt history. Use `throw ctx.errors.X(..., { manual: true })` during the handler when external resolution is needed early, or query `status: "manual"` and resolve through request handles.

Optional `retentionPolicy` runs once when an invocation reaches a terminal state (`resolved` or `timedOut`). Return seconds to keep the row, or `null` to keep it indefinitely. The callback receives the decoded payload, terminal status, response when resolved, and an attempts accessor. `manual` is not terminal — retention runs when the invocation later resolves or the workflow call times out.

```typescript
client.requests.humanReview.registerHandler(handler, {
  retryPolicy: { maxAttempts: 3, timeoutSeconds: 60 },
  retentionPolicy: async (ctx) => {
    if (ctx.status === "resolved") return 86400;
    return 86400 * 7;
  },
});
```

See [error-model.md](../error-model.md) for how request handler errors relate to workflow errors.

## Manual resolution

Manual requests are queryable on the client. An external actor resolves or escalates through the request handle. Both `resolve` and `escalateToManual` abort an in-flight handler attempt.

```typescript
const waiting = await client.requests.humanReview.findMany(
  ({ status, payload }) =>
    and(eq(status, "manual"), eq(payload.documentId, "doc-1")),
  { fields: { id: true, payload: true }, limit: 10 },
);

for (const request of waiting) {
  await request.resolve({
    decision: "approve",
    note: "Approved by operator",
  });
}

const handle = client.requests.humanReview.get(requestId);

// Stop automation and park for manual resolution (untyped)
await handle.escalateToManual({
  message: "Ops took over — vendor API degraded",
  type: "AdminConsole",
});

// Or use declared error codes when defineRequest declares errors
await handle.escalateToManual({
  code: "NeedsSeniorReviewer",
  message: "Escalated from admin console",
});

await handle.escalateToManual({
  code: "RulesEngineUnavailable",
  message: "Rules engine down",
  details: { ruleId: "R-42" },
});
```

`resolve` records the typed response and unblocks the workflow. `escalateToManual` moves the invocation to `manual` without a response — the workflow keeps waiting until `resolve` or its own call-time `timeout`.

Escalation input mirrors handler attempt records: omit `code` for untyped escalation (`message`, optional `type`); set `code` for declared errors with schema-backed `details` as invocation input (not the persisted `serialized` / `serialization_error` union — the engine validates and persists that).

When the workflow passed `{ timeout }` at the call site and the deadline elapses before resolution, it observes `{ ok: false, status: "timeout" }`. That is separate from manual escalation — only the caller's timeout produces that observation.

See [Resolving Requests Asynchronously](../resolving-requests-asynchronously.md) for commit boundaries and idempotent external resolution.

## Request compensation

When a workflow fails and enters compensation, the engine schedules a compensation block for each forward request invocation on a **compensable** definition. The compensation handler receives the original request payload and a summary of how the forward invocation ended. It runs on the client under its own retry policy — the same split as forward handlers.

Request compensation mirrors [step compensation](./steps.md): declare on the definition, register a handler on the client, inspect forward outcome via `ctx.forward`, and report the undo outcome through `return` or manual escalation through `throw`.

### Declaring a compensable request

Add `compensation: true` or `compensation: { result?, errors? }` to `defineRequest`:

```typescript
const reserveFlightTicket = defineRequest({
  name: "reserveFlightTicket",
  payload: z.object({ customerId: z.string(), flightDate: z.string() }),
  response: z.object({ reservationId: z.string(), ticketId: z.string() }),
  compensation: {
    result: z.object({ released: z.boolean() }),
    errors: {
      ReleaseBlocked: true,
    },
  },
});
```

- `compensation: true` — no typed compensation result; the handler returns `void` and operator `skip()` takes no result argument.
- `compensation: { result }` — optional schema for the reported undo outcome (same pattern as step `compensation.result`).
- `compensation.errors` — optional error map for the **compensation handler only**. It is separate from forward `errors` on the same request.

Inline `undo` on `defineRequest` is rejected. There is no separate compensation registration API.

### Registering forward and compensation handlers

Forward and compensation handlers register together on `client.requests.<definitionName>.registerHandler`. When `compensation.handler` is set, `compensation.retryPolicy` is required:

```typescript
client.requests.reserveFlightTicket.registerHandler(
  async (payload, ctx) => {
    const reservation = await reserveTicket(payload, { signal: ctx.signal });
    return reservation;
  },
  {
    retryPolicy: { timeoutSeconds: 30, maxAttempts: 3 },
    maxConcurrent: 5,
    retentionPolicy: async (ctx) => (ctx.status === "resolved" ? 86400 : null),
    compensation: {
      handler: async (ctx) => {
        let reservation =
          ctx.forward.status === "completed"
            ? ctx.forward.response
            : await lookForReservedTicket(ctx.payload, ctx.signal);

        if (!reservation) {
          return { released: false };
        }

        await releaseReservation(reservation.reservationId, { signal: ctx.signal });
        return { released: true };
      },
      retryPolicy: { timeoutSeconds: 30, maxAttempts: 3 },
      maxConcurrent: 2,
    },
  },
);
```

`retentionPolicy` is declared once on forward registration and applies to both forward and compensation rows for that request definition.

Non-compensable requests reject a `compensation` block at registration time.

### Forward outcome and reconciliation

The compensation handler receives a single `ctx` argument. `ctx.payload` is the original request payload; `ctx.forward` summarizes how the forward invocation settled from the engine's point of view.

Forward settlement describes what the engine observed, not what happened remotely. When forward completed, use `ctx.forward.response` directly. When forward timed out or terminated, **do not** treat that as "nothing to undo" — reconcile with external or domain state (lookup APIs, idempotency keys) before returning an explicit no-op outcome.

```typescript
compensation: {
  handler: async (ctx) => {
    let reservation =
      ctx.forward.status === "completed"
        ? ctx.forward.response
        : await lookForReservedTicket(ctx.payload, ctx.signal);

    if (!reservation) {
      return { released: false };
    }

    try {
      await releaseReservation(reservation.reservationId, { signal: ctx.signal });
    } catch {
      throw ctx.errors.ReleaseBlocked("Release transiently failed", { manual: false });
    }

    return { released: true };
  },
  retryPolicy: { timeoutSeconds: 30 },
},
```

When forward did not complete cleanly, inspect `ctx.forward.attempts` for reachability hints — then reconcile. Attempt history does not replace external reconciliation.

`ctx.forward.status === "completed"` exposes `ctx.forward.response`. `"timed_out"` exposes `reason` (`"attempts_exhausted" | "deadline"`) and `attempts`. `"terminated"` exposes `attempts` only — neither timed-out nor terminated variants expose `response`.

### Compensation handler outcomes

Compensation `ctx.errors` factories mirror forward handlers: `(message, { manual })` or `(message, details, { manual })`. `manual: false` records a failed attempt and retries per `compensation.retryPolicy`. `manual: true` moves the compensation block to `manual`. When compensation retries are exhausted, the block moves to `manual` with persisted attempt history.


| Action                                              | Outcome                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `return result`                                     | Compensation block completes with the typed result (or `void` when no `compensation.result` schema). |
| `throw ctx.errors.X(..., { manual: false })`        | Failed attempt; retry per `compensation.retryPolicy`.                                                |
| `throw ctx.errors.X(..., { manual: true })`         | Moves compensation block to `manual`.                                                                |
| Unhandled throw                                     | Failed attempt; retry per `compensation.retryPolicy`.                                                |
| Compensation retry budget exhausted                 | Moves compensation block to `manual`.                                                                |


Business outcomes belong in `return`, not in the error map.

### Operator actions on compensation blocks

Query compensation block instances through the workflow handle at `compensations.requests.<workflowSlot>` (the workflow-local request slot, not the definition `name`):

```typescript
const found = await workflowHandle.compensations.requests.reserveFlightTicket.findUnique(
  ({ payload }) => eq(payload.customerId, "cust-1"),
);

if (found.status === "unique") {
  await found.value.skip({ released: true });
  await found.value.escalateToManual({
    code: "ReleaseBlocked",
    message: "Operator must release manually",
  });
}
```

- `skip(result?)` — record the compensation outcome without running the handler again. Omit `result` when the definition used `compensation: true`.
- `escalateToManual(...)` — park the block for external completion using the compensation `errors` map shape (same escalation input rules as forward `escalateToManual`).

Both operator actions abort an in-flight compensation handler attempt.

## Example: waitlist via manual mode

When inventory is not immediately available, the handler parks the request and an event listener resolves it later:

```typescript
const reserveFlightTicket = defineRequest({
  name: "reserveFlightTicket",
  payload: z.object({ customerId: z.string(), flightDate: z.string() }),
  response: z.object({ reservationId: z.string(), ticketId: z.string() }),
  errors: { NeedsInventory: true },
});

client.requests.reserveFlightTicket.registerHandler(
  async (payload, ctx) => {
    const reservation = await tryReserveTicket(payload, { signal: ctx.signal });
    if (reservation) {
      return reservation;
    }
    throw ctx.errors.NeedsInventory("No ticket available yet", { manual: true });
  },
  { retryPolicy: { timeoutSeconds: 30, maxAttempts: 1 } },
);

async function onTicketReturned(event: TicketReturnedEvent) {
  const [request] = await client.requests.reserveFlightTicket.findMany(
    ({ status, payload }) =>
      and(
        eq(status, "manual"),
        eq(payload.flightDate, event.date),
      ),
    { fields: { id: true, payload: true }, limit: 1, sort: [{ path: "priority", direction: "desc" }] },
  );
  if (!request) return;

  const reservation = await reserveTicketForCustomer({
    ticketId: event.ticketId,
    customerId: request.row.payload.customerId,
    idempotencyKey: request.id,
  });
  await request.resolve(reservation);
}
```

If no ticket arrives before the workflow's call-time `timeout`, the workflow observes `{ ok: false, status: "timeout" }` and can take domain action (for example enqueue a notification via [queues](./queues.md)).

## Reference

### Invocation lifecycle


| Status     | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `pending`  | Recorded; waiting for a handler claim.                                                                                |
| `claimed`  | Handler running under `retryPolicy`.                                                                                  |
| `manual`   | Parked for external resolution (handler `manual: true`, retry exhaustion, compensation `manual: true` throw, or `escalateToManual`). |
| `resolved` | Response recorded; workflow can proceed.                                                                              |
| `timedOut` | Workflow call-time `timeout` elapsed before resolution.                                                               |


`manual` is not terminal. The invocation stays open until `resolve` or the workflow's call-time timeout observation.

After a terminal transition, `retentionPolicy` (if registered) sets `retention_deadline_at` for eventual row deletion.

### Handler outcomes


| Action                                       | Outcome                                                |
| -------------------------------------------- | ------------------------------------------------------ |
| `return response`                            | Resolved with typed response.                          |
| `throw ctx.errors.X(..., { manual: true })`  | Moves to `manual` with structured escalation metadata. |
| `throw ctx.errors.X(..., { manual: false })` | Failed attempt; retry per policy.                      |
| Unhandled throw                              | Failed attempt with `code: null`; retry per policy.    |
| Retry budget exhausted                       | Moves to `manual` with persisted attempt history.      |


When `errors` is omitted from `defineRequest`, `ctx.errors` has no factories.

### Attempt records

Failed handler tries are persisted. Successful resolution does not create attempt rows.

Declared errors persist `code` and `message`. Schema-backed codes include a `details` slot with `serialized`, `serialization_error`, or `unspecified` status — same shape as [queue handler attempts](./queues.md#attempt-records).

### Request compensation lifecycle


| Status      | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `pending`   | Compensation block recorded; waiting for handler claim.                                  |
| `running`   | Compensation handler running under `compensation.retryPolicy`.                           |
| `manual`    | Parked for external completion (handler throw, retry exhaustion, or `escalateToManual`). |
| `completed` | Typed compensation result recorded (when `compensation.result` is declared).             |
| `skipped`   | Operator recorded completion via `skip` without a handler run.                           |


Compensable request definitions cannot be listed as compensation dependencies on a step's `compensation.requests` block — each compensable request owns its own compensation lifecycle. See [steps](./steps.md) for step-side compensation.