# 17 Workflow contract layers (`WorkflowInterface`, `implement`, `extend`)

## Goal

Public layering so cycle-safe **`WorkflowReference`** graph edges do not force weak client/operator typing, while workers keep a single **`defineWorkflow`** implementation path.

| Layer | Role |
|-------|------|
| **`defineWorkflowHeader`** | Minimal graph-safe **`WorkflowReference`** (unchanged authoring name). |
| **`defineWorkflowInterface`** | **`WorkflowInterface`** — full declarative **public** contract (streams, events, children, requests, step interfaces, …) **without** `execute` / step bodies. Built via **`header.extend({ … })`** or standalone. **`external`** is **not** on the interface — pass it on **`.implement({ external, … })`** (implementation-only, for `ctx.external`). |
| **`defineStepInterface`** | **`StepInterface`** — step contract without `execute` / `undo`. |
| **`.implement(...)`** | Produces concrete **`WorkflowDefinition`** / **`StepDefinition`**, type-checked against the interface. |

## Naming (implemented)

| Type | Role |
|------|------|
| **`WorkflowContractCore`** | Shared locked slice: `name`, `args`, `metadata`, `result`, optional `errors`, optional `idempotencyKeyFactory`. |
| **`WorkflowReference`** | Graph-safe reference for `childWorkflows` / `externalWorkflows` slots (`defineWorkflowHeader` return type). Optional `channels`. |
| **`WorkflowHeader`** | Full public workflow contract for clients and operator surfaces (`WorkflowInterface`, `WorkflowDefinition`). Adds optional `streams`, `events`, `attributes`. |
| **`AnyWorkflowReference`** | Wide bound for graph edges. |
| **`AnyWorkflowHeader`** | Wide bound for client registry / handles. |

`WorkflowReference` is assignable to the core slice of `WorkflowHeader`; it does not carry header-only slots (`streams`, `events`, `attributes`).

## Explicit contract fields (implemented)

Every workflow authoring surface requires **explicit** schemas — no omission fallbacks:

- **`args`**, **`metadata`**, and **`result`** are required on `defineWorkflowHeader`, `defineWorkflowInterface`, and `defineWorkflow`.
- Use **`z.undefined()`** for empty args or metadata; use **`z.void()`** for an empty result.
- **Invocation** (client `.start`, attached child call, external `.start`) requires an options bag with explicit **`args`** and **`metadata`** keys. When the schema decodes to `undefined`, pass **`undefined`** — omitting the key is a type error.

Compensation blocks mirror the same explicitness:

- Step **`compensation.result`** is required (`z.void()` when there is no structured return).
- Request **`compensation: { result, errors? }`** — bare **`compensation: true`** and `{ errors }` without **`result`** are rejected.

Regression anchor: `src/types-regression-tests/21_explicit_contracts.ts`.

## Authoring chain

```text
header  →  interface  →  workflow (implement)
              ↑
         step interfaces  →  step (implement), reused across workflows
```

- Step **`implement`** values should be **named constants** and **referenced** from `workflowInterface.implement({ steps: { … } })`, not inlined in the workflow `implement` object (reusability).

## Client vs introspection

- Prefer typing the **client registry** with **`WorkflowInterface`** or full **`WorkflowDefinition`**, not a header-only registry repaired with **`extend`** everywhere.
- **`extend`** exists **only** for handles whose **declared type parameter** is still graph-minimal: a **`WorkflowReference`** from **`defineWorkflowHeader`** (carries `__nataliaAuthoringKind: "header"`). Example: an attached-child operator handle when the parent graph stored only the child **reference** — call **`child.extend(bInterface)`** (or pass a full **`bWorkflow`**) to recover streams / compensations typing **without** a second fetch. (**`external`** is not part of **`WorkflowInterface`**; it does not appear on client-facing interface objects.)
- **`extend` is not the primary client story** — do not document `client.workflows.*.get(...).extend(...)` as the main pattern.

## `extend` rules (strict, type-parameter phrasing)

1. **`extend`** appears only when the handle’s **type parameter** is header-derived (`IsHeaderAuthoringKind<W>` is true — today: `defineWorkflowHeader` return value).
2. Handles parameterized by **`WorkflowDefinition`** or **`WorkflowInterface`** **must not** expose a usable **`extend`** (the slot is `extend?: never`).

The only deliberate **weak** workflow edge in the graph is **`WorkflowReference`** (plus **`AnyWorkflowHeader`** as a **fallback** when the parent type does not carry structured `children` — a **typing limitation**, not a second concept).

## Structural compatibility (acceptance)

Regression tests must prove alignment **without** relying solely on `.implement()` as the bridge — see `src/types-regression-tests/13_workflow_interface.ts` (`AssertAssignable` on a declarative surface vs `defineWorkflow`, `@ts-expect-error` rows, and **typed `execute` / `ctx.scope` bodies** that exercise `WorkflowContext` and `WorkflowConcurrencyContext`).

## Dependencies

- **`CompensationBlockPrimitivePlane`** still uses **`Record<string, unknown>`** for external compensation handles in this milestone; threading **`StepCompensationDefinition`** primitives for external compensation is a later step.

## Success

- `pnpm typecheck`
- `src/types-regression-tests/13_workflow_interface.ts` — structural triple, `extend` on header-derived child handles, authoring-kind assertions, named step `implement`.
- `src/types-regression-tests/21_explicit_contracts.ts` — explicit invocation options, required compensation `result`, `WorkflowReference` ⊂ `WorkflowHeader` hierarchy.
