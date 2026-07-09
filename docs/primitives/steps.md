# Steps

## What it is

A **step** is a **named unit of side-effecting work** the engine runs **outside** the workflow’s `execute` coroutine: talk to APIs, databases, queues, subprocesses—anything that must not be re-simulated line-by-line on every replay. You define it once with **schemas for arguments and result**, plus an **`execute` function** that receives the decoded args and an **opts** object (including an **abort signal**), and returns a value matching the result schema.

The workflow **does not** embed that implementation in its body. Instead it **dispatches** a step: `ctx.steps.<name>(...)` yields an **entry** you **await** (or hand to structured helpers such as `ctx.scope`). The engine records the call; **the same worker that is executing the workflow runs the step’s `execute`**, persists the outcome, and on replay **replays the recorded result** instead of calling your integration again.

#### Retry at definition vs call site

On the **step definition**, optional **`retryPolicy`** sets **how** to retry (interval, backoff, per-attempt `timeoutSeconds`) — not **when to stop**. A step is expected to **retry until `execute` returns successfully** unless the **caller** caps the run. At the **call site**, pass **`{ retry: … }`** to override that strategy and **`{ timeout: … }`** (seconds, deadline, or `maxAttempts`) when this invocation must not wait forever. The caller is in a better position to decide whether a timeout or attempt cap is acceptable.

### Compensable steps

A step may optionally carry a **`compensation`** block on the **same definition** as `execute`. That declares how to **undo or reconcile** the forward work when the engine schedules compensation: a dedicated **`undo`** callback receives a **compensation** `ctx` (not the workflow body’s `ctx`), the **original step args**, and **`info`** summarizing the forward path’s terminal shape—**completed** (with a persisted result row), **timed out** without a settled result, or **terminated**. You **return** an optional typed outcome when the block declares a **`result`** schema; there is no workflow-local `ctx.errors` inside `undo`.

#### When `undo` runs (attempts vs I/O)

Compensation runs **if and only if** the forward step has **at least one execution attempt** persisted. **If you are inside `undo`, that condition already holds**—there is nothing to re-check.

That attempt can be recorded even when your process died **before** any outbound I/O ran, so **you may be in `undo` with no external side effect.** **Forward `execute` must be idempotent** (safe to run again for the same attempt identity your gateway or datastore understands). **`undo` must tolerate “maybe nothing to reverse”**: design release, void, or reconcile calls so a second invocation is harmless, and branch using evidence below—not a single boolean—before doing irreversible work.

#### Deciding what to undo: `info.status` and `info.attempts`

**`info.status`** is how the forward step **settled** from the engine’s point of view:

- **`completed`** — `execute` **returned successfully** and the result was persisted. On that code path, the side effect your step author defined **did run** (the charge call returned, the row was written, and so on).
- **`timed_out`** / **`terminated`** — no successful return was recorded.

That is reliable for **your process and your step code**. It is **not** always enough to decide whether **remote state** changed when the integration is a request–response mutation over the network.

The painful case is a **POST that may have landed** while the client never saw a body: the server applies the mutation, then response serialization fails or the connection drops before your `execute` can return. The engine may record **`timed_out`** (or keep retrying) even though **remote state may already be mutated**. Once an attempt **could have reached** the server, you generally **cannot** treat “we never changed anything” as safe unless the API **explicitly rejected** the change by convention (clear 4xx, idempotent “already exists,” and similar). **`undo` should assume reversal may be needed** unless attempt evidence says otherwise.

The contrasting case is when **every failed attempt failed before the request could reach the server**—for example each attempt is **network unreachable**, DNS failure, or connection refused with no bytes accepted. Then you can often conclude **the remote system was never contacted** and **skip destructive undo** (or keep it to logging), because no mutation channel was opened.

**`info.attempts`** is the forward step’s **execution attempt history** (`count()` is always at least **1** in `undo`). Each record has `message`, `type`, and `details` when the try failed in a captured way; successful tries are present too (for steps). Use **`info.status`** together with those records: status says whether the step **returned**; attempts help you judge **reachability** and **whether compensation work is proportionate**. Do not branch on **`if (info.status === "completed")` alone** when deciding how aggressive reversal should be—read whether tries look like **pre-reach** transport errors vs **post-reach** ambiguity.

#### The `undo` body

Treat **`undo` like a workflow `execute` body** for this compensation invocation: sequential code, the same **`ctx`** primitives, the same **`await`**-dispatched **steps** and **requests**. The compensation block **must declare every action up front**—`steps`, `requests`, `queues`, `topics`, `children`, `external`, and optional per-instance **`channels`**, **`streams`**, **`events`**, **`attributes`** on **this** block. What you list is what you may call; nothing is implied.

**Steps and requests** in that list must be **non-compensable**. If they could carry their own compensation, you would get compensations of compensations without a fixed bottom. Every other primitive is available **whenever the undo path needs it**: append to a **stream**, set an **event** or **attribute**, **publish**, **enqueue**, message a **child** or **external** workflow, and so on—same as in ordinary workflow code.

**Human-in-the-loop** is a common pattern, not a separate subsystem: automatic undo fails or the situation is ambiguous (for example a hotel-cancel step failed with an unknown error), so **`undo` awaits a non-compensable `request`** and blocks until a person or external resolver returns a typed response—often inside a **`while` loop** that retries a **step** when the operator says to try again. That is one use of **requests** alongside **steps** and the rest; pick whichever primitives fit the rollback you are modeling.

#### How `undo` differs from `workflow.execute`

Similar surface, different failure and outcome model:

- **No `errors` on the compensation block.** A workflow declares **`errors`** and may **`throw ctx.errors.X(...)`** to fail the run in a typed, caller-visible way. **`undo` has no `ctx.errors`**—it cannot “error out” of the compensation block that way.
- **Only three ways out:** reach a normal **`return`**, be **`skip`ped** from the outside on the compensation block handle (client: look up the instance inside `client.session` and call **`.skip(session, …)`** with an operator-supplied outcome when the block declares a **`result`** schema), or **halt**. An **unhandled throw inside `undo` does not fail the parent workflow**—it **halts** the compensation block instance until the underlying issue is fixed (patch/replay) or an operator intervenes.
- **Optional `compensation.result` schema.** When declared, **`return`** values are persisted as the **summary of that compensation run**—for admins scanning a case or for queries over compensation rows. They are **not** consumed by the parent workflow body the way a step or workflow **result** is; they are **documentation of how undo settled**.
- **Streams (and similar) for progress, not for the outcome.** Append to a **stream** (or set an **attribute**, and so on) to make **rollback progress observable** while `undo` is still running. The **return value** (when you declare **`result`**) is the compact **final summary**; the stream is the **timeline**.

#### Awaiting steps from `undo`

**`await ctx.steps.X(...)` never throws a step failure.** On success you get the step’s **result** type directly. If you need to react when retries are exhausted, pass **`{ timeout: ... }`** on the call: the awaited value becomes **`{ ok: true; result: T } | { ok: false; status: "timeout" }`**. Branch on **`ok`** and on fields inside **`result`** (for example `released: false` on HTTP 200)—not on **`try/catch`**.

## Why it exists

Workflow code is **durable and replayed**; ordinary network and I/O inside `execute` would either be unsafe to repeat or would force every reader to reason about idempotency by hand. Steps **lift integration out** into a first-class, observable unit: typed args and results, attempt history, retries, and optional undo work live with the definition. The body stays a **sequential script** that decides _when_ to call _which_ step and how to interpret success or failure.

### Why compensation lives on the step

Pairing **forward `execute`** with **`compensation.undo`** next to it makes the saga leg obvious in one place: readers see the external effect and every declared rollback action (automatic **steps**, **streams**, **requests**, and the rest) in one definition. The engine runs each compensation invocation as its **own** durable slice of work with that explicit dependency surface, instead of inferring rollback from ad hoc `catch` blocks inside the workflow coroutine.

## What it is NOT

- **Not** arbitrary code hidden inside the workflow body: the integration lives in the step’s `execute`, where the platform can schedule, retry, and record it.
- **Not** a void side effect at the call site: you obtain an **awaitable entry** and observe a **typed result** (or a failure the workflow’s error model can handle).
- **Not** untyped or invisible at the persistence boundary: arguments and results are **schema-constrained** so the engine can serialize and surface them.
- **Not** a place to use the workflow logger: use your **application** logging inside `execute`; workflow-level logging stays on `ctx.logger` in the body.
- **Not** a compensable **step** listed under `compensation.steps` on another step: dependency steps must be **non-compensable**, otherwise compensation can recurse without a base case.
- **Not** a place for **`ctx.errors` or workflow-style failure throws**: unhandled exceptions **halt** the compensation block; they do not surface as declared workflow errors.

## Examples

**Defining a step**

```typescript
const reserveInventory = defineStep({
  name: "reserveInventory",
  args: z.object({ sku: z.string(), quantity: z.number() }),
  result: z.object({ reservationId: z.string() }),
  retryPolicy: { intervalSeconds: 2, backoffRate: 1.5 },
  async execute(args, { signal }) {
    const res = await fetch("https://warehouse.example/v1/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal,
    });
    if (!res.ok) {
      throw new Error(`warehouse returned ${res.status}`);
    }
    return res.json();
  },
});
```

**Awaiting a step from a workflow** (no `timeout` → result type directly)

```typescript
const fulfillOrder = defineWorkflow({
  name: "fulfill-order",
  args: z.object({ sku: z.string(), quantity: z.number() }),
  steps: { reserveInventory },
  result: z.object({ reservationId: z.string() }),
  async execute(ctx) {
    const { reservationId } = await ctx.steps.reserveInventory({
      sku: ctx.args.sku,
      quantity: ctx.args.quantity,
    });
    return { reservationId };
  },
});
```

**Awaiting a step with `timeout`** (union result — branch on `ok`, not `try/catch`)

```typescript
const reservation = await ctx.steps.reserveInventory(
  { sku: ctx.args.sku, quantity: ctx.args.quantity },
  { timeout: { maxAttempts: 5, seconds: 30 } },
);

if (!reservation.ok) {
  throw ctx.errors.ReservationFailed("Warehouse did not confirm in time", {
    sku: ctx.args.sku,
  });
}

const { reservationId } = reservation.result;
```

**Non-compensable step used inside another step’s `undo`**

```typescript
const releaseGatewayHold = defineStep({
  name: "releaseGatewayHold",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ released: z.boolean() }),
  async execute(args, { signal }) {
    const res = await fetch(
      `https://payments.example/v1/charges/${args.chargeId}/release`,
      { method: "POST", signal },
    );
    const body = (await res.json()) as { released: boolean };
    if (!res.ok) {
      throw new Error(`release returned ${res.status}`);
    }
    return body;
  },
});
```

**Compensable step** — `compensation.result` for the admin-facing summary; **stream** for progress; **`while` + request** when the operator may retry a release **step**

```typescript
// operatorRecoverChargeCompensation — non-compensable request, declared separately
// (response includes whether the operator wants another release attempt)

const chargeCard = defineStep({
  name: "chargeCard",
  args: z.object({
    cents: z.number(),
    customerId: z.string(),
    gatewayIdempotencyKey: z.string(),
  }),
  result: z.object({ chargeId: z.string() }),
  retryPolicy: { intervalSeconds: 2, backoffRate: 1.5 },
  compensation: {
    streams: {
      undoAudit: z.object({ phase: z.string(), detail: z.string() }),
    },
    steps: { releaseGatewayHold },
    requests: { operatorRecoverChargeCompensation },
    result: z.object({
      status: z.enum(["skipped", "released", "manual_review"]),
      chargeId: z.string().optional(),
      note: z.string().optional(),
    }),
    async undo(ctx, args, info) {
      const audit = (phase: string, detail: string) => {
        ctx.streams.undoAudit.write({ phase, detail });
      };

      if (info.status !== "completed") {
        const forwardAttempts = await info.attempts.find();
        const onlyPreReach = forwardAttempts.every(
          (a) =>
            a.type === "NetworkError" ||
            a.message?.includes("ECONNREFUSED") === true,
        );

        if (onlyPreReach) {
          audit("skipped", "forward never reached payment gateway");
          return { status: "skipped" as const };
        }

        const resolution = await ctx.requests.operatorRecoverChargeCompensation(
          {
            customerId: args.customerId,
            cents: args.cents,
            gatewayIdempotencyKey: args.gatewayIdempotencyKey,
            phase: "forward_unsettled",
            detail:
              info.status === "timed_out" ? info.reason : "forward terminated",
          },
        );

        return {
          status: "manual_review" as const,
          note: resolution.note,
        };
      }

      const { chargeId } = info.result;

      while (true) {
        audit("release_attempt", chargeId);

        const release = await ctx.steps.releaseGatewayHold(
          { chargeId },
          { timeout: { maxAttempts: 3, seconds: 30 } },
        );

        if (release.ok && release.result.released) {
          audit("released", chargeId);
          return { status: "released" as const, chargeId };
        }

        const resolution = await ctx.requests.operatorRecoverChargeCompensation(
          {
            customerId: args.customerId,
            cents: args.cents,
            gatewayIdempotencyKey: args.gatewayIdempotencyKey,
            phase: release.ok ? "release_refused" : "release_timeout",
            detail: release.ok
              ? "gateway returned released:false"
              : "release step timed out",
            chargeId,
          },
        );

        if (resolution.action === "retry_release") {
          continue;
        }

        return {
          status: "manual_review" as const,
          chargeId,
          note: resolution.note,
        };
      }
    },
  },
  async execute(args, { signal }) {
    const res = await fetch("https://payments.example/v1/charges", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": args.gatewayIdempotencyKey,
      },
      body: JSON.stringify({
        cents: args.cents,
        customerId: args.customerId,
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`payment returned ${res.status}`);
    }
    return res.json();
  },
});
```
