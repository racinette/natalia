import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import { and } from "../search";
import type {
  AttachedChildWorkflowExternalHandle,
  AttachedChildWorkflowId,
  AttachedChildWorkflowNamespaceExternal,
  AnyPublicWorkflowHeader,
  AttemptHandle,
  ChannelAccessorExternal,
  CompensationBlockNamespaceExternal,
  CompensationBlockRow,
  CompensationBlockUniqueHandleExternal,
  CompensationId,
  ErrorValue,
  FetchableHandle,
  FieldsMask,
  FindManyResult,
  FindUniqueResult,
  HandleWithRow,
  HaltsNamespaceExternal,
  HaltHandle,
  OperatorAttemptsNamespaceExternal,
  ProjectedKeys,
  QueryableNamespace,
  RequestCompensationEscalateToManualOutcome,
  RequestCompensationInstanceId,
  RequestCompensationNamespaceExternal,
  RequestCompensationRow,
  RequestCompensationUniqueHandleExternal,
  RequestHandlerAttempt,
  SkipOutcome,
  StreamReaderAccessorExternal,
  EventAccessorExternal,
  WorkflowClientAccessor,
  WorkflowHandleExternal,
  WorkflowId,
  WorkflowResult,
  WorkflowRow,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// FIXTURES
// =============================================================================

const followUpHeader = defineWorkflowHeader({
  name: "introspectionFollowUp",
  args: z.object({ orderId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  channels: { nudge: z.object({ at: z.string() }) },
  errors: {
    FollowUpFailed: z.object({ reason: z.string() }),
  },
});

const refundStep = defineStep({
  name: "introspectionRefundStep",
  args: z.object({ chargeId: z.string() }),
  result: z.void(),
  async execute() {},
});

const chargeStep = defineStep({
  name: "introspectionChargeStep",
  args: z.object({ customerId: z.string(), amount: z.number() }),
  result: z.object({ chargeId: z.string() }),
  compensation: {
    steps: { refundStep },
    result: z.object({
      status: z.enum(["refunded", "manual_review"]),
    }),
    async undo() {
      return { status: "refunded" as const };
    },
  },
  async execute(args, _opts) {
    return { chargeId: `c-${args.customerId}` };
  },
});

const noResultCompensableStep = defineStep({
  name: "introspectionNoResultStep",
  args: z.object({ id: z.string() }),
  result: z.void(),
  compensation: {
    async undo() {},
  },
  async execute() {},
});

const notifyStep = defineStep({
  name: "introspectionNotifyStep",
  args: z.object({ orderId: z.string() }),
  result: z.void(),
  async execute() {},
});

const approvalRequest = defineRequest({
  name: "introspectionApprovalRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ approved: z.boolean() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
  },
});

const pingRequest = defineRequest({
  name: "introspectionPingRequest",
  payload: z.object({ orderId: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const auditHeader = defineWorkflowHeader({
  name: "introspectionAudit",
  args: z.object({ orderId: z.string() }),
  result: z.object({ persisted: z.boolean() }),
});

const opsChildWorkflow = defineWorkflow({
  name: "introspectionOpsChild",
  args: z.object({ orderId: z.string() }),
  result: z.object({ done: z.boolean() }),
  channels: {
    childCommand: z.object({ source: z.string() }),
  },
  streams: {
    childLog: z.object({ line: z.string() }),
  },
  events: {
    childReady: true,
  },
  async execute() {
    return { done: true };
  },
});

const _orderWorkflow = defineWorkflow({
  name: "introspectionOrder",
  args: z.object({ orderId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  metadata: z.object({ tenantId: z.string() }),
  channels: {
    orderUpdates: z.object({ orderId: z.string() }),
  },
  streams: {
    orderTimeline: z.object({ stage: z.string() }),
  },
  events: {
    orderReady: true,
  },
  errors: {
    OrderInvalid: z.object({ orderId: z.string() }),
  },
  steps: { chargeStep, noResultCompensableStep, notifyStep },
  requests: { approvalRequest, pingRequest },
  childWorkflows: {
    followUp: followUpHeader,
    audit: auditHeader,
    opsChild: opsChildWorkflow,
  },
  externalWorkflows: {
    followUp: followUpHeader,
    audit: auditHeader,
    opsChild: opsChildWorkflow,
  },
  async execute() {
    return { ok: true };
  },
});

// =============================================================================
// FIND-RESULT SHAPES
// =============================================================================

type _FindUniqueShape = Assert<
  IsEqual<
    FindUniqueResult<{ x: number }>,
    | { readonly status: "unique"; readonly value: { x: number } }
    | { readonly status: "missing" }
    | { readonly status: "ambiguous"; readonly count: number }
  >
>;

declare const findManyResult: FindManyResult<{ id: string }>;

// Awaiting materialises the full array.
async function _materialise(): Promise<void> {
  const _arr = await findManyResult;
  type _MaterialisedArr = Assert<
    IsEqual<typeof _arr, readonly { id: string }[]>
  >;
}

// =============================================================================
// FETCHABLE HANDLE — fetchRow + field-mask projection.
// =============================================================================

interface ExampleRow {
  readonly id: string;
  readonly status: "running" | "completed";
  readonly name: string;
  readonly createdAt: Date;
}

declare const fetchable: FetchableHandle<ExampleRow>;

async function _fetchRow(): Promise<void> {
  // No fields → entire row.
  const _full = await fetchable.fetchRow();
  type _FullShape = Assert<IsEqual<typeof _full, FindUniqueResult<ExampleRow>>>;

  // With fields mask → typed projection.
  const _projected = await fetchable.fetchRow({ id: true, status: true });
  type _ProjectedShape = Assert<
    IsEqual<
      typeof _projected,
      FindUniqueResult<Pick<ExampleRow, "id" | "status">>
    >
  >;

  // FetchOptions accepts txOrConn.
  const _withOpts = await fetchable.fetchRow({}, { txOrConn: undefined });
  void _withOpts;
}

type _FieldsMaskShape = Assert<
  IsEqual<FieldsMask<ExampleRow>["status"], true | undefined>
>;

type _ProjectedKeys = Assert<
  IsEqual<
    ProjectedKeys<ExampleRow, { id: true; createdAt: true }>,
    "id" | "createdAt"
  >
>;

type _HandleWithRow = Assert<
  IsEqual<
    HandleWithRow<{ x: number }, { y: string }>,
    { x: number } & { readonly row: { y: string } }
  >
>;

// =============================================================================
// QUERYABLE NAMESPACE — `.get`, `findUnique`, `findMany`, `count`.
// =============================================================================

declare const ns: QueryableNamespace<
  AttachedChildWorkflowExternalHandle<typeof followUpHeader>,
  object,
  WorkflowRow<{ orderId: string }, { ok: boolean }, { tenantId: string }>,
  AttachedChildWorkflowId<typeof followUpHeader>
>;

// `.get(id)` — synchronous, no I/O.
declare const someAttachedId: AttachedChildWorkflowId<typeof followUpHeader>;
const _handleFromGet = ns.get(someAttachedId);
type _GetReturn = Assert<
  IsEqual<
    typeof _handleFromGet,
    AttachedChildWorkflowExternalHandle<typeof followUpHeader>
  >
>;

// `.get(id, fields)` — adds prefetched `.row`.
const _handleWithRow = ns.get(someAttachedId, { id: true, status: true });
type _GetWithFieldsRow = Assert<
  IsEqual<
    typeof _handleWithRow.row,
    Pick<
      WorkflowRow<{ orderId: string }, { ok: boolean }, { tenantId: string }>,
      "id" | "status"
    >
  >
>;

// `findUnique` resolves to FindUniqueResult<Handle>.
async function _findUniqueShape(): Promise<void> {
  const result = await ns.findUnique();
  if (result.status === "unique") {
    type _UniqueValue = Assert<
      IsEqual<
        typeof result.value,
        AttachedChildWorkflowExternalHandle<typeof followUpHeader>
      >
    >;
  }
}

// `findMany` returns `Promise<readonly Handle[]>`.
const _manyResult = ns.findMany();
type _FindManyType = Assert<
  typeof _manyResult extends FindManyResult<
    AttachedChildWorkflowExternalHandle<typeof followUpHeader>
  >
    ? true
    : false
>;

// `count` resolves to a number.
async function _countShape(): Promise<void> {
  const _c = await ns.count();
  type _CountType = Assert<IsEqual<typeof _c, number>>;
}

// =============================================================================
// WORKFLOW HANDLE — operator-action verbs from step 09 are wired.
// =============================================================================

declare const workflowHandle: WorkflowHandleExternal<typeof _orderWorkflow>;

// Branded id.
type _WorkflowHandleId = Assert<IsEqual<typeof workflowHandle.id, WorkflowId>>;

type _WorkflowChannelsTyped = Assert<
  IsEqual<
    typeof workflowHandle.channels.orderUpdates,
    ChannelAccessorExternal<{ orderId: string }>
  >
>;
type _WorkflowStreamsTyped = Assert<
  IsEqual<
    typeof workflowHandle.streams.orderTimeline,
    StreamReaderAccessorExternal<{ stage: string }>
  >
>;
type _WorkflowEventsTyped = Assert<
  IsEqual<typeof workflowHandle.events.orderReady, EventAccessorExternal>
>;
type _WorkflowAttributesPlaceholder = Assert<
  IsEqual<typeof workflowHandle.attributes, Record<string, unknown>>
>;
// @ts-expect-error undeclared workflow channel should be absent
void workflowHandle.channels.typo;
// @ts-expect-error undeclared workflow stream should be absent
void workflowHandle.streams.typo;
// @ts-expect-error undeclared workflow event should be absent
void workflowHandle.events.typo;

// Operator-action verbs (from step 09).
type _HandleHasSigkill = Assert<
  typeof workflowHandle extends { sigkill(...args: never[]): unknown }
    ? true
    : false
>;
type _HandleHasSigterm = Assert<
  typeof workflowHandle extends { sigterm(...args: never[]): unknown }
    ? true
    : false
>;
type _HandleHasSkip = Assert<
  typeof workflowHandle extends { skip(...args: never[]): unknown } ? true : false
>;

// `skip` requires a result argument because the workflow has a non-void result.
async function _exerciseSkip(): Promise<void> {
  const _r = await workflowHandle.skip({ ok: true });
  type _SkipReturn = Assert<IsEqual<typeof _r, SkipOutcome>>;

  await workflowHandle.skip({ ok: true }, { strategy: "sigterm" });
  await workflowHandle.skip({ ok: true }, { strategy: "sigkill" });

  // @ts-expect-error result is required when the workflow result schema is non-void
  await workflowHandle.skip();

  // @ts-expect-error result must conform to the workflow's result schema
  await workflowHandle.skip({ wrong: true });
}
void _exerciseSkip;

// FetchableHandle methods.
async function _exerciseFetchRow(): Promise<void> {
  const full = await workflowHandle.fetchRow();
  if (full.status === "unique") {
    type _Full = Assert<
      IsEqual<
        typeof full.value,
        WorkflowRow<{ orderId: string }, { ok: boolean }, { tenantId: string }>
      >
    >;
  }

  const masked = await workflowHandle.fetchRow({
    status: true,
    idempotencyKey: true,
  });
  if (masked.status === "unique") {
    type _Masked = Assert<
      IsEqual<
        typeof masked.value,
        Pick<
          WorkflowRow<
            { orderId: string },
            { ok: boolean },
            { tenantId: string }
          >,
          "status" | "idempotencyKey"
        >
      >
    >;
  }
}
void _exerciseFetchRow;

// Wait for terminal outcome.
async function _exerciseWait(): Promise<void> {
  const _r = await workflowHandle.wait();
  type _WaitReturn = Assert<
    IsEqual<
      typeof _r,
      WorkflowResult<{ ok: boolean }, ErrorValue<{ OrderInvalid: unknown }>>
    > extends boolean
      ? true
      : false
  >;
}
void _exerciseWait;

// Halts namespace — queryable like other introspection surfaces.
async function _exerciseHalts(): Promise<void> {
  const _many = workflowHandle.halts.findMany();
  type _HaltsMany = Assert<IsEqual<typeof _many, FindManyResult<HaltHandle>>>;

  // @ts-expect-error halts namespace has no skip(); resolution is patch+replay or skip on the workflow itself
  void workflowHandle.halts.skip;
}
void _exerciseHalts;

// =============================================================================
// PARENT-SCOPED INTROSPECTION NAMESPACES
// =============================================================================

type _CompensationKeys = Assert<
  IsEqual<
    keyof typeof workflowHandle.compensations.steps,
    "chargeStep" | "noResultCompensableStep"
  >
>;

const _chargeCompensationNs = workflowHandle.compensations.steps.chargeStep;
type _ChargeCompensationNamespace = Assert<
  IsEqual<
    typeof _chargeCompensationNs,
    CompensationBlockNamespaceExternal<
      "chargeStep",
      { customerId: string; amount: number },
      { status: "refunded" | "manual_review" }
    >
  >
>;

const _noResultCompensationNs =
  workflowHandle.compensations.steps.noResultCompensableStep;
type _NoResultCompensationNamespace = Assert<
  IsEqual<
    typeof _noResultCompensationNs,
    CompensationBlockNamespaceExternal<
      "noResultCompensableStep",
      { id: string },
      void
    >
  >
>;

void workflowHandle.compensations.steps["chargeStep"];
// @ts-expect-error typo key should be rejected
void workflowHandle.compensations.steps["chrage"];
// @ts-expect-error non-compensable step should be absent
void workflowHandle.compensations.steps.notifyStep;

declare const chargeCompensationId: CompensationId<"chargeStep">;
const _chargeCompHandleFromGet =
  workflowHandle.compensations.steps.chargeStep.get(chargeCompensationId);
type _ChargeCompGetReturn = Assert<
  IsEqual<
    typeof _chargeCompHandleFromGet,
    CompensationBlockUniqueHandleExternal<
      "chargeStep",
      { customerId: string; amount: number },
      { status: "refunded" | "manual_review" }
    >
  >
>;

const _chargeCompHandleWithRow = workflowHandle.compensations.steps.chargeStep.get(
  chargeCompensationId,
  { id: true, args: true },
);
type _ChargeCompGetWithRow = Assert<
  IsEqual<
    typeof _chargeCompHandleWithRow.row,
    Pick<
      CompensationBlockRow<
        "chargeStep",
        { customerId: string; amount: number },
        { status: "refunded" | "manual_review" }
      >,
      "id" | "args"
    >
  >
>;

async function _exerciseChargeCompensationNamespace(): Promise<void> {
  const found = await workflowHandle.compensations.steps.chargeStep.findUnique();
  if (found.status === "unique") {
    type _FoundUnique = Assert<
      IsEqual<
        typeof found.value,
        CompensationBlockUniqueHandleExternal<
          "chargeStep",
          { customerId: string; amount: number },
          { status: "refunded" | "manual_review" }
        >
      >
    >;

    const _row = await found.value.fetchRow({ id: true, result: true });
    type _FetchedRow = Assert<
      IsEqual<
        typeof _row,
        FindUniqueResult<
          Pick<
            CompensationBlockRow<
              "chargeStep",
              { customerId: string; amount: number },
              { status: "refunded" | "manual_review" }
            >,
            "id" | "result"
          >
        >
      >
    >;
  }

  const _many = workflowHandle.compensations.steps.chargeStep.findMany({
    fields: { id: true, status: true },
  });
  type _ManyWithFields = Assert<
    typeof _many extends FindManyResult<
      HandleWithRow<
        CompensationBlockUniqueHandleExternal<
          "chargeStep",
          { customerId: string; amount: number },
          { status: "refunded" | "manual_review" }
        >,
        Pick<
          CompensationBlockRow<
            "chargeStep",
            { customerId: string; amount: number },
            { status: "refunded" | "manual_review" }
          >,
          "id" | "status"
        >
      >
    >
      ? true
      : false
  >;
}
void _exerciseChargeCompensationNamespace;

type _RequestCompensationKeys = Assert<
  IsEqual<keyof typeof workflowHandle.compensations.requests, "approvalRequest">
>;

const _approvalRequestCompensationNs =
  workflowHandle.compensations.requests.approvalRequest;
type _ApprovalRequestCompensationNamespace = Assert<
  IsEqual<
    typeof _approvalRequestCompensationNs,
    RequestCompensationNamespaceExternal<
      { chargeId: string },
      { cancelled: boolean }
    >
  >
>;
// @ts-expect-error non-compensable request should be absent
void workflowHandle.compensations.requests.pingRequest;
// @ts-expect-error unknown request key should be rejected
void workflowHandle.compensations.requests.typo;
// @ts-expect-error legacy flat namespace removed
void workflowHandle.requestCompensations;

async function _exerciseRequestCompensationNamespace(): Promise<void> {
  const found =
    await workflowHandle.compensations.requests.approvalRequest.findUnique();
  if (found.status === "unique") {
    type _FoundUnique = Assert<
      IsEqual<
        typeof found.value,
        RequestCompensationUniqueHandleExternal<
          { chargeId: string },
          { cancelled: boolean }
        >
      >
    >;

    const _reqRow = await found.value.fetchRow({ id: true, payload: true });
    type _FetchedRow = Assert<
      IsEqual<
        typeof _reqRow,
        FindUniqueResult<
          Pick<
            RequestCompensationRow<
              { chargeId: string },
              { cancelled: boolean }
            >,
            "id" | "payload"
          >
        >
      >
    >;
  }

  const _reqMany = workflowHandle.compensations.requests.approvalRequest.findMany({
    fields: { id: true, status: true },
  });
  type _ManyWithFields = Assert<
    typeof _reqMany extends FindManyResult<
      HandleWithRow<
        RequestCompensationUniqueHandleExternal<
          { chargeId: string },
          { cancelled: boolean }
        >,
        Pick<
          RequestCompensationRow<
            { chargeId: string },
            { cancelled: boolean }
          >,
          "id" | "status"
        >
      >
    >
      ? true
      : false
  >;
}
void _exerciseRequestCompensationNamespace;

type _ChildWorkflowKeys = Assert<
  IsEqual<
    keyof typeof workflowHandle.childWorkflows,
    "followUp" | "audit" | "opsChild"
  >
>;
type _ExternalWorkflowKeys = Assert<
  IsEqual<
    keyof typeof workflowHandle.externalWorkflows,
    "followUp" | "audit" | "opsChild"
  >
>;

const _followUpAttached = workflowHandle.childWorkflows.followUp;
type _FollowUpAttachedType = Assert<
  IsEqual<
    typeof _followUpAttached,
    AttachedChildWorkflowNamespaceExternal<typeof followUpHeader>
  >
>;
async function _attachedFindUniqueShape(): Promise<void> {
  const found = await workflowHandle.childWorkflows.followUp.findUnique();
  if (found.status === "unique") {
    type _AttachedUniqueHandle = Assert<
      IsEqual<
        typeof found.value,
        AttachedChildWorkflowExternalHandle<typeof followUpHeader>
      >
    >;
    // @ts-expect-error attached child handle has no lifecycle verbs
    void found.value.sigkill;
    // @ts-expect-error attached child workflows are not globally addressable
    void found.value.idempotencyKey;
  }
}
void _attachedFindUniqueShape;

declare const followUpAttachedId: AttachedChildWorkflowId<typeof followUpHeader>;
const followUpAttachedHandle = workflowHandle.childWorkflows.followUp.get(
  followUpAttachedId,
);
type _FollowUpAttachedGet = Assert<
  IsEqual<
    typeof followUpAttachedHandle,
    AttachedChildWorkflowExternalHandle<typeof followUpHeader>
  >
>;
// @ts-expect-error attached child handle has no lifecycle verbs
void followUpAttachedHandle.sigkill;
// @ts-expect-error attached child workflows are not globally addressable
void followUpAttachedHandle.idempotencyKey;
type _FollowUpAttachedChannelTyped = Assert<
  IsEqual<
    typeof followUpAttachedHandle.channels.nudge,
    ChannelAccessorExternal<{ at: string }>
  >
>;
type _FollowUpStreamsFallback = Assert<
  typeof followUpAttachedHandle.streams extends Record<string, unknown>
    ? true
    : false
>;
type _FollowUpEventsFallback = Assert<
  typeof followUpAttachedHandle.events extends Record<string, EventAccessorExternal>
    ? true
    : false
>;
// @ts-expect-error undeclared followUp channel should be absent
void followUpAttachedHandle.channels.typo;

const _followUpAttachedHandleWithRow =
  workflowHandle.childWorkflows.followUp.get(followUpAttachedId, {
    id: true,
    args: true,
  });
type _FollowUpAttachedGetWithRow = Assert<
  IsEqual<
    typeof _followUpAttachedHandleWithRow.row,
    Pick<WorkflowRow<{ orderId: string }, { ok: boolean }, void>, "id" | "args">
  >
>;

declare const opsChildAttachedId: AttachedChildWorkflowId<typeof opsChildWorkflow>;
const opsChildAttachedHandle =
  workflowHandle.childWorkflows.opsChild.get(opsChildAttachedId);
type _OpsChildAttachedChannelTyped = Assert<
  IsEqual<
    typeof opsChildAttachedHandle.channels.childCommand,
    ChannelAccessorExternal<{ source: string }>
  >
>;
type _OpsChildAttachedStreamTyped = Assert<
  IsEqual<
    typeof opsChildAttachedHandle.streams.childLog,
    StreamReaderAccessorExternal<{ line: string }>
  >
>;
type _OpsChildAttachedEventTyped = Assert<
  IsEqual<typeof opsChildAttachedHandle.events.childReady, EventAccessorExternal>
>;
// @ts-expect-error undeclared ops child channel should be absent
void opsChildAttachedHandle.channels.typo;
// @ts-expect-error undeclared ops child stream should be absent
void opsChildAttachedHandle.streams.typo;
// @ts-expect-error undeclared ops child event should be absent
void opsChildAttachedHandle.events.typo;

// externalWorkflows operator handle: a DIRECT full handle per declared name
// (independent root) — not a queryable attached namespace.
const _auditExternal = workflowHandle.externalWorkflows.audit;
type _AuditExternalType = Assert<
  IsEqual<typeof _auditExternal, WorkflowHandleExternal<typeof auditHeader>>
>;
type _AuditExternalHasLifecycle = Assert<
  typeof _auditExternal extends { sigkill(...args: never[]): unknown }
    ? true
    : false
>;
type _AuditExternalHasIdempotencyKey = Assert<
  IsEqual<typeof _auditExternal.idempotencyKey, string>
>;

const opsChildExternalHandle = workflowHandle.externalWorkflows.opsChild;
type _OpsChildExternalHandle = Assert<
  IsEqual<typeof opsChildExternalHandle, WorkflowHandleExternal<typeof opsChildWorkflow>>
>;
type _OpsChildExternalChannelTyped = Assert<
  IsEqual<
    typeof opsChildExternalHandle.channels.childCommand,
    ChannelAccessorExternal<{ source: string }>
  >
>;
type _OpsChildExternalStreamTyped = Assert<
  IsEqual<
    typeof opsChildExternalHandle.streams.childLog,
    StreamReaderAccessorExternal<{ line: string }>
  >
>;
type _OpsChildExternalEventTyped = Assert<
  IsEqual<typeof opsChildExternalHandle.events.childReady, EventAccessorExternal>
>;
type _OpsChildExternalHasSigkill = Assert<
  typeof opsChildExternalHandle extends { sigkill(...args: never[]): unknown }
    ? true
    : false
>;
type _OpsChildExternalIdempotencyKey = Assert<
  IsEqual<typeof opsChildExternalHandle.idempotencyKey, string>
>;
// @ts-expect-error undeclared external ops child channel should be absent
void opsChildExternalHandle.channels.typo;
// @ts-expect-error undeclared external ops child stream should be absent
void opsChildExternalHandle.streams.typo;
// @ts-expect-error undeclared external ops child event should be absent
void opsChildExternalHandle.events.typo;
// @ts-expect-error unknown child workflow key should be rejected
void workflowHandle.childWorkflows.typo;
// @ts-expect-error legacy namespace removed
void workflowHandle.attachedChildWorkflows;
// @ts-expect-error legacy namespace removed
void workflowHandle.detachedChildWorkflows;

declare const _headerOnlyHandle: WorkflowHandleExternal<typeof followUpHeader>;
type _HeaderOnlyCompensationsFallback = Assert<
  IsEqual<
    typeof _headerOnlyHandle.compensations.steps,
    Record<string, CompensationBlockNamespaceExternal<unknown>>
  >
>;
type _HeaderOnlyRequestCompensationsFallback = Assert<
  IsEqual<
    typeof _headerOnlyHandle.compensations.requests,
    Record<string, RequestCompensationNamespaceExternal>
  >
>;
type _HeaderOnlyChildWorkflowsFallback = Assert<
  IsEqual<
    typeof _headerOnlyHandle.childWorkflows,
    Record<
      string,
      AttachedChildWorkflowNamespaceExternal<AnyPublicWorkflowHeader>
    >
  >
>;
type _HeaderOnlyExternalWorkflowsFallback = Assert<
  IsEqual<
    typeof _headerOnlyHandle.externalWorkflows,
    Record<string, WorkflowHandleExternal<AnyPublicWorkflowHeader>>
  >
>;

// =============================================================================
// COMPENSATION BLOCK UNIQUE HANDLE — operator-action verbs from step 09.
// =============================================================================

declare const compHandle: CompensationBlockUniqueHandleExternal<
  typeof chargeStep,
  { customerId: string; amount: number },
  { status: "refunded" | "manual_review" }
>;

type _CompHandleId = Assert<
  IsEqual<typeof compHandle.id, CompensationId<typeof chargeStep>>
>;
type _CompensationPrimitiveAttributes = Assert<
  IsEqual<typeof compHandle.attributes, Record<string, unknown>>
>;
type _CompensationPrimitiveStreams = Assert<
  IsEqual<typeof compHandle.streams, Record<string, unknown>>
>;
type _CompensationPrimitiveEvents = Assert<
  IsEqual<typeof compHandle.events, Record<string, unknown>>
>;
type _CompensationPrimitiveChannels = Assert<
  IsEqual<typeof compHandle.channels, Record<string, unknown>>
>;

async function _exerciseCompSkip(): Promise<void> {
  const _r = await compHandle.skip({ status: "refunded" });
  type _SkipReturn = Assert<IsEqual<typeof _r, SkipOutcome>>;

  // @ts-expect-error compensation blocks have no sigkill
  void compHandle.sigkill;
  // @ts-expect-error compensation blocks have no sigterm
  void compHandle.sigterm;
  // @ts-expect-error compensation skip has no strategy option
  await compHandle.skip({ status: "refunded" }, { strategy: "sigkill" });
}
void _exerciseCompSkip;

// =============================================================================
// REQUEST COMPENSATION UNIQUE HANDLE — fetchRow + attempts namespace + skip().
// =============================================================================

declare const reqCompHandle: RequestCompensationUniqueHandleExternal<
  { chargeId: string },
  { cancelled: boolean },
  Record<string, never>
>;

type _ReqCompId = Assert<
  IsEqual<typeof reqCompHandle.id, RequestCompensationInstanceId>
>;

type _ReqCompAttemptsNs = Assert<
  IsEqual<
    typeof reqCompHandle.attempts,
    OperatorAttemptsNamespaceExternal<
      RequestHandlerAttempt<Record<string, never>>
    >
  >
>;
void (0 as unknown as _ReqCompAttemptsNs);

async function _exerciseReqCompAttempts(): Promise<void> {
  const _many = await reqCompHandle.attempts.findMany();
  type _Attempts = Assert<
    IsEqual<
      (typeof _many)[number],
      AttemptHandle<RequestHandlerAttempt<Record<string, never>>>
    >
  >;
}
void _exerciseReqCompAttempts;

async function _exerciseReqCompSkip(): Promise<void> {
  const _r = await reqCompHandle.skip({ cancelled: true });
  type _Return = Assert<IsEqual<typeof _r, SkipOutcome>>;
}
void _exerciseReqCompSkip;

async function _exerciseReqCompEscalateToManual(): Promise<void> {
  const _e = await reqCompHandle.escalateToManual({
    message: "Operator must release manually",
    type: "OpsConsole",
  });
  type _Outcome = Assert<
    IsEqual<typeof _e, RequestCompensationEscalateToManualOutcome>
  >;
}
void _exerciseReqCompEscalateToManual;

// =============================================================================
// CLIENT-LEVEL WORKFLOW ACCESSOR — start, execute, get, findUnique, findMany, count.
// =============================================================================

declare const clientAcc: WorkflowClientAccessor<typeof _orderWorkflow>;

async function _exerciseClient(): Promise<void> {
  const _handle = await clientAcc.start({
    idempotencyKey: "wf-1",
    args: { orderId: "o-1" },
    metadata: { tenantId: "acme" },
  });
  type _StartReturn = Assert<
    IsEqual<typeof _handle, WorkflowHandleExternal<typeof _orderWorkflow>>
  >;

  const _result = await clientAcc.execute({
    idempotencyKey: "wf-2",
    args: { orderId: "o-2" },
    metadata: { tenantId: "acme" },
  });
  type _ExecuteReturn = Assert<
    typeof _result extends WorkflowResult<{ ok: boolean }, unknown> ? true : false
  >;

  const _synchronousHandle = clientAcc.get("wf-3");
  type _GetReturn = Assert<
    IsEqual<
      typeof _synchronousHandle,
      WorkflowHandleExternal<typeof _orderWorkflow>
    >
  >;

  // findUnique / findMany / count from the unified queryable surface.
  const found = await clientAcc.findUnique();
  if (found.status === "unique") {
    type _FoundValue = Assert<
      IsEqual<typeof found.value, WorkflowHandleExternal<typeof _orderWorkflow>>
    >;
  }

  const _many = clientAcc.findMany();
  type _ManyAwaited = Assert<
    typeof _many extends FindManyResult<
      WorkflowHandleExternal<typeof _orderWorkflow>
    >
      ? true
      : false
  >;

  const _total = await clientAcc.count();
  type _CountReturn = Assert<IsEqual<typeof _total, number>>;
}
void _exerciseClient;

// =============================================================================
// HALT OBSERVATION ON WORKFLOW HANDLE
// =============================================================================

type _HaltsNamespaceShape = Assert<
  typeof workflowHandle.halts extends HaltsNamespaceExternal ? true : false
>;
