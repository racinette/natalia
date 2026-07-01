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

Every `ctx.errors` call requires `{ manual }`. `manual: true` moves the invocation to `status: manual` with persisted `code`, `message`, and optional `details` for operators. The request stays open until something calls `resolve`, `cancel`, or the workflow observes a call-time timeout. `manual: false` records a failed attempt and retries.

Business outcomes belong in `return response` — including rejection. A declined approval is still a resolved request:

```typescript
return { decision: "reject", note: "Policy violation" };
```

Optional `onExhausted` runs when handler retries are exhausted. It receives the same `ctx.errors` surface and must `return` a response or throw with `{ manual: true }`:

```typescript
client.requests.humanReview.registerHandler(handler, {
  retryPolicy: { maxAttempts: 3, timeoutSeconds: 60 },
  onExhausted: {
    callback: async (payload, ctx) => {
      await notifyReviewQueue(payload);
      throw ctx.errors.NeedsSeniorReviewer("Retries exhausted — waiting for human", {
        manual: true,
      });
    },
    retryPolicy: { intervalMs: 5000 },
  },
});
```

See [error-model.md](../error-model.md) for how request handler errors relate to workflow errors.

## Manual resolution

Manual requests are queryable on the client. An external actor resolves or cancels through the request handle:

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
await handle.cancel();
```

`resolve` records the response and unblocks the workflow. `cancel` ends the wait without a typed response; the workflow observes `{ ok: false, status: "timeout" }` when it passed a call-time `timeout`.

See [Resolving Requests Asynchronously](../resolving-requests-asynchronously.md) for commit boundaries and idempotent external resolution.

## Compensation

A compensable request declares `compensation: true` or `compensation: { result?, errors? }` on `defineRequest`. The compensation handler registers separately:

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

registerRequestCompensationHandler(
  reserveFlightTicket,
  async (payload, info, ctx) => {
    if (info.status !== "completed") {
      throw ctx.errors.ReleaseBlocked("Nothing to release", { manual: true });
    }
    await releaseReservation(info.response.reservationId, { signal: ctx.signal });
    return { released: true };
  },
  { retryPolicy: { timeoutSeconds: 30 } },
);
```

Compensation uses its own `errors` map — not the forward handler's. The same `{ manual }` disposition applies: `manual: true` parks the compensation block; `return` reports the compensation outcome.

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

| Status | Meaning |
|--------|---------|
| `pending` | Recorded; waiting for a handler claim. |
| `claimed` | Handler running under `retryPolicy`. |
| `manual` | Parked for external resolution (`throw ctx.errors.X(..., { manual: true })`). |
| `resolved` | Response recorded; workflow can proceed. |
| `timedOut` | Workflow call-time `timeout` elapsed before resolution. |
| `cancelled` | Operator cancelled via request handle. |

`manual` is not terminal. The invocation stays open until `resolve`, `cancel`, or workflow timeout observation.

### Handler outcomes

| Action | Outcome |
|--------|---------|
| `return response` | Resolved with typed response. |
| `throw ctx.errors.X(..., { manual: true })` | Moves to `manual` with structured escalation metadata. |
| `throw ctx.errors.X(..., { manual: false })` | Failed attempt; retry per policy. |
| Unhandled throw | Failed attempt with `code: null`; retry per policy. |

When `errors` is omitted from `defineRequest`, `ctx.errors` has no factories.

### Attempt records

Failed handler tries are persisted. Successful resolution does not create attempt rows.

Declared errors persist `code` and `message`. Schema-backed codes include a `details` slot with `serialized`, `serialization_error`, or `unspecified` status — same shape as [queue handler attempts](./queues.md#attempt-records).
