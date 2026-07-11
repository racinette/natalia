# Workflow contract authoring: header, interface, implementation

This document describes how workflow contracts are layered and which authoring API to use at each level.

## What you need to start a workflow

Every workflow declares locked fields up front:

- **`name`** — definition name.
- **`args`** — start payload schema. Use `z.undefined()` when the workflow takes no input.
- **`metadata`** — operator/context metadata schema. Use `z.undefined()` when there is none.
- **`result`** — completion schema. Use `z.void()` when the workflow returns nothing meaningful.
- **`identity`** — [workflow identity](./primitives/workflow-identity.md) block (`schema`, `deriveIdempotencyKey`, optional `deriveIdentity`).

Optional maps (`errors`, `channels`, …) follow the same explicit pattern: declare a schema, or omit the slot entirely when the workflow does not use that feature.

When you **start** a workflow — from the client, from an attached child call, or from an external start — pass **`args`** and **`metadata`** in the start options (use `undefined` when the schema is `z.undefined()`). If the workflow has no `deriveIdentity`, also pass **`identity`**. Start options never include `idempotencyKey`. See [Workflow identity](./primitives/workflow-identity.md).

```typescript
await client.workflows.report.start(session, {
  args: { month: "2026-06" },
  metadata: { tenantId: "acme" },
  identity: { tenantId: "acme", month: "2026-06" },
});

await client.workflows.processOrder.start(session, {
  args: { orderId: "o-42" },
  metadata: { tenantId: "acme" },
  // identity derived via deriveIdentity on the definition
});
```

## Three layers

### 1. Header (`defineWorkflowHeader`)

The **minimal graph reference** for a workflow: the locked contract fields above (including **`identity`**), optional **channels**, and optional **errors**.

`defineWorkflowHeader` produces a **`WorkflowReference`**. Use it to break import cycles and to type **`childWorkflows`** / **`externalWorkflows`** slots without pulling in full implementations.

```typescript
const fulfillOrderHeader = defineWorkflowHeader({
  name: "fulfill-order",
  args: z.object({ orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.object({ shipped: z.boolean() }),
  identity: {
    schema: z.object({ tenantId: z.string(), orderId: z.string() }),
    deriveIdentity: ({ args, metadata }) => ({
      tenantId: metadata.tenantId,
      orderId: args.orderId,
    }),
    deriveIdempotencyKey: (id) => `${id.tenantId}:${id.orderId}`,
  },
  channels: {
    expedite: z.object({ priority: z.enum(["normal", "high"]) }),
  },
});
```

### 2. Interface (`defineWorkflowInterface` or `header.extend`)

The **public** contract: everything a client can discover and introspect — streams, events, step *interfaces*, requests, child-workflow references, patches, retention knobs, and so on. No `execute`, no step bodies, no request handlers.

This layer satisfies **`WorkflowHeader`**, the full public contract type used by clients and operator surfaces.

### 3. Implementation (`interface.implement` or `defineWorkflow`)

What the executor runs: concrete **`execute`**, step bodies, request handler registration targets, compensation **`undo`** callbacks, and wiring such as **`externalWorkflows`**.

When a workflow already has a header or interface, call **`.implement({ execute, … })`**. Use **`defineWorkflow({ … })`** directly for self-contained workflows that do not need the layered graph.

## Why `externalWorkflows` is not on the interface

External workflows are **independent roots** you **create** (`.start`) or **reference** (`.get`). Interaction is **send-only** through **channels** — not a typed handle to another workflow's lifecycle.

Declare **`externalWorkflows`** on **`.implement({ externalWorkflows, … })`** so **`ctx.externalWorkflows`** stays an implementation-only surface.

## Authoring hierarchy

Follow **header → interface → implementation** when you want explicit layering and reusable step interfaces.

### `header.extend({ … })`

Move from **header → interface** with **`defineWorkflowHeader(…).extend({ … })`**:

- Header-locked fields (`name`, `args`, `metadata`, `result`, `errors`, `channels`, **`identity`**) cannot appear in the extend payload.
- Runtime rejects any of those keys on the extend object.

The extend payload adds public fields only (streams, events, step interfaces, child-workflow references, …).

### `interface.implement({ … })`

Move from **interface → implementation** with **`.implement({ execute, steps, …, externalWorkflows? })`**.

## Summary

| Layer              | Type (conceptual)   | Role                                                                 |
| ------------------ | ------------------- | -------------------------------------------------------------------- |
| **Header**         | `WorkflowReference` | Minimal graph reference; **channels** are the typed ingress.         |
| **Interface**      | `WorkflowHeader`    | Full public, client-introspectable surface.                          |
| **Implementation** | `WorkflowDefinition`| Runnable graph: `execute`, concrete steps/requests, compensations.   |

**Authoring path:** `defineWorkflowHeader` → `.extend` (additive public fields) → `.implement` (implementation-only extras like `externalWorkflows`).

For required schemas and invocation keys, see [Explicit contracts](./explicit-contracts.md). For identity declaration and start/get lookup, see [Workflow identity](./primitives/workflow-identity.md).
