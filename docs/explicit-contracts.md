# Explicit workflow and compensation contracts

Workflow and compensation authoring require **explicit schemas** at definition time and **explicit keys** at invocation time. There are no omission fallbacks for empty slots.

## Definition time

Every workflow — whether created with `defineWorkflowHeader`, `defineWorkflowInterface`, or `defineWorkflow` — must declare:

| Field | When empty | Example |
| --- | --- | --- |
| **`args`** | No start payload | `z.undefined()` |
| **`metadata`** | No operator metadata | `z.undefined()` |
| **`result`** | No meaningful completion value | `z.void()` |
| **`identity`** | Always required — see [Workflow identity](./primitives/workflow-identity.md) | `schema` + `deriveIdempotencyKey`; optional `deriveIdentity` |

Optional maps (`errors`, `channels`, `streams`, …) stay optional: omit the slot when the workflow does not use that feature.

Compensable **steps** and **requests** declare an explicit **`compensation.result`** schema. Use **`z.void()`** when `undo` / the compensation handler has no structured return.

```typescript
const notify = defineStep({
  name: "notify",
  args: z.object({ id: z.string() }),
  result: z.object({ sent: z.boolean() }),
  compensation: {
    result: z.void(),
    async undo(_ctx) {
      return undefined;
    },
  },
  async execute(ctx) {
    return { sent: true };
  },
});

const reserve = defineRequest({
  name: "reserve",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.object({ released: z.boolean() }),
  },
});
```

Request compensation is always **`compensation: { result, errors? }`**. Register the handler on the client; the definition does not accept inline `undo`.

## Invocation time

Starts and attached child calls require an options bag with explicit **`args`** and **`metadata`**. When the schema decodes to `undefined`, pass the key with value **`undefined`**. Globally addressable starts also follow [workflow identity](./primitives/workflow-identity.md): pass **`identity`** when the definition has no `deriveIdentity`; omit `identity` when `deriveIdentity` is declared. Start options never include `idempotencyKey`.

```typescript
// Client root start — explicit identity (no deriveIdentity on definition)
await client.workflows.report.start(session, {
  args: { month: "2026-06" },
  metadata: { tenantId: "acme" },
  identity: { tenantId: "acme", month: "2026-06" },
});

await client.workflows.noop.start(session, {
  args: undefined,
  metadata: undefined,
  identity: { key: "noop-1" },
});

// Client root start — derived identity (deriveIdentity on definition)
await client.workflows.processOrder.start(session, {
  args: { orderId: "o-1" },
  metadata: { tenantId: "acme" },
});

// Attached child (inside execute)
await ctx.childWorkflows.processOrder(
  { orderId: "o-1" },
  { metadata: undefined },
);

// External root start — derived identity on target
await ctx.externalWorkflows.reconcile.start(
  { window: "2026-06-29" },
  { metadata: undefined },
);
```

Child calls always pass a second argument (the start-options bag). Execution deadlines (`deadlineSeconds` / `deadlineUntil`) belong in that same bag together with **`metadata`**.

## Header layering

Graph references use **`WorkflowReference`** (`defineWorkflowHeader`). The full public contract is **`WorkflowHeader`** (`WorkflowInterface`, `WorkflowDefinition`). See [Workflow contract authoring](./header-interface-implementation.md) for the header → interface → implementation chain.

## Type regression

`src/types-regression-tests/21_explicit_contracts.ts` locks invocation and compensation rules. `src/types-regression-tests/20_contract_layer_wiring.ts` covers interface `.implement()` wiring with explicit schemas.

See the [documentation index](./README.md) for primitive guides and divergence trackers.
