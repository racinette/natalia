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
  AttemptAccessor,
  ChannelAccessorExternal,
  CompensationBlockNamespaceExternal,
  CompensationBlockRow,
  CompensationBlockUniqueHandleExternal,
  CompensationId,
  CountOptions,
  ErrorValue,
  FetchableHandle,
  FetchOptions,
  FieldsMask,
  FindManyOptions,
  FindManyResult,
  FindUniqueOptions,
  FindUniqueResult,
  HandleWithRow,
  HaltsNamespaceExternal,
  ProjectedKeys,
  QueryableNamespace,
  RequestCompensationInstanceId,
  RequestCompensationNamespaceExternal,
  RequestCompensationRow,
  RequestCompensationUniqueHandleExternal,
  SkipOutcome,
  StreamReaderAccessorExternal,
  EventAccessorExternal,
  DetachedChildWorkflowNamespaceExternal,
  WorkflowClientAccessor,
  WorkflowHandleExternal,
  WorkflowId,
  WorkflowOperatorActions,
  WorkflowResult,
  WorkflowRow,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

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
  async execute(_ctx, args) {
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

const orderWorkflow = defineWorkflow({
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

// PromiseLike — awaiting materialises the array.
async function _materialise(): Promise<void> {
  const arr = await findManyResult;
  type _MaterialisedArr = Assert<
    IsEqual<typeof arr, readonly { id: string }[]>
  >;
}

// AsyncIterable — iterating streams handles lazily.
async function _stream(): Promise<void> {
  for await (const handle of findManyResult) {
    type _StreamedHandle = Assert<IsEqual<typeof handle, { id: string }>>;
  }
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
  const full = await fetchable.fetchRow();
  type _FullShape = Assert<IsEqual<typeof full, FindUniqueResult<ExampleRow>>>;

  // With fields mask → typed projection.
  const projected = await fetchable.fetchRow({ id: true, status: true });
  type _ProjectedShape = Assert<
    IsEqual<
      typeof projected,
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
  any,
  WorkflowRow<{ orderId: string }, { ok: boolean }, { tenantId: string }>,
  AttachedChildWorkflowId<typeof followUpHeader>
>;

// `.get(id)` — synchronous, no I/O.
declare const someAttachedId: AttachedChildWorkflowId<typeof followUpHeader>;
const handleFromGet = ns.get(someAttachedId);
type _GetReturn = Assert<
  IsEqual<
    typeof handleFromGet,
    AttachedChildWorkflowExternalHandle<typeof followUpHeader>
  >
>;

// `.get(id, fields)` — adds prefetched `.row`.
const handleWithRow = ns.get(someAttachedId, { id: true, status: true });
type _GetWithFieldsRow = Assert<
  IsEqual<
    typeof handleWithRow.row,
    Pick<
      WorkflowRow<{ orderId: string }, { ok: boolean }, { tenantId: string }>,
      "id" | "status"
    >
  >
>;

// `findUnique` resolves to FindUniqueResult<Handle>.
async function _findUniqueShape(): Promise<void> {
  const result = await ns.findUnique(() => and());
  if (result.status === "unique") {
    type _UniqueValue = Assert<
      IsEqual<
        typeof result.value,
        AttachedChildWorkflowExternalHandle<typeof followUpHeader>
      >
    >;
  }
}

// `findMany` returns FindManyResult; awaitable + async-iterable.
const manyResult = ns.findMany(() => and());
type _FindManyType = Assert<
  typeof manyResult extends FindManyResult<
    AttachedChildWorkflowExternalHandle<typeof followUpHeader>
  >
    ? true
    : false
>;

// `count` resolves to a number.
async function _countShape(): Promise<void> {
  const c = await ns.count(() => and());
  type _CountType = Assert<IsEqual<typeof c, number>>;
}

// =============================================================================
// WORKFLOW HANDLE — operator-action verbs from step 09 are wired.
// =============================================================================

declare const workflowHandle: WorkflowHandleExternal<typeof orderWorkflow>;

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
  typeof workflowHandle extends { sigkill(...args: any[]): any } ? true : false
>;
type _HandleHasSigterm = Assert<
  typeof workflowHandle extends { sigterm(...args: any[]): any } ? true : false
>;
type _HandleHasSkip = Assert<
  typeof workflowHandle extends { skip(...args: any[]): any } ? true : false
>;

// `skip` requires a result argument because the workflow has a non-void result.
async function _exerciseSkip(): Promise<void> {
  const r = await workflowHandle.skip({ ok: true });
  type _SkipReturn = Assert<IsEqual<typeof r, SkipOutcome>>;

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
  const r = await workflowHandle.wait();
  type _WaitReturn = Assert<
    IsEqual<
      typeof r,
      WorkflowResult<{ ok: boolean }, ErrorValue<{ OrderInvalid: any }>>
    > extends boolean
      ? true
      : false
  >;
}
void _exerciseWait;

// Halts surface.
async function _exerciseHalts(): Promise<void> {
  const _list = await workflowHandle.halts.list();
  type _HaltsList = Assert<
    typeof _list extends readonly unknown[] ? true : false
  >;

  // No `skip()` on halts namespace — execution halts are not directly skippable.
  // @ts-expect-error halts namespace exposes only list(); resolution is patch+replay or skip on the workflow itself
  workflowHandle.halts.skip;
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

const chargeCompensationNs = workflowHandle.compensations.steps.chargeStep;
type _ChargeCompensationNamespace = Assert<
  IsEqual<
    typeof chargeCompensationNs,
    CompensationBlockNamespaceExternal<
      "chargeStep",
      { customerId: string; amount: number },
      { status: "refunded" | "manual_review" }
    >
  >
>;

const noResultCompensationNs =
  workflowHandle.compensations.steps.noResultCompensableStep;
type _NoResultCompensationNamespace = Assert<
  IsEqual<
    typeof noResultCompensationNs,
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
const chargeCompHandleFromGet =
  workflowHandle.compensations.steps.chargeStep.get(chargeCompensationId);
type _ChargeCompGetReturn = Assert<
  IsEqual<
    typeof chargeCompHandleFromGet,
    CompensationBlockUniqueHandleExternal<
      "chargeStep",
      { customerId: string; amount: number },
      { status: "refunded" | "manual_review" }
    >
  >
>;

const chargeCompHandleWithRow = workflowHandle.compensations.steps.chargeStep.get(
  chargeCompensationId,
  { id: true, args: true },
);
type _ChargeCompGetWithRow = Assert<
  IsEqual<
    typeof chargeCompHandleWithRow.row,
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
  const found = await workflowHandle.compensations.steps.chargeStep.findUnique(
    () => and(),
  );
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

    const row = await found.value.fetchRow({ id: true, result: true });
    type _FetchedRow = Assert<
      IsEqual<
        typeof row,
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

  const many = workflowHandle.compensations.steps.chargeStep.findMany(
    () => and(),
    { fields: { id: true, status: true } },
  );
  type _ManyWithFields = Assert<
    typeof many extends FindManyResult<
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

const approvalRequestCompensationNs =
  workflowHandle.compensations.requests.approvalRequest;
type _ApprovalRequestCompensationNamespace = Assert<
  IsEqual<
    typeof approvalRequestCompensationNs,
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
    await workflowHandle.compensations.requests.approvalRequest.findUnique(
      () => and(),
    );
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

    const row = await found.value.fetchRow({ id: true, payload: true });
    type _FetchedRow = Assert<
      IsEqual<
        typeof row,
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

  const many = workflowHandle.compensations.requests.approvalRequest.findMany(
    () => and(),
    { fields: { id: true, status: true } },
  );
  type _ManyWithFields = Assert<
    typeof many extends FindManyResult<
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

type _AttachedChildrenKeys = Assert<
  IsEqual<
    keyof typeof workflowHandle.attachedChildWorkflows,
    "followUp" | "audit" | "opsChild"
  >
>;
type _DetachedChildrenKeys = Assert<
  IsEqual<
    keyof typeof workflowHandle.detachedChildWorkflows,
    "followUp" | "audit" | "opsChild"
  >
>;

const followUpAttached = workflowHandle.attachedChildWorkflows.followUp;
type _FollowUpAttachedType = Assert<
  IsEqual<
    typeof followUpAttached,
    AttachedChildWorkflowNamespaceExternal<typeof followUpHeader>
  >
>;

declare const followUpAttachedId: AttachedChildWorkflowId<typeof followUpHeader>;
const followUpAttachedHandle = workflowHandle.attachedChildWorkflows.followUp.get(
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
// @ts-expect-error attached children are not globally addressable
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

const followUpAttachedHandleWithRow =
  workflowHandle.attachedChildWorkflows.followUp.get(followUpAttachedId, {
    id: true,
    args: true,
  });
type _FollowUpAttachedGetWithRow = Assert<
  IsEqual<
    typeof followUpAttachedHandleWithRow.row,
    Pick<WorkflowRow<{ orderId: string }, { ok: boolean }, void>, "id" | "args">
  >
>;

declare const opsChildAttachedId: AttachedChildWorkflowId<typeof opsChildWorkflow>;
const opsChildAttachedHandle =
  workflowHandle.attachedChildWorkflows.opsChild.get(opsChildAttachedId);
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

const auditDetached = workflowHandle.detachedChildWorkflows.audit;
type _AuditDetachedType = Assert<
  IsEqual<
    typeof auditDetached,
    DetachedChildWorkflowNamespaceExternal<typeof auditHeader>
  >
>;

declare const opsChildDetachedId: AttachedChildWorkflowId<typeof opsChildWorkflow>;
const opsChildDetachedHandle =
  workflowHandle.detachedChildWorkflows.opsChild.get(opsChildDetachedId);
type _OpsChildDetachedHandle = Assert<
  IsEqual<typeof opsChildDetachedHandle, WorkflowHandleExternal<typeof opsChildWorkflow>>
>;
type _OpsChildDetachedChannelTyped = Assert<
  IsEqual<
    typeof opsChildDetachedHandle.channels.childCommand,
    ChannelAccessorExternal<{ source: string }>
  >
>;
type _OpsChildDetachedStreamTyped = Assert<
  IsEqual<
    typeof opsChildDetachedHandle.streams.childLog,
    StreamReaderAccessorExternal<{ line: string }>
  >
>;
type _OpsChildDetachedEventTyped = Assert<
  IsEqual<typeof opsChildDetachedHandle.events.childReady, EventAccessorExternal>
>;
type _OpsChildDetachedHasSigkill = Assert<
  typeof opsChildDetachedHandle extends { sigkill(...args: any[]): any }
    ? true
    : false
>;
type _OpsChildDetachedIdempotencyKey = Assert<
  IsEqual<typeof opsChildDetachedHandle.idempotencyKey, string>
>;
// @ts-expect-error undeclared detached ops child channel should be absent
void opsChildDetachedHandle.channels.typo;
// @ts-expect-error undeclared detached ops child stream should be absent
void opsChildDetachedHandle.streams.typo;
// @ts-expect-error undeclared detached ops child event should be absent
void opsChildDetachedHandle.events.typo;
// @ts-expect-error unknown child workflow key should be rejected
void workflowHandle.attachedChildWorkflows.typo;

declare const headerOnlyHandle: WorkflowHandleExternal<typeof followUpHeader>;
type _HeaderOnlyCompensationsFallback = Assert<
  IsEqual<
    typeof headerOnlyHandle.compensations.steps,
    Record<string, CompensationBlockNamespaceExternal<unknown>>
  >
>;
type _HeaderOnlyRequestCompensationsFallback = Assert<
  IsEqual<
    typeof headerOnlyHandle.compensations.requests,
    Record<string, RequestCompensationNamespaceExternal>
  >
>;
type _HeaderOnlyAttachedChildrenFallback = Assert<
  IsEqual<
    typeof headerOnlyHandle.attachedChildWorkflows,
    Record<
      string,
      AttachedChildWorkflowNamespaceExternal<AnyPublicWorkflowHeader>
    >
  >
>;
type _HeaderOnlyDetachedChildrenFallback = Assert<
  IsEqual<
    typeof headerOnlyHandle.detachedChildWorkflows,
    Record<
      string,
      DetachedChildWorkflowNamespaceExternal<AnyPublicWorkflowHeader>
    >
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
  const r = await compHandle.skip({ status: "refunded" });
  type _SkipReturn = Assert<IsEqual<typeof r, SkipOutcome>>;

  // @ts-expect-error compensation blocks have no sigkill
  compHandle.sigkill;
  // @ts-expect-error compensation blocks have no sigterm
  compHandle.sigterm;
  // @ts-expect-error compensation skip has no strategy option
  await compHandle.skip({ status: "refunded" }, { strategy: "sigkill" });
}
void _exerciseCompSkip;

// =============================================================================
// REQUEST COMPENSATION UNIQUE HANDLE — fetchRow + attempts() + skip().
// =============================================================================

declare const reqCompHandle: RequestCompensationUniqueHandleExternal<
  { chargeId: string },
  { cancelled: boolean }
>;

type _ReqCompId = Assert<
  IsEqual<typeof reqCompHandle.id, RequestCompensationInstanceId>
>;

async function _exerciseReqCompAttempts(): Promise<void> {
  const a = await reqCompHandle.attempts();
  type _Attempts = Assert<IsEqual<typeof a, FindUniqueResult<AttemptAccessor>>>;
}
void _exerciseReqCompAttempts;

async function _exerciseReqCompSkip(): Promise<void> {
  const r = await reqCompHandle.skip({ cancelled: true });
  type _Return = Assert<IsEqual<typeof r, SkipOutcome>>;
}
void _exerciseReqCompSkip;

// =============================================================================
// CLIENT-LEVEL WORKFLOW ACCESSOR — start, execute, get, findUnique, findMany, count.
// =============================================================================

declare const clientAcc: WorkflowClientAccessor<typeof orderWorkflow>;

async function _exerciseClient(): Promise<void> {
  const handle = await clientAcc.start({
    idempotencyKey: "wf-1",
    args: { orderId: "o-1" },
    metadata: { tenantId: "acme" },
  });
  type _StartReturn = Assert<
    IsEqual<typeof handle, WorkflowHandleExternal<typeof orderWorkflow>>
  >;

  const result = await clientAcc.execute({
    idempotencyKey: "wf-2",
    args: { orderId: "o-2" },
    metadata: { tenantId: "acme" },
  });
  type _ExecuteReturn = Assert<
    typeof result extends WorkflowResult<{ ok: boolean }, any> ? true : false
  >;

  const synchronousHandle = clientAcc.get("wf-3");
  type _GetReturn = Assert<
    IsEqual<
      typeof synchronousHandle,
      WorkflowHandleExternal<typeof orderWorkflow>
    >
  >;

  // findUnique / findMany / count from the unified queryable surface.
  const found = await clientAcc.findUnique(() => and());
  if (found.status === "unique") {
    type _FoundValue = Assert<
      IsEqual<typeof found.value, WorkflowHandleExternal<typeof orderWorkflow>>
    >;
  }

  const many = clientAcc.findMany(() => and());
  type _ManyAwaited = Assert<
    typeof many extends FindManyResult<
      WorkflowHandleExternal<typeof orderWorkflow>
    >
      ? true
      : false
  >;

  const total = await clientAcc.count(() => and());
  type _CountReturn = Assert<IsEqual<typeof total, number>>;
}
void _exerciseClient;

// =============================================================================
// HALT OBSERVATION ON WORKFLOW HANDLE
// =============================================================================

type _HaltsNamespaceShape = Assert<
  typeof workflowHandle.halts extends HaltsNamespaceExternal ? true : false
>;
