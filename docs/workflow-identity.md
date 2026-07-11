# Workflow identity

## What it is

Every workflow declares an **identity block** that answers two questions for globally addressable instances:

1. **What is this instance?** — a typed identity object (the decoded shape of `identity.schema`).
2. **How is it stored?** — `deriveIdempotencyKey` maps that identity to the persisted `idempotency_key` column.

Callers **start** workflows with `args` and `metadata`. Depending on the definition, they also pass an explicit **`identity`** object at start, or the engine derives identity from `args` + `metadata` before persisting the key.

Lookup — on the client (`client.workflows.<def>.get`) and in workflow bodies (`ctx.externalWorkflows.<name>.get`) — always uses the **identity object**, not a raw string key.

```typescript
const orderWorkflow = defineWorkflow({
  name: "process-order",
  args: z.object({ orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  identity: {
    schema: z.object({ tenantId: z.string(), orderId: z.string() }),
    deriveIdentity: ({ args, metadata }) => ({
      tenantId: metadata.tenantId,
      orderId: args.orderId,
    }),
    deriveIdempotencyKey: (id) => `${id.tenantId}:order:${id.orderId}`,
  },
  async execute(ctx) {
    return { ok: true };
  },
});

// Start: args + metadata only (identity derived)
await client.workflows.processOrder.start(session, {
  args: { orderId: "o-42" },
  metadata: { tenantId: "acme" },
});

// Get: by identity object
const handle = client.workflows.processOrder.get({
  tenantId: "acme",
  orderId: "o-42",
});
```

## Declaring identity

The identity block is **required** on `defineWorkflow`, `defineWorkflowHeader`, and flows through `header.extend()` unchanged (it is header-locked — you cannot override it in `.extend({ … })`).

```typescript
identity: {
  schema: z.object({ /* identity fields */ }),
  deriveIdempotencyKey: (identity) => string,
  deriveIdentity?: (input: { args; metadata }) => identity,
}
```

| Field | Required | Role |
| --- | --- | --- |
| `schema` | yes | JSON object schema for the identity value used at `.get(...)` and inside `deriveIdempotencyKey`. |
| `deriveIdempotencyKey` | yes | Maps decoded identity → persisted idempotency key string. |
| `deriveIdentity` | no | When present, the engine builds identity from start `args` + `metadata`; callers must not pass `identity` at start. |

`defineWorkflowHeader` carries the same block so graph references (`childWorkflows`, `externalWorkflows`) share identity semantics before `.implement()`.

## Starting workflows

Start options always include explicit **`args`** and **`metadata`** (pass `undefined` when the schema is `z.undefined()`). They never include `idempotencyKey`.

### Derived identity (`deriveIdentity` present)

Pass only `args` and `metadata`. The engine calls `deriveIdentity`, then `deriveIdempotencyKey`, then persists the instance.

```typescript
await client.workflows.processOrder.start(session, {
  args: { orderId: "o-42" },
  metadata: { tenantId: "acme" },
});
```

### Explicit identity (`deriveIdentity` absent)

Pass **`identity`** alongside `args` and `metadata`. The value must satisfy `identity.schema` input.

```typescript
await client.workflows.auditRun.start(session, {
  args: undefined,
  metadata: undefined,
  identity: { key: "nightly-2026-06-29" },
});
```

The same rules apply to:

- `client.workflows.<def>.execute(...)` (start + wait — same options bag as `.start`)
- `ctx.externalWorkflows.<name>.start(...)` inside workflow and compensation bodies
- Client scheduled delivery and retention fields on the start options bag (alongside `args` / `metadata` / `identity`)

## Looking up instances

`.get(...)` takes a single argument: the **decoded identity** (`identity.schema` output shape).

```typescript
client.workflows.processOrder.get({ tenantId: "acme", orderId: "o-42" });
ctx.externalWorkflows.partner.get({ token: "partner-1" });
```

Handles expose the persisted key as a **read-only** field for logging and operator tools:

```typescript
handle.idempotencyKey; // derived string, e.g. "acme:order:o-42"
```

Database rows and `find` / `count` queries may still filter on `idempotencyKey` as a column. That column is engine-managed output of `deriveIdempotencyKey`, not a start-time caller input.

## Attached child workflows

[Attached children](./child-workflows.md) are parent-scoped. Their start options are `metadata`, optional `seed`, retention, and deadlines — **no `identity` field**. Identity for attached children is positional in the parent body, not a global namespace entry.

Independent roots that need global lookup use [`externalWorkflows`](./external-workflows.md) or client `.start` / `.get` on a registered workflow definition.

## Examples

### Explicit identity (caller supplies identity at start)

```typescript
const nightlyAudit = defineWorkflowHeader({
  name: "nightly-audit",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  identity: {
    schema: z.object({ key: z.string() }),
    deriveIdempotencyKey: (id) => id.key,
  },
});

await client.workflows.nightlyAudit.start(session, {
  args: undefined,
  metadata: undefined,
  identity: { key: "audit-2026-06-29" },
});

client.workflows.nightlyAudit.get({ key: "audit-2026-06-29" });
```

### Derived from args only

```typescript
const fulfillOrder = defineWorkflow({
  name: "fulfill-order",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ shipped: z.boolean() }),
  identity: {
    schema: z.object({ orderId: z.string() }),
    deriveIdentity: ({ args }) => ({ orderId: args.orderId }),
    deriveIdempotencyKey: (id) => `fulfill:${id.orderId}`,
  },
  async execute() {
    return { shipped: true };
  },
});

await client.workflows.fulfillOrder.start(session, {
  args: { orderId: "o-99" },
  metadata: undefined,
});

ctx.externalWorkflows.fulfillOrder.get({ orderId: "o-99" });
```

### Derived from args and metadata

```typescript
identity: {
  schema: z.object({ tenantId: z.string(), orderId: z.string() }),
  deriveIdentity: ({ args, metadata }) => ({
    tenantId: metadata.tenantId,
    orderId: args.orderId,
  }),
  deriveIdempotencyKey: (id) => `${id.tenantId}:${id.orderId}`,
}
```

## Reference

### Start options shape

| `deriveIdentity` | `identity` on start | `idempotencyKey` on start |
| --- | --- | --- |
| declared | must omit | must omit |
| omitted | required | must omit |

### Lookup

| API | Lookup argument |
| --- | --- |
| `client.workflows.<def>.get(...)` | Decoded identity object |
| `ctx.externalWorkflows.<name>.get(...)` | Decoded identity object |
| `client.workflows.<def>.find(...)` | Row predicates (may include `idempotencyKey` column) |

### Header-locked fields

On `defineWorkflowHeader(...).extend({ … })`, these keys cannot be overridden: `name`, `args`, `metadata`, `result`, `errors`, `channels`, **`identity`**.

### Related guides

- [External workflows](./external-workflows.md) — `.start` / `.get` on independent roots inside a workflow body
- [Child workflows](./child-workflows.md) — attached starts without global identity
- [Workflow contract authoring](../header-interface-implementation.md) — header → interface → implementation layering
