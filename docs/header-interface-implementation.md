# Workflow contract authoring: header, interface, implementation

This document describes how workflow contracts are layered and which authoring API to use at each level.

## What you need to start a workflow

Every workflow declares four locked fields up front:

- **`name`** — identity.
- **`args`** — start payload schema. Use `z.undefined()` when the workflow takes no input.
- **`metadata`** — operator/context metadata schema. Use `z.undefined()` when there is none.
- **`result`** — completion schema. Use `z.void()` when the workflow returns nothing meaningful.

Optional maps (`errors`, `channels`, …) follow the same explicit pattern: declare a schema, or omit the slot entirely when the workflow does not use that feature.

When you **start** a workflow — from the client, from an attached child call, or from an external start — pass **`args`** and **`metadata`** in the start options. If the schema is `z.undefined()`, pass the key with value **`undefined`**. Omitting the key is a type error.

```typescript
await client.workflows.report.start(session, {
  args: { month: "2026-06" },
  metadata: { tenantId: "acme" },
  idempotencyKey: "report-2026-06",
});

await client.workflows.noop.start(session, {
  args: undefined,
  metadata: undefined,
  idempotencyKey: "noop-1",
});
```

## Three layers

### 1. Header (`defineWorkflowHeader`)

The **minimal graph reference** for a workflow: identity, the locked contract fields above, optional **channels**, and optional **errors** / **idempotencyKeyFactory**.

`defineWorkflowHeader` produces a **`WorkflowReference`**. Use it to break import cycles and to type **`childWorkflows`** / **`externalWorkflows`** slots without pulling in full implementations.

```typescript
const fulfillOrderHeader = defineWorkflowHeader({
  name: "fulfill-order",
  args: z.object({ orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.object({ shipped: z.boolean() }),
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

- Header-locked fields (`name`, `args`, `metadata`, `result`, `errors`, `channels`) cannot appear in the extend payload.
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

For required schemas and invocation keys, see [Explicit contracts](./explicit-contracts.md).
