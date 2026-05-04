import type { JsonInput } from "./json-input";
import type { AnyWorkflowHeader } from "./definitions/workflow-headers";

// =============================================================================
// SCHEMA-DERIVED PUBLIC TYPES
//
// `REFACTOR.MD` Part 8 describes the durable database schema. This module
// publishes the public type surface that mirrors the schema:
//
//   - branded ids (`WorkflowId`, `AttachedChildWorkflowId<W>`,
//     `RequestCompensationInstanceId`);
//   - status unions (`WorkflowStatus`, `RequestCompensationStatus`);
//   - the `StepType` literal union (the persisted `step.type` catalog);
//   - row record types (`WorkflowRow`, `WorkflowErrorEnvelope`,
//     `RequestCompensationRow`).
//
// Step 12 wires the row types onto operator-facing introspection handles via
// the unified `QueryableNamespace<...>` and `FetchableHandle<TRow>` shapes.
// =============================================================================

// =============================================================================
// BRANDED IDS
// =============================================================================

/**
 * Branded opaque public id for a workflow row.
 *
 * Workflow rows have a primary `id: TEXT PRIMARY KEY` per `REFACTOR.MD`
 * Part 8. The brand differentiates them from arbitrary strings and from the
 * other id types (`AttachedChildWorkflowId<W>`, `CompensationId<TStep>`,
 * `RequestCompensationInstanceId`) at the type level.
 *
 * Operators rarely address workflows by `WorkflowId` directly — they use
 * `idempotencyKey`, `args` (when an `idempotencyKeyFactory` is declared), or
 * one of the parent-scoped namespaces. The brand exists for symmetry with the
 * other id types and to keep workflow ids type-distinguishable from plain
 * strings.
 */
export type WorkflowId = string & { readonly __brand: "WorkflowId" };

/**
 * Branded opaque public id for an attached child workflow.
 *
 * Internally an `AttachedChildWorkflowId<W>` is a workflow id; externally the
 * brand keeps attached-child ids separate from regular workflow ids and
 * from compensation block ids. The `__workflow` phantom prevents ids from
 * different child-workflow definitions being assignable to each other.
 *
 * Per `REFACTOR.MD` Part 5, attached children have no `idempotencyKey`;
 * they are addressable only via the parent workflow's
 * `attachedChildWorkflows.<name>` namespace (step 12).
 */
export type AttachedChildWorkflowId<W extends AnyWorkflowHeader> = string & {
  readonly __brand: "AttachedChildWorkflowId";
  readonly __workflow: W;
};

/**
 * Branded opaque public id for a request compensation invocation row.
 *
 * Request compensations are lightweight observable entities (no per-instance
 * primitives, no halts) — `REFACTOR.MD` Part 11. The brand keeps these ids
 * type-distinguishable from workflow ids and other compensation ids.
 */
export type RequestCompensationInstanceId = string & {
  readonly __brand: "RequestCompensationInstanceId";
};

// =============================================================================
// STATUS UNIONS
// =============================================================================

/**
 * Durable status of a workflow row.
 *
 * `'skipped'` is reachable only on compensation block instances and on root
 * workflows skipped via `skip(...)` (step 09). Execution workflows that
 * terminate via `sigkill` / `sigterm` reach `'terminated'` / `'completed'` /
 * `'failed'`. Halted workflows sit at `'halted'` until patch + replay or
 * `skip(...)` resolves them.
 */
export type WorkflowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "terminated"
  | "halted"
  | "skipped";

/**
 * Durable status of a request compensation invocation.
 *
 * `'manual'` reflects that the request compensation handler returned `MANUAL`
 * (or no handler is registered) — the operator must resolve the invocation
 * externally.
 */
export type RequestCompensationStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "manual";

// =============================================================================
// STEP TYPE CATALOG
// =============================================================================

/**
 * The persisted `step.type` catalog, mirroring `REFACTOR.MD` Part 8.
 *
 * Each persisted step row records one of these types. The categories from
 * Part 1.2 (buffered / dispatched / awaitable wait / awaitable read) are an
 * external classification on top of this catalog; they are not separate
 * persisted columns.
 */
export type StepType =
  // Dispatched.
  | "start_step"
  | "start_child_workflow"
  | "send_request"
  // Dispatched-await (the parking step that pairs with a dispatched start).
  | "await_promise"
  // Structural (scope nesting via `step.parent_step_id` self-reference).
  | "execute_scope"
  // Awaitable waits.
  | "sleep"
  | "sleep_until"
  | "channel_receive"
  // Awaitable reads.
  | "channel_receive_nowait"
  | "patch_check"
  // Buffered.
  | "stream_write"
  | "event_set"
  | "attribute_set"
  | "register_compensation_instance"
  | "promote_compensation_instance"
  | "queue_enqueue"
  | "topic_publish"
  | "channel_send"
  | "start_detached";

// =============================================================================
// ROW RECORD TYPES
//
// Step 12 plugs these onto operator-facing handles via FetchableHandle<TRow>.
// =============================================================================

/**
 * Workflow-row error envelope. Populated when a workflow transitions to
 * `'failed'` either via an `ExplicitError` thrown from the body or via the
 * legacy non-explicit serialisation path.
 *
 * Step 12 may extend this with per-workflow declared error typing
 * (`ErrorValue<TErrors>`) when consumed via `WorkflowQueryNamespaces`.
 */
export interface WorkflowErrorEnvelope {
  readonly type: string | null;
  readonly message: string | null;
  readonly details: JsonInput | undefined;
}

/**
 * Flat scalar columns of a workflow row, parameterised over the workflow's
 * args / result / metadata schemas.
 *
 * The JSONB columns (`args`, `result`, `metadata`, `error`) are exposed as
 * whole opaque values for `fetchRow` / prefetch consumption (step 12).
 * Operators project paths inside them via the search-query namespaces (step
 * 11).
 */
export interface WorkflowRow<
  TArgs = unknown,
  TResult = unknown,
  TMetadata = unknown,
> {
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

/**
 * Flat scalar columns of a request compensation invocation row.
 */
export interface RequestCompensationRow<
  TPayload = unknown,
  TCompResult = unknown,
> {
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

// =============================================================================
// WORKFLOW QUERY NAMESPACES (REFACTOR.MD Part 5 §"Workflow row, query
// namespaces, and `WorkflowHandleExternal`")
//
// Query namespaces for workflow rows. Each top-level key is a separate
// namespace addressable in a `SearchQuery<TNamespaces>` predicate. JSONB
// columns are exposed as their own namespaces with nested-path machinery;
// the flat scalar columns of a workflow row come from the `row` namespace.
// =============================================================================

/**
 * Flat scalar projection of `WorkflowRow` — the columns that participate in
 * the `row` query namespace. JSONB columns (`args`, `result`, `metadata`,
 * `error`) are exposed as their own top-level namespaces with nested-path
 * machinery; they are not part of the `row` namespace.
 *
 * `WorkflowRow` itself remains the full row shape for `fetchRow` /
 * prefetch — JSONB columns survive there as whole opaque values.
 */
export interface WorkflowRowFlat {
  readonly id: WorkflowId;
  readonly definitionName: string;
  readonly idempotencyKey: string | null;
  readonly status: WorkflowStatus;
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

/**
 * Query namespaces for workflow rows.
 *
 * - `row`      — flat scalar columns from `WorkflowRowFlat`.
 * - `args`     — JSONB args column; nested-path queryable.
 * - `result`   — JSONB result column.
 * - `metadata` — JSONB metadata column.
 * - `error`    — JSONB error envelope column.
 *
 * Used in `client.workflows.<def>.findUnique/findMany/count` predicates and
 * in the per-parent attached/detached child workflow query namespaces
 * (step 12).
 */
export type WorkflowQueryNamespaces<
  TArgs = unknown,
  TResult = unknown,
  TMetadata = unknown,
> = {
  row: WorkflowRowFlat;
  args: TArgs;
  result: TResult;
  metadata: TMetadata;
  error: WorkflowErrorEnvelope;
};

/**
 * Flat scalar projection of `RequestCompensationRow` — the columns that
 * participate in the `row` query namespace.
 */
export interface RequestCompensationRowFlat {
  readonly id: RequestCompensationInstanceId;
  readonly requestName: string;
  readonly status: RequestCompensationStatus;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly manualAt: Date | null;
  readonly skippedAt: Date | null;
}

/**
 * Query namespaces for request compensation invocation rows.
 */
export type RequestCompensationQueryNamespaces<
  TPayload = unknown,
  TCompResult = unknown,
> = {
  row: RequestCompensationRowFlat;
  payload: TPayload;
  result: TCompResult;
};

// =============================================================================
// COMPENSATION BLOCK INSTANCE ROW + QUERY NAMESPACES
// =============================================================================

import type { CompensationBlockStatus } from "./definitions/steps";
import type {
  CompensationInfo,
} from "./definitions/steps";
import type { CompensationId, HaltRecord } from "./results";

/**
 * Full row shape for a compensation block instance. Includes JSONB columns
 * as whole opaque values for `fetchRow` / prefetch.
 */
export interface CompensationBlockRow<TStep, TArgs = unknown, TResult = unknown> {
  readonly id: CompensationId<TStep>;
  readonly definitionName: string;
  readonly status: CompensationBlockStatus;
  readonly args: TArgs;
  readonly result: TResult | null;
  readonly info: CompensationInfo<unknown> | null;
  readonly halt: HaltRecord | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly haltedAt: Date | null;
  readonly skippedAt: Date | null;
}

/**
 * Flat scalar projection of `CompensationBlockRow` — the columns that
 * participate in the `row` query namespace.
 */
export interface CompensationBlockRowFlat<TStep> {
  readonly id: CompensationId<TStep>;
  readonly definitionName: string;
  readonly status: CompensationBlockStatus;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly haltedAt: Date | null;
  readonly skippedAt: Date | null;
}

/**
 * Query namespaces for compensation block instance rows.
 */
export type CompensationBlockQueryNamespaces<
  TStep,
  TArgs = unknown,
  TResult = unknown,
> = {
  row: CompensationBlockRowFlat<TStep>;
  args: TArgs;
  result: TResult;
  info: CompensationInfo<unknown>;
};
