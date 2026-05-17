# Requests

## What it is

A **request** is a **typed, durable request–response slot** between a workflow and the outside world. The workflow **posts a payload** and **blocks** until something returns a **typed response**. It does **not** embed the resolver’s implementation in `execute`—that work lives in a **handler** registered on the client, in an operator action, or in another integration that calls **`resolve`** on a request stuck in manual mode.

You define a request once with **`defineRequest`**: a **name**, a **`payload`** schema, and a **`response`** schema. The workflow calls it with **`ctx.requests.<name>(payload)`** (or with call-time **`priority`** and **`timeout`**). The engine records the invocation, dispatches resolution to the handler infrastructure, and on replay **replays the recorded response** once one exists—same durability story as other dispatched entries.

#### Workflow call site

- **`(payload)`** — await the **response** type directly. The workflow waits until the request is resolved (handler success, external **`resolve`**, or equivalent).
- **`(payload, { priority, timeout })`** — the **`timeout`** option is **required** whenever you pass an options bag. The awaited value becomes **`{ ok: true; result: T } | { ok: false; status: "timeout" }`**. Branch on **`ok`**, not **`try/catch`**. **`priority`** influences ordering among competing requests; it is not a stop condition by itself.

Retry strategy, per-attempt limits, exhaustion, and **`MANUAL`** belong on **handler registration**, not on the workflow call. The workflow author chooses **how long this invocation is willing to wait**; the handler owner chooses **how hard to try before giving up or escalating to manual**.

#### Handlers and `MANUAL`

Handlers are registered on the **client** (alongside the engine runtime), not on `defineRequest`. A handler receives the decoded **payload** and **`{ signal }`** for the current try. It **returns** a typed **response**, or **`MANUAL`** when resolution must come from outside (human, ticket system, webhook).

When a handler (or its **`onExhausted`** callback) returns **`MANUAL`**, the request enters **manual mode** and stays open until an external actor resolves the request through its request handle (or the invocation is cancelled). Failed handler tries are persisted on the request’s attempt log (**failed tries only** on the handler side—see `AttemptAccessor`).

#### Compensable requests

A request may declare **`compensation: true`** or **`compensation: { result: … }`** on the definition. That marks **request compensation** as a concept—it does **not** embed an **`undo`** on `defineRequest`. The compensation **handler** is registered separately with **`registerRequestCompensationHandler`**, the same way the forward handler is separate. Request compensation invocations are lightweight (no per-instance primitive plane like a step compensation block); they are still observable and can be **`skip`ped** with an operator-supplied result when a **`result`** schema is declared.

## Why it exists

**Steps** run integration code the workflow platform executes directly. **Requests** model work where **some other actor** must complete the other half: human approval, a partner service, a runbook bot, or an ops queue. The workflow names the contract (**payload** / **response**) and waits durably; it does not need to know **who** fulfilled it.

That separation keeps replay honest (one recorded response per invocation) and makes **human-in-the-loop** and **delegated resolution** first-class without stuffing operator UI into `execute`.

## What it is NOT

- **Not** workflow-owned `execute` I/O like a **step**: the workflow never runs the resolver’s implementation inside its worker.
- **Not** fire-and-forget messaging: the workflow **waits** for a **response** (or a **timeout** observation on the call).
- **Not** a **channel**: there is no per-instance mailbox; this is a **global request definition** resolved per invocation row.
- **Not** inline compensation on the definition: no `undo` on `defineRequest`; forward and compensation handlers register separately.
- **Not** priority without **`timeout`**: if you pass call options, **`timeout`** must be present.

## Examples

**Defining a request**

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
});
```

**Awaiting a request from a workflow** (no options → response directly)

```typescript
const onboarding = defineWorkflow({
  name: "onboarding",
  requests: { humanReview },
  result: z.object({ approved: z.boolean() }),
  async execute(ctx) {
    const { decision, note } = await ctx.requests.humanReview({
      documentId: "doc-1",
      summary: "New vendor application",
    });
    return { approved: decision === "approve" };
  },
});
```

**Awaiting with `timeout` and `priority`**

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

**Registering a handler on the client** (resolution lives outside the workflow definition)

```typescript
import { MANUAL } from "natalia";

client.registerRequestHandler(
  humanReview,
  async (payload, { signal }) => {
    const auto = await tryRulesEngine(payload, { signal });
    if (auto) {
      return auto;
    }
    return MANUAL;
  },
  {
    maxConcurrent: 10,
    retryPolicy: {
      timeoutSeconds: 60,
      maxAttempts: 3,
      intervalSeconds: 5,
      backoffRate: 2,
    },
    onExhausted: {
      callback: async (payload, { signal }) => {
        await notifyReviewQueue(payload, { signal });
        return MANUAL;
      },
      retryPolicy: { intervalMs: 5000 },
    },
  },
);
```

**Flight booking request** — reserve immediately when inventory exists, otherwise wait in manual mode for future availability

```typescript
import { MANUAL } from "natalia";
import { and, eq } from "natalia/search";

const reserveFlightTicket = defineRequest({
  name: "reserveFlightTicket",
  payload: z.object({
    customerId: z.string(),
    flightDate: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  response: z.object({
    reservationId: z.string(),
    ticketId: z.string(),
    expiresAt: z.string(),
  }),
  compensation: {
    result: z.object({
      kind: z.enum(["reservation_released", "nothing_to_release"]),
      failedForwardAttempts: z.number(),
    }),
  },
});

const customerNotifications = defineQueue({
  name: "customerNotifications",
  message: z.object({
    kind: z.literal("no_ticket_available"),
    customerId: z.string(),
    flightDate: z.string(),
  }),
});

const scoreTicketRequestPriority = defineStep({
  name: "scoreTicketRequestPriority",
  args: z.object({
    customerId: z.string(),
    flightDate: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  result: z.object({ priority: z.number() }),
  async execute(args, { signal }) {
    const score = await scoreCustomerConversionLikelihood(args.customerId, {
      signal,
    });
    return { priority: scoreToTicketQueuePriority(score) };
  },
});

const chargeCustomer = defineStep({
  name: "chargeCustomer",
  args: z.object({
    customerId: z.string(),
    reservationId: z.string(),
  }),
  result: z.object({ paymentId: z.string() }),
  async execute(args, { signal }) {
    return billing.chargeForReservation(args, { signal });
  },
});

const bookFlight = defineWorkflow({
  name: "bookFlight",
  steps: { scoreTicketRequestPriority, chargeCustomer },
  queues: { customerNotifications },
  requests: { reserveFlightTicket },
  args: z.object({
    customerId: z.string(),
    flightDate: z.string(),
    from: z.string(),
    to: z.string(),
    ticketSearchTimeoutOffsetSeconds: z.number(),
  }),
  async execute(ctx, args) {
    const flightDateEndsAt = endOfFlightDate(args.flightDate);
    const timeoutAt = new Date(
      flightDateEndsAt.getTime() - args.ticketSearchTimeoutOffsetSeconds * 1000,
    );
    const { priority } = await ctx.steps.scoreTicketRequestPriority({
      customerId: args.customerId,
      flightDate: args.flightDate,
      from: args.from,
      to: args.to,
    });

    const ticket = await ctx.requests.reserveFlightTicket(
      {
        customerId: args.customerId,
        flightDate: args.flightDate,
        from: args.from,
        to: args.to,
      },
      {
        priority,
        timeout: timeoutAt,
      },
    );

    if (!ticket.ok) {
      ctx.queues.customerNotifications.enqueue({
        kind: "no_ticket_available",
        customerId: args.customerId,
        flightDate: args.flightDate,
      });
      throw ctx.errors.NoTicketAvailable("No ticket became available");
    }

    await ctx.steps.chargeCustomer({
      customerId: args.customerId,
      reservationId: ticket.result.reservationId,
    });
    return ticket.result;
  },
});

client.registerRequestHandler(
  reserveFlightTicket,
  async (payload, { signal }) => {
    const reservation = await db.transaction(async (tx) => {
      const ticket = await tx.returnedTickets.findAvailableForUpdate({
        date: payload.flightDate,
        from: payload.from,
        to: payload.to,
        signal,
      });

      if (!ticket) {
        return null;
      }

      return tx.reservations.createForCustomer({
        customerId: payload.customerId,
        ticketId: ticket.id,
        signal,
      });
    });

    return reservation ?? MANUAL;
  },
  { retryPolicy: { timeoutSeconds: 30, maxAttempts: 3 } },
);

async function onTicketReturned(event: TicketReturnedEvent) {
  const waiting = client.requests.reserveFlightTicket.findMany(
    ({ payload, status }) =>
      and(
        eq(status, "manual"),
        eq(payload.flightDate, event.date),
        eq(payload.from, event.from),
        eq(payload.to, event.to),
      ),
    {
      fields: { id: true, payload: true },
      sort: [{ path: "priority", direction: "desc" }],
      limit: 1,
    },
  );

  const [request] = await waiting;
  if (!request) {
    return;
  }

  const reservation = await reserveTicketForCustomer({
    ticketId: event.ticketId,
    customerId: request.row.payload.customerId,
    idempotencyKey: request.id,
  });

  await request.resolve(reservation);
}

client.registerRequestCompensationHandler(
  reserveFlightTicket,
  async (_payload, info, { signal }) => {
    const failedForwardAttempts = await info.attempts.count();

    if (info.status !== "completed") {
      return { kind: "nothing_to_release" as const, failedForwardAttempts };
    }

    await releaseReservation(info.response.reservationId, { signal });
    return { kind: "reservation_released" as const, failedForwardAttempts };
  },
  { retryPolicy: { timeoutSeconds: 30 } },
);
```

The request call uses an absolute **`Date`** timeout derived from the flight date. The customer supplies an offset in seconds from the end of **`flightDate`**, so the computed timeout is always relative to the flight itself rather than an independent deadline that the workflow must cap.

The **priority** comes from a normal workflow-owned **step**. In this example, customer scoring decides how valuable the booking is likely to be, and the request uses that score-derived priority when competing with other waiting ticket requests.

The handler either reserves an available ticket in one transaction or returns **`MANUAL`**. Manual requests become a durable, queryable waitlist keyed by date and route: each ticket-return event can search the waiting requests, reserve exactly one ticket, and **`resolve`** that request. If no ticket becomes available before the workflow’s call-time **`timeout`**, the workflow observes `{ ok: false, status: "timeout" }` and can notify the customer.

The compensation handler receives the original payload plus **`info`** about the forward request. If the request completed, **`info.response`** contains the reservation to release. For timed-out or terminated requests there is no reservation, but **`info.attempts`** is still available for audit and operator-visible compensation results.

See [Resolving Requests Asynchronously](./resolving-requests-asynchronously.md) for the commit-boundary and retry rules around external **`resolve`** calls.
