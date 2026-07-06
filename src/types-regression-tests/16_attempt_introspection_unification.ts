import { z } from "zod";
import { createWorkflowClient } from "../client";
import { and, eq, gt, whereTrue } from "../search";
import {
  defineQueue,
  defineRequest,
  defineStep,
  defineWorkflow,
} from "../workflow";
import type {
  Attempt,
  AttemptHandle,
  AttemptWhereTemplate,
  CompensationBlockRow,
  CompensationId,
  CompensationInfo,
  DeadLetterHandleExternal,
  EntityHandle,
  FindManyResult,
  FindUniqueResult,
  HaltHandle,
  HaltRecord,
  HaltWhereTemplate,
  HandleWithRow,
  HandlerAttemptsReadNamespace,
  IWorkflowConnection,
  OperatorAttemptsNamespaceExternal,
  QueueHandlerAttempt,
  QueueHandlerAttemptWhereTemplate,
  QueueRetentionContext,
  QueueTerminalStatus,
  RequestCompensationEscalateToManualOutcome,
  RequestCompensationHandlerContext,
  RequestCompensationInfo,
  RequestCompensationNamespaceExternal,
  RequestCompensationResultFromBlock,
  RequestCompensationRow,
  RequestCompensationUniqueHandleExternal,
  RequestHandlerAttempt,
  RequestHandlerAttemptWhereTemplate,
  RequestHandleExternal,
  RequestRetentionContext,
  SkipOutcome,
  CompensationBlockNamespaceExternal,
  WorkflowClient,
  WorkflowHandleExternal,
} from "../types";
import type { DeadLetterId, DeadLetterReason, RequestId } from "../types/schema";
import type {
  InferRequestCompensationDef,
  InferRequestCompensationErrors,
  InferRequestErrors,
} from "../types/helpers";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// FIXTURES — compensable / void-comp / plain requests, queue, step undo.
// =============================================================================

type _ForwardErrors = {
  ForwardFail: true;
  ForwardDetail: z.ZodObject<{ code: z.ZodString }>;
};
type _CompErrors = {
  CompFail: true;
  CompDetail: z.ZodObject<{ ticket: z.ZodString }>;
};

const compensableRequest = defineRequest({
  name: "aiuCompensableRequest",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
  errors: {
    ForwardFail: true,
    ForwardDetail: z.object({ code: z.string() }),
  },
  compensation: {
    result: z.object({ undone: z.boolean() }),
    errors: {
      CompFail: true,
      CompDetail: z.object({ ticket: z.string() }),
    },
  },
});

const voidCompRequest = defineRequest({
  name: "aiuVoidCompRequest",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
  compensation: true,
});

const plainRequest = defineRequest({
  name: "aiuPlainRequest",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const emailQueue = defineQueue({
  name: "aiuEmailQueue",
  message: z.object({ userId: z.string() }),
  errors: {
    ProviderDown: true,
    Rejected: z.object({ reason: z.string() }),
  },
});

const chargeStep = defineStep({
  name: "aiuChargeStep",
  args: z.object({ amount: z.number() }),
  result: z.object({ chargeId: z.string() }),
  compensation: {
    async undo(_ctx, _args, info) {
      if (info.status === "completed") {
        type _CompletedAttempts = Assert<
          IsEqual<
            typeof info.attempts,
            HandlerAttemptsReadNamespace<Attempt>
          >
        >;
        void (0 as unknown as _CompletedAttempts);

        const rows = await info.attempts.findMany({
          fields: { attemptNumber: true, type: true },
        });
        void rows[0]?.attemptNumber;
      }
      if (info.status === "timed_out") {
        // @ts-expect-error timed-out forward outcomes do not expose result
        void info.result;
        void info.reason;
        await info.attempts.count();
      }
      if (info.status === "terminated") {
        // @ts-expect-error terminated forward outcomes do not expose result
        void info.result;
        await info.attempts.get(1);
      }
    },
  },
  async execute(args, _opts) {
    return { chargeId: `c-${args.amount}` };
  },
});

const aiuWorkflow = defineWorkflow({
  name: "aiuWorkflow",
  requests: {
    compensable: compensableRequest,
    voidComp: voidCompRequest,
    plain: plainRequest,
  },
  queues: { email: emailQueue },
  steps: { charge: chargeStep },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    await ctx.requests.compensable({ id: "x" });
    return { ok: true };
  },
});

const client = createWorkflowClient({ aiu: aiuWorkflow });

declare const workflowHandle: WorkflowHandleExternal<typeof aiuWorkflow>;
declare const tx: IWorkflowConnection;

// =============================================================================
// ROW TYPES + WHERE TEMPLATES
// =============================================================================

declare const _attemptRow: Attempt;
type _AttemptFields = Assert<
  IsEqual<
    keyof Attempt,
    "attemptNumber" | "startedAt" | "failedAt" | "message" | "type" | "details"
  >
>;
type _AttemptWhere = Assert<IsEqual<AttemptWhereTemplate, Attempt>>;

declare const _requestAttempt: RequestHandlerAttempt<_ForwardErrors>;
type _RequestAttemptHasAttempt = Assert<
  "attemptNumber" extends keyof typeof _requestAttempt ? true : false
>;
type _RequestAttemptHasManual = Assert<
  "manual" extends keyof typeof _requestAttempt ? true : false
>;
type _RequestAttemptWhere = Assert<
  IsEqual<
    RequestHandlerAttemptWhereTemplate<_ForwardErrors>,
    RequestHandlerAttempt<_ForwardErrors>
  >
>;

declare const _queueAttempt: QueueHandlerAttempt<{
  ProviderDown: true;
  Rejected: z.ZodObject<{ reason: z.ZodString }>;
}>;
type _QueueAttemptHasDeadLetter = Assert<
  "deadLetter" extends keyof typeof _queueAttempt ? true : false
>;
type _QueueAttemptWhere = Assert<
  IsEqual<
    QueueHandlerAttemptWhereTemplate<{
      ProviderDown: true;
      Rejected: z.ZodObject<{ reason: z.ZodString }>;
    }>,
    typeof _queueAttempt
  >
>;

declare const _haltRow: HaltRecord;
type _HaltWhere = Assert<IsEqual<HaltWhereTemplate, HaltRecord>>;
type _HaltRecordFields = Assert<
  IsEqual<
    keyof HaltRecord,
    | "id"
    | "workflowId"
    | "afterStepId"
    | "status"
    | "errorType"
    | "errorMessage"
    | "errorStacktrace"
    | "errorDetails"
    | "createdAt"
    | "updatedAt"
  >
>;

// =============================================================================
// HANDLER-RUNTIME ATTEMPT READ NAMESPACE — every method + overload.
// =============================================================================

declare const handlerAttempts: HandlerAttemptsReadNamespace<Attempt>;

async function _exerciseHandlerAttemptsNamespace(): Promise<void> {
  const byNumber = await handlerAttempts.get(1);
  type _Get = Assert<IsEqual<typeof byNumber, FindUniqueResult<Attempt>>>;

  const byNumberMasked = await handlerAttempts.get(1, {
    type: true,
    attemptNumber: true,
  });
  type _GetMasked = Assert<
    IsEqual<
      typeof byNumberMasked,
      FindUniqueResult<Pick<Attempt, "type" | "attemptNumber">>
    >
  >;

  const unique = await handlerAttempts.findUnique(({ attemptNumber }) =>
    gt(attemptNumber, 1),
  );
  type _FindUnique = Assert<IsEqual<typeof unique, FindUniqueResult<Attempt>>>;

  const uniqueMasked = await handlerAttempts.findUnique(
    ({ type }) => eq(type, "NetworkError"),
    { fields: { message: true, failedAt: true } },
  );
  type _FindUniqueMasked = Assert<
    IsEqual<
      typeof uniqueMasked,
      FindUniqueResult<Pick<Attempt, "message" | "failedAt">>
    >
  >;

  const many = await handlerAttempts.findMany({
    sort: [{ path: "attemptNumber", direction: "desc" }],
    limit: 3,
  });
  type _FindMany = Assert<IsEqual<typeof many, readonly Attempt[]>>;

  const manyMasked = await handlerAttempts.findMany({
    fields: { type: true },
    sort: [{ path: "attemptNumber", direction: "asc" }],
  });
  type _FindManyMasked = Assert<
    IsEqual<typeof manyMasked, readonly Pick<Attempt, "type">[]>
  >;

  const viaTrue = await handlerAttempts.findMany(whereTrue);
  type _ViaTrue = Assert<IsEqual<typeof viaTrue, readonly Attempt[]>>;

  const unscopedUnique = await handlerAttempts.findUnique();
  type _UnscopedUnique = Assert<
    IsEqual<typeof unscopedUnique, FindUniqueResult<Attempt>>
  >;

  for (const row of await handlerAttempts.findMany()) {
    type _IterRow = Assert<IsEqual<typeof row, Attempt>>;
    void row.attemptNumber;
  }

  const total = await handlerAttempts.count(({ attemptNumber }) =>
    gt(attemptNumber, 0),
  );
  type _Count = Assert<IsEqual<typeof total, number>>;

  const unscopedCount = await handlerAttempts.count();
  type _UnscopedCount = Assert<IsEqual<typeof unscopedCount, number>>;

  // Handler-runtime namespaces omit `txOrConn`.
  await handlerAttempts.findMany({
    // @ts-expect-error handler attempt queries do not accept txOrConn
    txOrConn: tx,
  });
}
void _exerciseHandlerAttemptsNamespace;

declare const handlerRequestAttempts: HandlerAttemptsReadNamespace<
  RequestHandlerAttempt<_ForwardErrors>
>;

async function _exerciseHandlerRequestAttempts(): Promise<void> {
  const rows = await handlerRequestAttempts.findMany(
    ({ code, manual }) => and(eq(manual, true), eq(code, "ForwardFail")),
    { fields: { message: true, code: true } },
  );
  type _Row = Assert<
    IsEqual<
      (typeof rows)[number],
      Pick<RequestHandlerAttempt<_ForwardErrors>, "message" | "code">
    >
  >;
  void (0 as unknown as _Row);
}
void _exerciseHandlerRequestAttempts;

// =============================================================================
// OPERATOR ATTEMPT NAMESPACE — every method + overload + AttemptHandle.
// =============================================================================

declare const operatorAttempts: OperatorAttemptsNamespaceExternal<Attempt>;

async function _exerciseOperatorAttemptsNamespace(): Promise<void> {
  const syncHandle = operatorAttempts.get(3);
  type _SyncGet = Assert<IsEqual<typeof syncHandle, AttemptHandle<Attempt>>>;

  // @ts-expect-error get is identity-only; prefetch via findUnique/findMany fields
  void operatorAttempts.get(3, { type: true, message: true });

  const found = await operatorAttempts.findUnique(({ attemptNumber }) =>
    eq(attemptNumber, 2),
  );
  type _FindUniqueHandle = Assert<
    IsEqual<typeof found, FindUniqueResult<AttemptHandle<Attempt>>>
  >;

  const foundWithRow = await operatorAttempts.findUnique({
    fields: { failedAt: true },
  });
  type _FindUniqueWithRow = Assert<
    IsEqual<
      typeof foundWithRow,
      FindUniqueResult<
        HandleWithRow<AttemptHandle<Attempt>, Pick<Attempt, "failedAt">>
      >
    >
  >;

  const handles = await operatorAttempts.findMany({
    txOrConn: tx,
    limit: 5,
  });
  type _FindManyHandles = Assert<
    IsEqual<typeof handles, readonly AttemptHandle<Attempt>[]>
  >;

  const handlesWithRow = await operatorAttempts.findMany({
    fields: { type: true },
    txOrConn: tx,
  });
  type _FindManyWithRow = Assert<
    IsEqual<
      (typeof handlesWithRow)[number],
      HandleWithRow<AttemptHandle<Attempt>, Pick<Attempt, "type">>
    >
  >;

  for (const handle of await operatorAttempts.findMany()) {
    type _IterHandle = Assert<IsEqual<typeof handle, AttemptHandle<Attempt>>>;
    const row = await handle.fetchRow({ fields: { startedAt: true } });
    type _Fetch = Assert<
      IsEqual<
        typeof row,
        FindUniqueResult<Pick<Attempt, "startedAt">>
      >
    >;
    void (0 as unknown as _Fetch);
  }

  const total = await operatorAttempts.count({ txOrConn: tx });
  type _Count = Assert<IsEqual<typeof total, number>>;

  type _EntityHandleAlias = Assert<
    IsEqual<AttemptHandle<Attempt>, EntityHandle<Attempt, number>>
  >;
  void (0 as unknown as _EntityHandleAlias);

  type _SyncHandleId = Assert<IsEqual<(typeof syncHandle)["id"], number>>;
  void (0 as unknown as _SyncHandleId);

  const freshRow = await syncHandle.fetchRow({
    fields: { attemptNumber: true },
    txOrConn: tx,
  });
  type _FetchRowMasked = Assert<
    IsEqual<
      typeof freshRow,
      FindUniqueResult<Pick<Attempt, "attemptNumber">>
    >
  >;
  void (0 as unknown as _FetchRowMasked);
}
void _exerciseOperatorAttemptsNamespace;

// =============================================================================
// HALTS NAMESPACE + HALT HANDLE — full QueryableNamespace surface.
// =============================================================================

async function _exerciseHaltsNamespace(): Promise<void> {
  const syncHalt = workflowHandle.halts.get(42);
  type _SyncHalt = Assert<IsEqual<typeof syncHalt, HaltHandle>>;

  // @ts-expect-error get is identity-only; prefetch via findUnique/findMany fields
  void workflowHandle.halts.get(42, {
    status: true,
    errorMessage: true,
  });

  const found = await workflowHandle.halts.findUnique(
    ({ status, afterStepId }) =>
      and(eq(status, "pending"), eq(afterStepId, 10)),
    { txOrConn: tx },
  );
  type _FoundHalt = Assert<IsEqual<typeof found, FindUniqueResult<HaltHandle>>>;

  const foundWithRow = await workflowHandle.halts.findUnique({
    fields: { errorType: true, workflowId: true },
    txOrConn: tx,
  });
  type _FoundHaltRow = Assert<
    IsEqual<
      typeof foundWithRow,
      FindUniqueResult<
        HandleWithRow<HaltHandle, Pick<HaltRecord, "errorType" | "workflowId">>
      >
    >
  >;

  const many = workflowHandle.halts.findMany({ txOrConn: tx });
  type _ManyHalts = Assert<IsEqual<typeof many, FindManyResult<HaltHandle>>>;

  const handles = await many;
  type _AwaitedHalts = Assert<IsEqual<typeof handles, readonly HaltHandle[]>>;

  for (const haltHandle of await many) {
    type _HaltId = Assert<IsEqual<(typeof haltHandle)["id"], number>>;
    void (0 as unknown as _HaltId);

    const row = await haltHandle.fetchRow();
    type _FullRow = Assert<IsEqual<typeof row, FindUniqueResult<HaltRecord>>>;
    void (0 as unknown as _FullRow);

    const masked = await haltHandle.fetchRow({
      fields: { status: true, errorMessage: true },
      txOrConn: tx,
    });
    type _MaskedRow = Assert<
      IsEqual<
        typeof masked,
        FindUniqueResult<Pick<HaltRecord, "status" | "errorMessage">>
      >
    >;
    void (0 as unknown as _MaskedRow);
  }

  const total = await workflowHandle.halts.count(
    ({ status }) => eq(status, "resolved"),
    { txOrConn: tx },
  );
  type _HaltCount = Assert<IsEqual<typeof total, number>>;

  // @ts-expect-error halts namespace has no skip()
  void workflowHandle.halts.skip;
}
void _exerciseHaltsNamespace;

// =============================================================================
// FORWARD REQUEST HANDLE — attempts on all requests; `.compensation` conditional.
// =============================================================================

type _CompRequestHandle = RequestHandleExternal<
  "aiuCompensableRequest",
  { id: string },
  { ok: boolean },
  { ok: boolean },
  InferRequestErrors<typeof compensableRequest>,
  InferRequestCompensationDef<typeof compensableRequest>,
  InferRequestCompensationErrors<typeof compensableRequest>,
  RequestCompensationResultFromBlock<
    InferRequestCompensationDef<typeof compensableRequest>
  >
>;

type _PlainRequestHandle = RequestHandleExternal<
  "aiuPlainRequest",
  { id: string },
  { ok: boolean },
  { ok: boolean },
  Record<string, never>,
  undefined,
  Record<string, never>,
  unknown
>;

type _CompHasCompensationProperty = Assert<
  "compensation" extends keyof _CompRequestHandle ? true : false
>;
type _PlainOmitsCompensation = Assert<
  "compensation" extends keyof _PlainRequestHandle ? false : true
>;

async function _exerciseForwardRequestHandles(): Promise<void> {
  const compId = "req-1" as RequestId<"aiuCompensableRequest">;
  const compHandle = client.requests.aiuCompensableRequest.get(compId);
  type _Handle = Assert<IsEqual<typeof compHandle, _CompRequestHandle>>;

  type _ForwardAttemptsNs = Assert<
    IsEqual<
      typeof compHandle.attempts,
      OperatorAttemptsNamespaceExternal<
        RequestHandlerAttempt<InferRequestErrors<typeof compensableRequest>>
      >
    >
  >;
  void (0 as unknown as _ForwardAttemptsNs);

  await compHandle.attempts.findMany(
    ({ code }) => eq(code, "ForwardFail"),
    { fields: { manual: true, message: true }, txOrConn: tx },
  );

  await compHandle.compensation.fetchRow({
    fields: { status: true, payload: true },
  });
  const compSkip: SkipOutcome = await compHandle.compensation.skip({
    undone: true,
  });
  void compSkip;

  const compEscalation: RequestCompensationEscalateToManualOutcome =
    await compHandle.compensation.escalateToManual({
      code: "CompFail",
      message: "Needs operator",
    });
  void compEscalation;

  type _CompAttemptsUseCompErrors = Assert<
    IsEqual<
      typeof compHandle.compensation.attempts,
      OperatorAttemptsNamespaceExternal<
        RequestHandlerAttempt<
          InferRequestCompensationErrors<typeof compensableRequest>
        >
      >
    >
  >;
  void (0 as unknown as _CompAttemptsUseCompErrors);

  await compHandle.compensation.attempts.findMany(
    ({ code }) => eq(code, "CompFail"),
    { txOrConn: tx },
  );

  const plainId = "req-2" as RequestId<"aiuPlainRequest">;
  const plainHandle = client.requests.aiuPlainRequest.get(plainId);
  type _PlainHandle = Assert<IsEqual<typeof plainHandle, _PlainRequestHandle>>;
  // @ts-expect-error non-compensable requests omit `.compensation`
  void plainHandle.compensation;
  await plainHandle.attempts.count();

  const voidId = "req-3" as RequestId<"aiuVoidCompRequest">;
  const voidHandle = client.requests.aiuVoidCompRequest.get(voidId);
  await voidHandle.compensation.skip();
  // @ts-expect-error void compensation skip does not accept a result argument
  await voidHandle.compensation.skip({ undone: true });
}
void _exerciseForwardRequestHandles;

// =============================================================================
// REQUEST COMPENSATION INFO — all forward-outcome variants + forward error typing.
// =============================================================================

type _ForwardInfoCompleted = RequestCompensationInfo<
  { ok: boolean },
  InferRequestErrors<typeof compensableRequest>
>;
type _CompletedHasResponse = Assert<
  Extract<_ForwardInfoCompleted, { status: "completed" }> extends {
    response: { ok: boolean };
    attempts: HandlerAttemptsReadNamespace<
      RequestHandlerAttempt<InferRequestErrors<typeof compensableRequest>>
    >;
  }
    ? true
    : false
>;

type _ForwardInfoTimedOut = Extract<
  RequestCompensationInfo<
    { ok: boolean },
    InferRequestErrors<typeof compensableRequest>
  >,
  { status: "timed_out" }
>;
type _TimedOutHasReason = Assert<
  IsEqual<
    _ForwardInfoTimedOut["reason"],
    "attempts_exhausted" | "deadline"
  >
>;

type _ForwardInfoTerminated = Extract<
  RequestCompensationInfo<
    { ok: boolean },
    InferRequestErrors<typeof compensableRequest>
  >,
  { status: "terminated" }
>;
type _TerminatedHasAttempts = Assert<
  "attempts" extends keyof _ForwardInfoTerminated ? true : false
>;

type _ForwardInfoTimedOutAttempts = Assert<
  IsEqual<
    _ForwardInfoTimedOut["attempts"],
    HandlerAttemptsReadNamespace<
      RequestHandlerAttempt<InferRequestErrors<typeof compensableRequest>>
    >
  >
>;

type _ForwardInfoTerminatedAttempts = Assert<
  IsEqual<
    _ForwardInfoTerminated["attempts"],
    HandlerAttemptsReadNamespace<
      RequestHandlerAttempt<InferRequestErrors<typeof compensableRequest>>
    >
  >
>;

client.requests.aiuCompensableRequest.registerHandler(
  async () => ({ ok: true }),
  {
    compensation: {
      handler: async (ctx) => {
        type _Ctx = Assert<
          typeof ctx extends RequestCompensationHandlerContext<
            InferRequestCompensationErrors<typeof compensableRequest>,
            { id: string },
            { ok: boolean },
            InferRequestErrors<typeof compensableRequest>
          >
            ? true
            : false
        >;
        void (0 as unknown as _Ctx);

        if (ctx.forward.status === "completed") {
          void ctx.forward.response.ok;
          await ctx.forward.attempts.findMany({
            fields: { code: true },
          });
          return { undone: !ctx.forward.response.ok };
        }
        return { undone: false };
      },
      retryPolicy: { timeoutSeconds: 30 },
    },
  },
);

// =============================================================================
// RETENTION CONTEXTS — handler-runtime attempt namespaces on finalize.
// =============================================================================

type _QueueRetention = Assert<
  IsEqual<
    QueueRetentionContext<
      InferRequestErrors<typeof emailQueue>,
      { userId: string }
    >,
    {
      readonly status: QueueTerminalStatus;
      readonly reason: DeadLetterReason | null;
      readonly message: { userId: string };
      readonly attempts: HandlerAttemptsReadNamespace<
        QueueHandlerAttempt<InferRequestErrors<typeof emailQueue>>
      >;
    }
  >
>;

type _RequestRetention = Assert<
  RequestRetentionContext<
    InferRequestErrors<typeof compensableRequest>,
    { id: string },
    { ok: boolean }
  > extends
    | {
        readonly status: "resolved";
        readonly payload: { id: string };
        readonly response: { ok: boolean };
        readonly attempts: HandlerAttemptsReadNamespace<
          RequestHandlerAttempt<
            InferRequestErrors<typeof compensableRequest>
          >
        >;
      }
    | {
        readonly status: "timedOut";
        readonly payload: { id: string };
        readonly attempts: HandlerAttemptsReadNamespace<
          RequestHandlerAttempt<
            InferRequestErrors<typeof compensableRequest>
          >
        >;
      }
    ? true
    : false
>;

client.queues.aiuEmailQueue.registerHandler(async () => undefined, {
  retryPolicy: { maxAttempts: 2 },
  retentionPolicy: async (ctx) => {
    type _Ctx = Assert<typeof ctx extends QueueRetentionContext<
      InferRequestErrors<typeof emailQueue>,
      { userId: string }
    > ? true : false>;
    void (0 as unknown as _Ctx);
    await ctx.attempts.get(1, { attemptNumber: true, type: true });
    return null;
  },
});

client.requests.aiuCompensableRequest.registerHandler(async () => ({ ok: true }), {
  retryPolicy: { maxAttempts: 1 },
  retentionPolicy: async (ctx) => {
    if (ctx.status === "resolved") {
      void ctx.response.ok;
    }
    await ctx.attempts.findUnique(({ attemptNumber }) => eq(attemptNumber, 1));
    return 3600;
  },
});

// =============================================================================
// DEAD-LETTER HANDLE — operator attempt namespace.
// =============================================================================

async function _exerciseDeadLetterAttempts(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- regression-only branded id
  const deadLetterId = "dl-1" as DeadLetterId<"aiuEmailQueue">;
  const handle: DeadLetterHandleExternal<
    "aiuEmailQueue",
    { userId: string },
    InferRequestErrors<typeof emailQueue>
  > = client.queues.aiuEmailQueue.deadLetters.get(deadLetterId);

  type _AttemptsNs = Assert<
    IsEqual<
      typeof handle.attempts,
      OperatorAttemptsNamespaceExternal<
        QueueHandlerAttempt<InferRequestErrors<typeof emailQueue>>
      >
    >
  >;
  void (0 as unknown as _AttemptsNs);

  // @ts-expect-error get is identity-only; prefetch via findUnique/findMany fields
  void handle.attempts.get(1, { code: true, deadLetter: true });

  await handle.attempts.findMany(
    ({ deadLetter }) => eq(deadLetter, true),
    { txOrConn: tx },
  );
}
void _exerciseDeadLetterAttempts;

// =============================================================================
// COMPENSATION BLOCK ROW — `halt` column removed; use `workflow.halts`.
// =============================================================================

declare const _compBlockRow: CompensationBlockRow<
  "aiuChargeStep",
  { amount: number },
  { undone: boolean }
>;
type _CompBlockHasHaltedAt = Assert<
  "haltedAt" extends keyof typeof _compBlockRow ? true : false
>;
// @ts-expect-error compensation block rows no longer embed a halt snapshot
void _compBlockRow.halt;

declare const _compBlockHandle: RequestCompensationUniqueHandleExternal<
  { id: string },
  { undone: boolean },
  _CompErrors
>;
type _CompBlockHandleId = Assert<
  IsEqual<
    typeof _compBlockHandle,
    RequestCompensationUniqueHandleExternal<
      { id: string },
      { undone: boolean },
      _CompErrors
    >
  >
>;
type _CompBlockHandleHasId = Assert<
  "id" extends keyof typeof _compBlockHandle ? true : false
>;
void (0 as unknown as _CompBlockHandleId);
void (0 as unknown as _CompBlockHandleHasId);

async function _exerciseCompBlockHandleFetchRow(): Promise<void> {
  const row = await _compBlockHandle.fetchRow({
    fields: { status: true, payload: true },
  });
  type _Row = Assert<
    IsEqual<
      typeof row,
      FindUniqueResult<
        Pick<
          RequestCompensationRow<{ id: string }, { undone: boolean }>,
          "status" | "payload"
        >
      >
    >
  >;
  void (0 as unknown as _Row);
}
void _exerciseCompBlockHandleFetchRow;

declare const _compId: CompensationId<"aiuChargeStep">;
void _compId;

// =============================================================================
// COMPENSATION INFO (STEP) — attempts namespace on every variant.
// =============================================================================

type _StepCompInfoCompleted = Extract<
  CompensationInfo<{ chargeId: string }>,
  { status: "completed" }
>;
type _StepCompInfoAttempts = Assert<
  IsEqual<
    _StepCompInfoCompleted["attempts"],
    HandlerAttemptsReadNamespace<Attempt>
  >
>;

type _StepCompInfoTimedOut = Extract<
  CompensationInfo<{ chargeId: string }>,
  { status: "timed_out" }
>;
type _StepTimedOutAttempts = Assert<
  IsEqual<
    _StepCompInfoTimedOut["attempts"],
    HandlerAttemptsReadNamespace<Attempt>
  >
>;
type _StepTimedOutReason = Assert<
  IsEqual<
    _StepCompInfoTimedOut["reason"],
    "attempts_exhausted" | "deadline"
  >
>;

type _StepCompInfoTerminated = Extract<
  CompensationInfo<{ chargeId: string }>,
  { status: "terminated" }
>;
type _StepTerminatedAttempts = Assert<
  IsEqual<
    _StepCompInfoTerminated["attempts"],
    HandlerAttemptsReadNamespace<Attempt>
  >
>;
type _StepTerminatedNoResult = Assert<
  "result" extends keyof _StepCompInfoTerminated ? false : true
>;
void (0 as unknown as _StepTerminatedNoResult);

// =============================================================================
// CLIENT-LEVEL COMPENSATION NAMESPACES — global L1 search keyed by definition name.
// =============================================================================

type _ClientCompensationRequestKeys = Assert<
  IsEqual<
    keyof typeof client.compensations.requests,
    "aiuCompensableRequest" | "aiuVoidCompRequest"
  >
>;
type _ClientCompensationStepKeys = Assert<
  IsEqual<keyof typeof client.compensations.steps, "aiuChargeStep">
>;

type _DirectClientStepNs =
  WorkflowClient<{ aiu: typeof aiuWorkflow }>["compensations"]["steps"]["aiuChargeStep"];

type _DirectStepCompNs = Assert<
  _DirectClientStepNs extends CompensationBlockNamespaceExternal<
    "aiuChargeStep",
    { amount: number },
    void
  >
    ? true
    : false
>;

type _VoidCompNs = Assert<
  IsEqual<
    typeof client.compensations.requests.aiuVoidCompRequest,
    RequestCompensationNamespaceExternal<{ id: string }, void>
  >
>;

async function _exerciseClientCompensationNamespaces(): Promise<void> {
  const found = await client.compensations.requests.aiuCompensableRequest.findUnique();
  if (found.status === "unique") {
    void found.value.id;
    await found.value.fetchRow({ fields: { status: true } });
    await found.value.attempts.findMany(
      ({ code }) => eq(code, "CompFail"),
      { txOrConn: tx },
    );
  }

  const blocks = await client.compensations.steps.aiuChargeStep.findMany({
    limit: 10,
    txOrConn: tx,
  });
  type _Blocks = Assert<
    IsEqual<
      (typeof blocks)[number]["id"],
      CompensationId<"aiuChargeStep">
    >
  >;
  void (0 as unknown as _Blocks);

  // @ts-expect-error non-compensable request definitions are absent from client.compensations.requests
  void client.compensations.requests.aiuPlainRequest;
  // @ts-expect-error workflow slot keys are not valid on client-level namespaces
  void client.compensations.steps.charge;
}
void _exerciseClientCompensationNamespaces;

// =============================================================================
// REMOVED PUBLIC ACCESSOR INTERFACES
// =============================================================================

// @ts-expect-error AttemptAccessor was removed
import type { AttemptAccessor as _RemovedAttemptAccessor } from "../types";
// @ts-expect-error RequestHandlerAttemptAccessor was removed
import type { RequestHandlerAttemptAccessor as _RemovedRequestAttemptAccessor } from "../types";
// @ts-expect-error QueueHandlerAttemptAccessor was removed
import type { QueueHandlerAttemptAccessor as _RemovedQueueAttemptAccessor } from "../types";

void client;
void chargeStep;
void _attemptRow;
void _haltRow;
