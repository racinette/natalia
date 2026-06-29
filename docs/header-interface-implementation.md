# Workflow contract authoring: header, interface, implementation

This document captures a **design opinion** for how workflow contracts are layered and how authoring APIs should steer callers toward the right layer—without forbidding simpler styles when that’s intentional.

## What you need to *start* a workflow

To start a workflow instance you need, at minimum:

- `**name`** — identity.
- `**args**`, `**result**`, `**errors**`, `**metadata**` — start payload, terminal contract, failure surface, and optional start metadata (each may be absent only when that omission is deliberate).
- `**channels**` — the supported way to **communicate with** a running workflow from outside its body. They are the practical “way in” for orchestration and for child↔parent style interaction.

## Three layers (conceptual)

### 1. Header (`defineWorkflowHeader`)

The **minimal** contract something needs in order to **reference** or **start** a child workflow from inside another workflow’s `execute` (or a step’s `undo`, etc.): identity + start/result/errors/metadata surface + **channels**.

Headers exist to break cycles, keep a single source of truth for identity and channel names, and type **references** (`childWorkflows`, `externalWorkflows` slots) without pulling in full implementations.

### 2. Interface (`defineWorkflowInterface` or `header.extend`)

The **public** contract of a workflow: everything that can be **declared** and **introspected** by a client—streams, events, step *interfaces*, requests, childWorkflows slots, patches, RNG, retention knobs, etc.

This is the layer meant for **discovery and typing** of “what exists on the wire / in the product API,” not for implementation bodies.

### 3. Implementation (`defineWorkflow` or `interface.implement`)

What is required to **run** the workflow as the executor: concrete `execute`, step bodies, request handlers, compensations’ `undo` / `externalWorkflows`, and any wiring that only the runtime needs.

## Why `externalWorkflows` is not on the interface

`externalWorkflows` are intentionally **not** part of the public interface.

External workflows are **independent roots you create (`.start`) or reference (`.get`)**: interaction is **send-only**, through **channels**, not a typed handle to another workflow’s lifecycle. The executor does not get a meaningful, stateful notion of whether that peer is alive, failed, completed, or ever existed—only the ability to emit into the void. Surfacing `externalWorkflows` on the public interface would conceptually invite an idea of **lifecycle coupling** between unrelated workflows, which is hard to implement well and often not meaningful.

Declare `**externalWorkflows` on `.implement({ externalWorkflows, … })`** so `ctx.externalWorkflows` stays an **implementation-only** surface.

## Authoring hierarchy (optional but strict when you use it)

You may:

- Follow the **header → interface → implementation** chain when you want explicit layering and maximum clarity, or
- **Skip** it and use `**defineWorkflow({ … })`** alone when a single object is preferable.
- Start with any level of the hierarchy.

When you *do* follow the hierarchy, the opinion is: **additive only, never overriding** a more general slice with a more specific one by accident.

### `header.extend({ … })`

Moving from **header → interface** should not be “spread the header and hope the next object is consistent.” That pattern makes it too easy to:

- Skip declaring interface-only fields and still pass a header-shaped object into APIs that expect a richer contract, or
- **Override** `name`, `args`, `channels`, etc. by mistake via object spread.

`**defineWorkflowHeader(…).extend({ … })*`* is the preferred bridge:

- At the **type** level, header-locked fields (`name`, `channels`, `args`, `metadata`, `result`, `errors`) are not legitimate inputs to `.extend()`.
- At **runtime**, passing any of those keys on the extend object is an **error** (fail fast)—not silently dropped.

The extend payload is only the **additive** public fields (streams, events, steps as interfaces, childWorkflows references, …).

### `interface.implement({ … })`

The interface → implementation step remains `**.implement({ execute, steps, …, externalWorkflows? })`**, keeping implementation-only wiring off the public interface type.

## Escape hatch

`**defineWorkflow({ …header fields…, execute, … })**` remains valid for teams that want one object or for cases where the layered API does not pay for itself. The hierarchy is a **discipline**, not a prison.

## Summary


| Layer              | Role                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| **Header**         | Minimal contract to reference/start a child; **channels** are the typed ingress. |
| **Interface**      | Public, client-introspectable surface (streams, events, …).                      |
| **Implementation** | Runnable graph: `execute`, concrete steps/requests, `externalWorkflows`, compensations.   |


**Opinionated authoring path:** `defineWorkflowHeader` → `**.extend`** (additive, locked header slice) → `**.implement**` (implementation-only extras like `externalWorkflows`). Use plain `defineWorkflow` when you deliberately want a single-shot definition.