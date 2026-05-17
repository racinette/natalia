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

When a handler (or its **`onExhausted`** callback) returns **`MANUAL`**, the request enters **manual mode** and stays open until **`client.requests.<name>.resolve(...)`** supplies the response (or the invocation is cancelled). Failed handler tries are persisted on the request’s attempt log (**failed tries only** on the handler side—see `AttemptAccessor`).

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

**Compensable request** — declare on the definition; register the compensation handler separately

```typescript
const refundCharge = defineRequest({
  name: "refundCharge",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ refundId: z.string() }),
  compensation: {
    result: z.object({
      kind: z.enum(["refunded", "charge_not_found", "operator_resolved"]),
      note: z.string().optional(),
    }),
  },
});

client.registerRequestCompensationHandler(
  refundCharge,
  async (payload, info, { signal }) => {
    if (info.status === "completed") {
      await reverseRefund(payload.chargeId, info.response.refundId, { signal });
      return { kind: "refunded" as const };
    }
    return {
      kind: "operator_resolved" as const,
      note: "forward request unsettled",
    };
  },
  { retryPolicy: { timeoutSeconds: 30 } },
);
```
