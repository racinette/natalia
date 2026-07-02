# Resolving Requests Asynchronously

A request is resolved when the engine records a typed **response** for that request invocation. For workflow replay, that recorded response is the durable handoff back into the workflow.

There are several ways to reach that state:

- A registered request handler returns the response.
- The handler exhausts its retry budget and the engine moves the invocation to **`manual`** (with persisted attempt history).
- The handler throws **`ctx.errors.X(..., { manual: true })`**, and a later actor resolves the request through its request handle.
- No handler is registered, and all resolution happens through the external client API.

The later actor can be a human operator, an admin UI, a runbook, a webhook handler, a topic or queue consumer, another service, or a domain event listener. The important boundary is the same in every case: until **`resolve`** succeeds, the workflow has not observed a response.

## Commit Boundaries

When an external resolver performs a broader effect before resolving the request, it must make that effect atomic with the resolution or retryable until the resolution is accepted.

For example, a ticket-return listener might:

1. Reserve a returned ticket for the waiting customer.
2. Resolve the Natalia request with `{ reservationId, ticketId, expiresAt }`.

If the process crashes between those two operations, the ticket may be reserved but the workflow is still waiting. A retry must be able to finish the same resolution rather than leak the reservation or create a second one.

## Reliable Patterns

- **Single transaction** — if the domain write and Natalia request resolution share a database/transaction boundary, perform both in the same transaction and commit them together.
- **Outbox/retry loop** — commit the domain effect with an outbox row keyed by the request id; a worker keeps calling **`resolve`** until it succeeds.
- **External callback** — pass the request id as the correlation and idempotency key to the external system; the callback resolver treats retries and “already resolved” as successful completion.

The request id is the natural idempotency key. Any external effect performed before **`resolve`** should be keyed by that id when possible:

```typescript
const request = client.requests.reserveFlightTicket.get(requestId);
const row = await request.fetchRow({ payload: true });

if (row.status !== "unique") {
  return;
}

const reservation = await reserveTicketForCustomer({
  ticketId: event.ticketId,
  customerId: row.value.payload.customerId,
  idempotencyKey: request.id,
});

await request.resolve(reservation);
```

If the resolver crashes after reserving the ticket but before **`resolve`**, a retry with the same **`request.id`** can recover the same reservation and complete the handoff.

## What Is Not Resolution

Timeouts and compensation are not forward request resolutions.

- A workflow-side **`timeout`** is the caller's observation boundary — `{ ok: false, status: "timeout" }` when the call passed `timeout` and the deadline elapsed.
- **`escalateToManual`** parks the invocation for external resolution without a typed response; the workflow keeps waiting until `resolve` or call-time timeout.
- Request compensation is a later cleanup lifecycle driven by the forward outcome.
