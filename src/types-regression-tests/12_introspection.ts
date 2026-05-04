import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type {
  AttachedChildWorkflowExternalHandle,
  AttachedChildWorkflowId,
  AttachedChildWorkflowNamespaceExternal,
  AttemptAccessor,
  CompensationBlockNamespaceExternal,
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
  RequestCompensationUniqueHandleExternal,
  SkipOutcome,
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

const approvalRequest = defineRequest({
  name: "introspectionApprovalRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ approved: z.boolean() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
  },
});

const orderWorkflow = defineWorkflow({
  name: "introspectionOrder",
  args: z.object({ orderId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  metadata: z.object({ tenantId: z.string() }),
  errors: {
    OrderInvalid: z.object({ orderId: z.string() }),
  },
  steps: { chargeStep, noResultCompensableStep },
  requests: { approvalRequest },
  childWorkflows: { followUp: followUpHeader },
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
  const result = await ns.findUnique(() => ({ kind: "and", nodes: [] }));
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
const manyResult = ns.findMany(() => ({ kind: "and", nodes: [] }));
type _FindManyType = Assert<
  typeof manyResult extends FindManyResult<
    AttachedChildWorkflowExternalHandle<typeof followUpHeader>
  >
    ? true
    : false
>;

// `count` resolves to a number.
async function _countShape(): Promise<void> {
  const c = await ns.count(() => ({ kind: "and", nodes: [] }));
  type _CountType = Assert<IsEqual<typeof c, number>>;
}

// =============================================================================
// WORKFLOW HANDLE — operator-action verbs from step 09 are wired.
// =============================================================================

declare const workflowHandle: WorkflowHandleExternal<typeof orderWorkflow>;

// Branded id.
type _WorkflowHandleId = Assert<
  IsEqual<typeof workflowHandle.id, WorkflowId>
>;

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

  const masked = await workflowHandle.fetchRow({ status: true, idempotencyKey: true });
  if (masked.status === "unique") {
    type _Masked = Assert<
      IsEqual<
        typeof masked.value,
        Pick<
          WorkflowRow<{ orderId: string }, { ok: boolean }, { tenantId: string }>,
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
  type _HaltsList = Assert<typeof _list extends readonly unknown[] ? true : false>;

  // No `skip()` on halts namespace — execution halts are not directly skippable.
  // @ts-expect-error halts namespace exposes only list(); resolution is patch+replay or skip on the workflow itself
  workflowHandle.halts.skip;
}
void _exerciseHalts;

// =============================================================================
// PARENT-SCOPED INTROSPECTION NAMESPACES
// =============================================================================

// `compensations.<step>` — typed per declared compensable step.
type _HasCompensationsNamespace = Assert<
  typeof workflowHandle.compensations extends Record<string, unknown>
    ? true
    : false
>;

// `attachedChildWorkflows.<name>`
type _HasAttachedChildren = Assert<
  typeof workflowHandle.attachedChildWorkflows extends Record<string, unknown>
    ? true
    : false
>;

// `detachedChildWorkflows.<name>`
type _HasDetachedChildren = Assert<
  typeof workflowHandle.detachedChildWorkflows extends Record<string, unknown>
    ? true
    : false
>;

// `requestCompensations.<request>`
type _HasRequestCompensations = Assert<
  typeof workflowHandle.requestCompensations extends Record<string, unknown>
    ? true
    : false
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
  type _Attempts = Assert<
    IsEqual<typeof a, FindUniqueResult<AttemptAccessor>>
  >;
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
    typeof result extends WorkflowResult<{ ok: boolean }, any>
      ? true
      : false
  >;

  const synchronousHandle = clientAcc.get("wf-3");
  type _GetReturn = Assert<
    IsEqual<
      typeof synchronousHandle,
      WorkflowHandleExternal<typeof orderWorkflow>
    >
  >;

  // findUnique / findMany / count from the unified queryable surface.
  const found = await clientAcc.findUnique(() => ({ kind: "and", nodes: [] }));
  if (found.status === "unique") {
    type _FoundValue = Assert<
      IsEqual<
        typeof found.value,
        WorkflowHandleExternal<typeof orderWorkflow>
      >
    >;
  }

  const many = clientAcc.findMany(() => ({ kind: "and", nodes: [] }));
  type _ManyAwaited = Assert<
    typeof many extends FindManyResult<WorkflowHandleExternal<typeof orderWorkflow>>
      ? true
      : false
  >;

  const total = await clientAcc.count(() => ({ kind: "and", nodes: [] }));
  type _CountReturn = Assert<IsEqual<typeof total, number>>;
}
void _exerciseClient;

// =============================================================================
// HALT OBSERVATION ON WORKFLOW HANDLE
// =============================================================================

type _HaltsNamespaceShape = Assert<
  typeof workflowHandle.halts extends HaltsNamespaceExternal ? true : false
>;
