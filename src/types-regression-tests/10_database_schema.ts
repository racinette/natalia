import { z } from "zod";
import { defineWorkflow, defineWorkflowHeader } from "../workflow";
import type {
  AttachedChildWorkflowId,
  CompensationBlockHaltStatus,
  CompensationBlockStatus,
  CompensationId,
  HaltRecord,
  RequestCompensationInstanceId,
  RequestCompensationRow,
  RequestCompensationStatus,
  StepType,
  WorkflowErrorEnvelope,
  WorkflowHaltStatus,
  WorkflowId,
  WorkflowRow,
  WorkflowStatus,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// BRANDED IDS — symmetry across the four id kinds in the public surface.
//
//   - WorkflowId                       — workflow row primary id.
//   - AttachedChildWorkflowId<W>       — workflow row id, parent-scoped, branded
//                                        per child workflow definition.
//   - CompensationId<TStep>            — workflow row id of a compensation
//                                        block instance, branded per step.
//   - RequestCompensationInstanceId    — request_compensation_instance row id.
//
// All four are opaque branded strings: a plain `string` is not assignable
// without the brand.
// =============================================================================

declare const _workflowId: WorkflowId;
declare const _requestCompId: RequestCompensationInstanceId;

type _WorkflowIdIsString = Assert<typeof _workflowId extends string ? true : false>;
type _PlainStringNotAssignableToWorkflowId = Assert<
  string extends WorkflowId ? false : true
>;
type _PlainStringNotAssignableToRequestCompId = Assert<
  string extends RequestCompensationInstanceId ? false : true
>;

// AttachedChildWorkflowId<W> is parameterised by the workflow header.
const _childHeader = defineWorkflowHeader({
  name: "schemaChild",
  args: z.object({ id: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
});

declare const _attachedId: AttachedChildWorkflowId<typeof _childHeader>;
type _AttachedIdIsString = Assert<
  typeof _attachedId extends string ? true : false
>;

// Brand separation: ids from different definitions are not interchangeable.
// Even structurally identical headers are distinguishable because the
// `defineWorkflowHeader` factory captures `name` as a literal — see
// `00_name_literals.ts`.
const _otherHeader = defineWorkflowHeader({
  name: "schemaOther",
  args: z.object({ id: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
});
declare const _otherAttachedId: AttachedChildWorkflowId<typeof _otherHeader>;
type _AttachedBrandSeparation = Assert<
  IsEqual<typeof _attachedId, typeof _otherAttachedId> extends false ? true : false
>;

// CompensationId<TStep> brand separation already covered in step 08.
declare const _compId: CompensationId<{ name: "exampleStep" }>;
type _CompensationIdIsString = Assert<typeof _compId extends string ? true : false>;

// =============================================================================
// STATUS UNIONS — schema check-constraint domains.
// =============================================================================

type _WorkflowStatus = Assert<
  IsEqual<
    WorkflowStatus,
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "terminated"
    | "halted"
    | "skipped"
  >
>;

type _RequestCompensationStatus = Assert<
  IsEqual<
    RequestCompensationStatus,
    "pending" | "running" | "completed" | "skipped" | "manual"
  >
>;

// CompensationBlockStatus is published by step 02-era types/definitions/steps.ts;
// re-affirm its shape here so the catalogue is complete in one place.
type _CompensationBlockStatus = Assert<
  IsEqual<
    CompensationBlockStatus,
    "pending" | "running" | "completed" | "halted" | "skipped"
  >
>;

// Halt status unions — already published by step 09; included for symmetry
// since the schema's `halt` table check constraint is the source of truth.
type _WorkflowHaltStatus = Assert<
  IsEqual<WorkflowHaltStatus, "pending" | "resolved">
>;
type _CompensationBlockHaltStatus = Assert<
  IsEqual<CompensationBlockHaltStatus, "pending" | "resolved" | "skipped">
>;

// =============================================================================
// STEP TYPE CATALOG — persisted `step.type` values from REFACTOR.MD Part 8.
// =============================================================================

const allStepTypes: readonly StepType[] = [
  // Dispatched.
  "start_step",
  "start_child_workflow",
  "send_request",
  // Dispatched-await.
  "await_promise",
  // Structural.
  "execute_scope",
  // Awaitable waits.
  "sleep",
  "sleep_until",
  "channel_receive",
  // Awaitable reads.
  "channel_receive_nowait",
  "patch_check",
  // Buffered.
  "stream_write",
  "event_set",
  "attribute_set",
  "register_compensation_instance",
  "promote_compensation_instance",
  "queue_enqueue",
  "topic_publish",
  "channel_send",
  "start_detached",
];
void allStepTypes;

// @ts-expect-error step types must come from the published catalog
const _badStepType: StepType = "start_branch";

// =============================================================================
// ROW RECORD TYPES — JSONB columns are typed; flat columns mirror SQL types.
// =============================================================================

declare const _workflowRow: WorkflowRow<
  { orderId: string },
  { confirmed: boolean },
  { tenantId: string }
>;

type _WorkflowRowIdIsBranded = Assert<
  IsEqual<typeof _workflowRow.id, WorkflowId>
>;
type _WorkflowRowDefinitionName = Assert<
  IsEqual<typeof _workflowRow.definitionName, string>
>;
type _WorkflowRowIdempotencyKey = Assert<
  IsEqual<typeof _workflowRow.idempotencyKey, string | null>
>;
type _WorkflowRowStatus = Assert<
  IsEqual<typeof _workflowRow.status, WorkflowStatus>
>;
type _WorkflowRowArgsTyped = Assert<
  IsEqual<typeof _workflowRow.args, { orderId: string }>
>;
type _WorkflowRowResultNullable = Assert<
  IsEqual<typeof _workflowRow.result, { confirmed: boolean } | null>
>;
type _WorkflowRowMetadata = Assert<
  IsEqual<typeof _workflowRow.metadata, { tenantId: string }>
>;
type _WorkflowRowErrorNullable = Assert<
  IsEqual<typeof _workflowRow.error, WorkflowErrorEnvelope | null>
>;
type _WorkflowRowAttachedFlag = Assert<
  IsEqual<typeof _workflowRow.attached, boolean>
>;
type _WorkflowRowIsCompensation = Assert<
  IsEqual<typeof _workflowRow.isCompensation, boolean>
>;
type _WorkflowRowCompensationStepNameNullable = Assert<
  IsEqual<typeof _workflowRow.compensationStepName, string | null>
>;
type _WorkflowRowCreatedAt = Assert<
  IsEqual<typeof _workflowRow.createdAt, Date>
>;

// Default unknowns for unparameterised consumption.
declare const _workflowRowDefault: WorkflowRow;
type _DefaultWorkflowRowArgs = Assert<
  IsEqual<typeof _workflowRowDefault.args, unknown>
>;

// Request compensation row.
declare const _requestCompRow: RequestCompensationRow<
  { chargeId: string },
  { kind: "refunded" | "manual" }
>;
type _RequestCompRowIdBranded = Assert<
  IsEqual<typeof _requestCompRow.id, RequestCompensationInstanceId>
>;
type _RequestCompRowStatus = Assert<
  IsEqual<typeof _requestCompRow.status, RequestCompensationStatus>
>;
type _RequestCompRowPayload = Assert<
  IsEqual<typeof _requestCompRow.payload, { chargeId: string }>
>;
type _RequestCompRowResult = Assert<
  IsEqual<
    typeof _requestCompRow.result,
    { kind: "refunded" | "manual" } | null
  >
>;

// =============================================================================
// HALT RECORD CARRIES STATUS UNION OF BOTH HALT KINDS
// =============================================================================

declare const _halt: HaltRecord;
type _HaltStatusUnion = Assert<
  IsEqual<
    typeof _halt.status,
    WorkflowHaltStatus | CompensationBlockHaltStatus
  >
>;
type _HaltErrorDetailsNullable = Assert<
  typeof _halt.errorDetails extends null | undefined ? false : true
>;

// =============================================================================
// SCHEMA-DERIVED PUBLIC SURFACE IS USABLE FROM A WORKFLOW DEFINITION
// =============================================================================

export const schemaAcceptanceWorkflow = defineWorkflow({
  name: "schemaAcceptance",
  args: z.object({ orderId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  metadata: z.object({ tenantId: z.string() }),
  async execute() {
    return { ok: true };
  },
});
