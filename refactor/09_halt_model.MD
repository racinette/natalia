# 09 Halt Model

## Goal

Establish the halt model for workflows and compensation block instances,
and define the **operator-action verb signatures** (`sigkill()`,
`sigterm()`, `skip(result, opts?)`) at the type level. Step 12 will plug
these signatures onto concrete handles (`WorkflowHandleExternal`,
`CompensationBlockUniqueHandle`).

This step also publishes the durable `HaltRecord` row shape and the
opaque `IWorkflowConnection` / `IWorkflowTransaction` brands that step 19
firms up.

## Source Coverage

- `REFACTOR.MD` Part 3: Halt Model and Operator Actions.
- `REFACTOR.MD` Part 1.6: compensation block instances are themselves
  workflows; one `halt` table covers every workflow kind.
- `REFACTOR.MD` Part 4: per-context throw rules (workflow body / scope
  body share `ctx.errors`; compensation `undo` has none).
- `REFACTOR.MD` Part 19: `IWorkflowConnection` / `IWorkflowTransaction`
  opaque types (forward-declared here, finalised in step 19).

## Public API Target

### Halt status enums

- `WorkflowHaltStatus = "pending" | "resolved"` — execution-workflow
  halts are not skippable directly; the operator must use `skip(...)`
  on the workflow itself, which transitions both the workflow and its
  pending halts to `'skipped'`.
- `CompensationBlockHaltStatus = "pending" | "resolved" | "skipped"` —
  compensation block halts are skippable per instance via
  `skip(result)` on the compensation block handle.

### `HaltRecord`

```typescript
interface HaltRecord {
  readonly id: number;
  readonly workflowId: string;
  readonly afterStepId: number | null;
  readonly status: WorkflowHaltStatus | CompensationBlockHaltStatus;
  readonly errorType: string | null;
  readonly errorMessage: string | null;
  readonly errorStacktrace: string | null;
  readonly errorDetails: JsonInput | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
```

One unified `halt` table covers every workflow kind in the system.
Differences between an execution-workflow halt and a
compensation-block-instance halt are at the operator-action layer
(which actions are available against which workflow kinds), not at the
halt-table layer.

### Operator-action verb signatures

Three terminal-action verbs apply to operator-addressable workflow
rows, modulo the capability matrix below.

```typescript
type SkipStrategy = "sigterm" | "sigkill";

interface OperatorActionOptions {
  readonly txOrConn?: IWorkflowConnection | IWorkflowTransaction;
}

interface SigkillOutcome { readonly status: "terminated"; }
type SigtermOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed" };
interface SkipOutcome { readonly status: "skipped"; }

interface WorkflowOperatorActions<TResult> {
  sigkill(opts?: OperatorActionOptions): Promise<SigkillOutcome>;
  sigterm(opts?: OperatorActionOptions): Promise<SigtermOutcome>;
  skip(
    ...args: [TResult] extends [void]
      ? [opts?: OperatorActionOptions & { strategy?: SkipStrategy }]
      : [
          result: TResult,
          opts?: OperatorActionOptions & { strategy?: SkipStrategy },
        ]
  ): Promise<SkipOutcome>;
}

interface CompensationBlockOperatorActions<TResult> {
  // skip(result) only — no sigkill, no sigterm, no strategy choice.
  // For compensation, skip IS abandonment with an operator-supplied result.
  skip(
    ...args: [TResult] extends [void]
      ? [opts?: OperatorActionOptions]
      : [result: TResult, opts?: OperatorActionOptions]
  ): Promise<SkipOutcome>;
}
```

### Capability matrix (Part 3)

| Workflow kind                  | Globally searchable | `sigkill` | `sigterm` | `skip(result, opts?)`              |
| ------------------------------ | ------------------- | --------- | --------- | ---------------------------------- |
| Execution workflow (root)      | yes                 | yes       | yes       | yes; `strategy` defaults to `"sigterm"` |
| Detached child workflow (root) | yes                 | yes       | yes       | yes; `strategy` defaults to `"sigterm"` |
| Attached child workflow        | no (parent-scoped)  | no        | no        | no                                 |
| Compensation block instance    | no (parent-scoped)  | no        | no        | yes (no opts, no strategy)         |
| Base compensation workflow     | no — engine-managed; not exposed to operators. |   |           |                                    |

Step 12 attaches these verb signatures to the concrete external handles.

### Per-context throw rules (Parts 3 + 4)

| Context                                        | Recognised failure throws                                  | Anything else                |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| Workflow `execute` body                        | `ctx.errors.X(...)` from `defineWorkflow.errors`           | execution halt               |
| Scope body                                     | parent body's `ctx.errors.X(...)`                           | execution halt               |
| Step / request timeout or child workflow failure | return-value union from the awaited entry                | no throw machinery involved  |
| Compensation `undo`                            | none; typed return values via the optional `result` schema | compensation block halt      |

### `IWorkflowConnection` / `IWorkflowTransaction`

Opaque branded types forward-declared here so step 12 can wire
`txOrConn?: IWorkflowConnection | IWorkflowTransaction` onto every IO
method's options bag without circular imports. Step 19 adds the
`client.connection()` / `client.transaction()` constructors and the
acquisition / disposal lifecycle.

## Affected Areas

- `src/types/results.ts` — adds `HaltRecord`,
  `IWorkflowConnection`, `IWorkflowTransaction`, `SkipStrategy`,
  `OperatorActionOptions`, `SigkillOutcome`, `SigtermOutcome`,
  `SkipOutcome`, `WorkflowOperatorActions`,
  `CompensationBlockOperatorActions`. Updates the `WorkflowHaltStatus`
  / `CompensationBlockHaltStatus` JSDoc.

## Acceptance Contract

The paired file `src/types-regression-tests/09_halt_model.ts`
verifies:

1. The two halt status unions match the schema constants exactly
   (`"pending" | "resolved"` for workflows; `"pending" | "resolved" |
   "skipped"` for compensation blocks).
2. `HaltRecord` exposes the documented fields with the documented
   types (numeric ids, nullable `afterStepId`, nullable error fields,
   `Date` timestamps, status union over both halt-status aliases).
3. The workflow body's `ctx.errors` exposes the workflow's declared
   errors; unknown codes are rejected.
4. Compensation `undo` callbacks do not expose `ctx.errors`.
5. `WorkflowOperatorActions<TResult>` exposes
   `sigkill / sigterm / skip` with the documented signatures.
6. `skip` requires the result argument when `TResult` is non-void;
   `skip()` accepts zero data arguments when `TResult = void`.
7. `skip` accepts `{ strategy?: "sigterm" | "sigkill" }`.
8. `CompensationBlockOperatorActions<TResult>` exposes `skip` only;
   `sigkill` and `sigterm` access is rejected.
9. Compensation `skip` rejects the `strategy` option.
10. `OperatorActionOptions.txOrConn` accepts both
    `IWorkflowConnection` and `IWorkflowTransaction`.

## Out of Scope (Deferred)

- Wiring the verb signatures onto concrete handles
  (`WorkflowHandleExternal`, `CompensationBlockUniqueHandle`) — step
  12.
- The `findUnique` / `findMany` / `count` query surface that produces
  those handles — step 12.
- The legacy `sigterm()` / `sigkill()` on `src/types/engine.ts`'s
  workflow handle stays as-is for this step; step 12 sweeps it away
  alongside the unified `WorkflowHandleExternal` landing.
- The `client.connection()` / `client.transaction()` constructors and
  disposal lifecycle — step 19.
- Halt resolution paths at the runtime layer (patch + replay
  resolves; `skip(...)` skips; `sigkill` / `sigterm` archive) —
  documented in REFACTOR.MD Part 3 but not type-testable.
