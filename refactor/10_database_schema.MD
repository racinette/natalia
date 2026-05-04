# 10 Database Schema

## Goal

Establish the durable schema described in `REFACTOR.MD` Part 8 and
publish the schema-derived public type surface that user code and
introspection handles consume.

The persisted layout collapses to a small set of tables:

- one `workflow` table (execution workflows, base compensation
  workflows, attached children, detached children, and compensation
  block instances are all rows here, distinguished by columns);
- one `step` table (with `parent_step_id` self-reference for scopes
  — there is no separate `scope` table);
- one `promise` table;
- one `halt` table covering all workflow kinds;
- the workflow primitive tables (`workflow_attributes`,
  `channel_message`, `stream_record`, `workflow_event`);
- a lightweight `request_compensation_instance` table.

There is **no `branch` table**. Scope nesting is encoded by
`step.parent_step_id` self-references. Compensation block instances
are workflow rows of their own — see `REFACTOR.MD` Part 1.6.

## Source Coverage

- `REFACTOR.MD` Part 8: Database Schema — primary source of truth.
- `REFACTOR.MD` Part 1.6 / Part 2: compensation block instances are
  workflow rows.
- `REFACTOR.MD` Part 3: unified `halt` table.
- `REFACTOR.MD` Part 11: `request_compensation_instance` table.
- `REFACTOR.MD` Part 5: `AttachedChildWorkflowId<W>` brand and the
  attached/detached/foreign distinction realised by the `attached`
  column.

## Public API Target

This step does not change runtime behavior at the type level. It
publishes the schema-derived public type surface so step 12 can
consume row types on operator-facing handles.

### Branded ids

```typescript
type WorkflowId = string & { readonly __brand: "WorkflowId" };
type AttachedChildWorkflowId<W extends AnyWorkflowHeader> = string & {
  readonly __brand: "AttachedChildWorkflowId";
  readonly __workflow: W;
};
type RequestCompensationInstanceId = string & {
  readonly __brand: "RequestCompensationInstanceId";
};
```

`CompensationId<TStep>` already exists from step 08. Together the
four branded id types make every row reference type-distinguishable
at compile time:

| Id type                              | Identifies                                               |
| ------------------------------------ | -------------------------------------------------------- |
| `WorkflowId`                          | any workflow row                                         |
| `AttachedChildWorkflowId<W>`          | a workflow row that is an attached child of a parent     |
| `CompensationId<TStep>`               | a workflow row that is a compensation block instance    |
| `RequestCompensationInstanceId`       | a `request_compensation_instance` row                   |

### Status enums

```typescript
type WorkflowStatus =
  | "pending" | "running" | "completed" | "failed"
  | "terminated" | "halted" | "skipped";

type RequestCompensationStatus =
  | "pending" | "running" | "completed" | "skipped" | "manual";
```

`CompensationBlockStatus` (already published from step 02) plus the
two halt status aliases (step 09) round out the schema-derived
status surface.

### `StepType` literal union

The persisted `step.type` catalog from `REFACTOR.MD` Part 8.7,
exposed as a string literal union:

```typescript
type StepType =
  | "start_step" | "start_child_workflow" | "send_request"
  | "await_promise" | "execute_scope"
  | "sleep" | "sleep_until" | "channel_receive"
  | "channel_receive_nowait" | "patch_check"
  | "stream_write" | "event_set" | "attribute_set"
  | "register_compensation_instance" | "promote_compensation_instance"
  | "queue_enqueue" | "topic_publish" | "channel_send" | "start_detached";
```

There is no `start_branch` type — the legacy entry kind is gone.

### Row record types

```typescript
interface WorkflowRow<TArgs = unknown, TResult = unknown, TMetadata = unknown> {
  readonly id: WorkflowId;
  readonly definitionName: string;
  readonly idempotencyKey: string | null;
  readonly status: WorkflowStatus;
  readonly args: TArgs;
  readonly result: TResult | null;
  readonly metadata: TMetadata;
  readonly error: WorkflowErrorEnvelope | null;
  readonly attached: boolean;
  readonly isCompensation: boolean;
  readonly compensationStepName: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly failedAt: Date | null;
  readonly terminatedAt: Date | null;
  readonly scheduledAt: Date | null;
  readonly deadlineAt: Date | null;
}

interface RequestCompensationRow<TPayload = unknown, TCompResult = unknown> {
  readonly id: RequestCompensationInstanceId;
  readonly requestName: string;
  readonly status: RequestCompensationStatus;
  readonly payload: TPayload;
  readonly result: TCompResult | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly manualAt: Date | null;
  readonly skippedAt: Date | null;
}
```

JSONB columns (`args`, `result`, `metadata`, `error`, `payload`)
are exposed as whole opaque values for `fetchRow` / prefetch
consumption (step 12). Operators project paths inside them via the
search-query namespaces (step 11).

### Promise table — runtime-internal

The `promise` table from `REFACTOR.MD` Part 8 has no public
consumer. It is the engine's awaitable-state ledger plus
`sequence_no` register for deterministic `match` / `join` ordering
(Part 1.5). No public type surface is published for promises.

## Affected Areas

- `src/types/schema.ts` (new file) — branded ids, status enums,
  `StepType`, row records.
- `src/types.ts` — re-exports `./types/schema`.
- The runtime persistence layer (migration files, repository code)
  is out of scope for the type-level acceptance contract; it is
  realised separately when implementation work resumes.

## Acceptance Contract

The paired file `src/types-regression-tests/10_database_schema.ts`
verifies:

1. `WorkflowId`, `AttachedChildWorkflowId<W>`,
   `RequestCompensationInstanceId` are branded strings — plain
   strings are not assignable.
2. `AttachedChildWorkflowId<W>` brand separates ids from different
   workflow headers at the type level.
3. `WorkflowStatus`, `RequestCompensationStatus`,
   `CompensationBlockStatus`, `WorkflowHaltStatus`,
   `CompensationBlockHaltStatus` match REFACTOR.MD's check
   constraints exactly.
4. `StepType` is a literal union of the 19 documented step kinds;
   `"start_branch"` is rejected.
5. `WorkflowRow<TArgs, TResult, TMetadata>` exposes the documented
   field shapes with JSONB columns typed against the supplied
   schemas.
6. `WorkflowRow` has sensible `unknown` defaults when used without
   binding generics.
7. `RequestCompensationRow<TPayload, TCompResult>` mirrors the SQL
   row shape.
8. `HaltRecord.status` accepts both halt-status aliases.

## Out of Scope (Deferred)

- Wiring row types onto operator-facing handles
  (`WorkflowHandleExternal`, `CompensationBlockUniqueHandle`,
  request-compensation handle, attached-child external handle) —
  step 12.
- The unified `QueryableNamespace<...>` /
  `FetchableHandle<TRow>` / `findUnique` / `findMany` / `count`
  surface that consumes the row types — step 12.
- The search-query namespace generalization
  (`row` / `args` / `result` / `metadata` / `error` / `payload`
  namespaces) — step 11.
- Promise-row introspection (no public surface in the current
  spec).
- SQL migration files / repository code — runtime work; not
  type-testable.
