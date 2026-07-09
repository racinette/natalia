import { z } from "zod";
import { createTestWorkflowClient } from "./test-client";
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
  HaltHandle,
  HaltRecord,
  HaltWhereTemplate,
  HandleWithRow,
  HandlerAttemptsReadNamespace,
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
import { session } from "./test-session";

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

        const rows = await info.attempts.find({
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
  args: z.undefined(),
  metadata: z.undefined(),
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

const client = createTestWorkflowClient({ aiu: aiuWorkflow });

declare const workflowHandle: WorkflowHandleExternal<typeof aiuWorkflow>;

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
  const _byNumber = await handlerAttempts.get(1);
  type _Get = Assert<IsEqual<typeof _byNumber, Attempt | undefined>>;

  const _byNumberMasked = await handlerAttempts.get(1, {
    type: true,
    attemptNumber: true,
  });
  type _GetMasked = Assert<
    IsEqual<
      typeof _byNumberMasked,
      Pick<Attempt, "type" | "attemptNumber"> | undefined
    >
  >;

  const _filtered = await handlerAttempts.find(({ attemptNumber }) =>
    gt(attemptNumber, 1),
  );
  type _FindFiltered = Assert<IsEqual<typeof _filtered, readonly Attempt[]>>;

  const _filteredMasked = await handlerAttempts.find(
    ({ type }) => eq(type, "NetworkError"),
    { fields: { message: true, failedAt: true } },
  );
  type _FindMasked = Assert<
    IsEqual<
      typeof _filteredMasked,
      readonly Pick<Attempt, "message" | "failedAt">[]
    >
  >;

  const _many = await handlerAttempts.find({
    sort: [{ path: "attemptNumber", direction: "desc" }],
    limit: 3,
  });
  type _FindMany = Assert<IsEqual<typeof _many, readonly Attempt[]>>;

  const _manyMasked = await handlerAttempts.find({
    fields: { type: true },
    sort: [{ path: "attemptNumber", direction: "asc" }],
  });
  type _FindManyMasked = Assert<
    IsEqual<typeof _manyMasked, readonly Pick<Attempt, "type">[]>
  >;

  const _viaTrue = await handlerAttempts.find(whereTrue);
  type _ViaTrue = Assert<IsEqual<typeof _viaTrue, readonly Attempt[]>>;

  const _unscoped = await handlerAttempts.find();
  type _UnscopedFind = Assert<IsEqual<typeof _unscoped, readonly Attempt[]>>;

  for (const row of await handlerAttempts.find()) {
    type _IterRow = Assert<IsEqual<typeof row, Attempt>>;
    void row.attemptNumber;
  }

  const _total = await handlerAttempts.count(({ attemptNumber }) =>
    gt(attemptNumber, 0),
  );
  type _Count = Assert<IsEqual<typeof _total, number>>;

  const _unscopedCount = await handlerAttempts.count();
  type _UnscopedCount = Assert<IsEqual<typeof _unscopedCount, number>>;

  // Handler-runtime namespaces omit operator session.
  await handlerAttempts.find(
    // @ts-expect-error handler attempt queries do not accept session
    session,
  );
}
void _exerciseHandlerAttemptsNamespace;

declare const handlerRequestAttempts: HandlerAttemptsReadNamespace<
  RequestHandlerAttempt<_ForwardErrors>
>;

async function _exerciseHandlerRequestAttempts(): Promise<void> {
  const _rows = await handlerRequestAttempts.find(
    ({ code, manual }) => and(eq(manual, true), eq(code, "ForwardFail")),
    { fields: { message: true, code: true } },
  );
  type _Row = Assert<
    IsEqual<
      (typeof _rows)[number],
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

  // @ts-expect-error get is identity-only; prefetch via find fields
  void operatorAttempts.get(3, { type: true, message: true });

  const _handlesByQuery = await operatorAttempts.find(session, ({ attemptNumber }) =>
    eq(attemptNumber, 2),
  );
  type _FindHandles = Assert<
    IsEqual<typeof _handlesByQuery, readonly AttemptHandle<Attempt>[]>
  >;

  const _handlesWithRow = await operatorAttempts.find(session, {
    fields: { failedAt: true },
  });
  type _FindWithRow = Assert<
    IsEqual<
      (typeof _handlesWithRow)[number],
      HandleWithRow<AttemptHandle<Attempt>, Pick<Attempt, "failedAt">>
    >
  >;

  const _handles = await operatorAttempts.find(session, {
    limit: 5,
  });
  type _FindHandlesLimited = Assert<
    IsEqual<typeof _handles, readonly AttemptHandle<Attempt>[]>
  >;

  const _handlesWithRow2 = await operatorAttempts.find(session, {
    fields: { type: true },
  });
  type _FindManyWithRow = Assert<
    IsEqual<
      (typeof _handlesWithRow2)[number],
      HandleWithRow<AttemptHandle<Attempt>, Pick<Attempt, "type">>
    >
  >;

  for (const handle of await operatorAttempts.find(session)) {
    type _IterHandle = Assert<IsEqual<typeof handle, AttemptHandle<Attempt>>>;
    const _row = await handle.fetchRow(session, { fields: { startedAt: true } });
    type _Fetch = Assert<
      IsEqual<typeof _row, Pick<Attempt, "startedAt"> | undefined>
    >;
    void (0 as unknown as _Fetch);
  }

  const _total = await operatorAttempts.count(session);
  type _Count = Assert<IsEqual<typeof _total, number>>;

  type _EntityHandleAlias = Assert<
    IsEqual<AttemptHandle<Attempt>, EntityHandle<Attempt, number>>
  >;
  void (0 as unknown as _EntityHandleAlias);

  type _SyncHandleId = Assert<IsEqual<(typeof syncHandle)["id"], number>>;
  void (0 as unknown as _SyncHandleId);

  const _freshRow = await syncHandle.fetchRow(session, {
    fields: { attemptNumber: true },
  });
  type _FetchRowMasked = Assert<
    IsEqual<typeof _freshRow, Pick<Attempt, "attemptNumber"> | undefined>
  >;
  void (0 as unknown as _FetchRowMasked);
}
void _exerciseOperatorAttemptsNamespace;

// =============================================================================
// HALTS NAMESPACE + HALT HANDLE — full QueryableNamespace surface.
// =============================================================================

async function _exerciseHaltsNamespace(): Promise<void> {
  const _syncHalt = workflowHandle.halts.get(42);
  type _SyncHalt = Assert<IsEqual<typeof _syncHalt, HaltHandle>>;

  // @ts-expect-error get is identity-only; prefetch via find fields
  void workflowHandle.halts.get(42, {
    status: true,
    errorMessage: true,
  });

  const _found = await workflowHandle.halts.find(
    session,
    ({ status, afterStepId }) =>
      and(eq(status, "pending"), eq(afterStepId, 10)),
  );
  type _FoundHalts = Assert<IsEqual<typeof _found, readonly HaltHandle[]>>;

  const _foundWithRow = await workflowHandle.halts.find(session, {
    fields: { errorType: true, workflowId: true },
  });
  type _FoundHaltRow = Assert<
    IsEqual<
      (typeof _foundWithRow)[number],
      HandleWithRow<HaltHandle, Pick<HaltRecord, "errorType" | "workflowId">>
    >
  >;

  const many = await workflowHandle.halts.find(session);
  type _ManyHalts = Assert<IsEqual<typeof many, readonly HaltHandle[]>>;

  for (const haltHandle of many) {
    type _HaltId = Assert<IsEqual<(typeof haltHandle)["id"], number>>;
    void (0 as unknown as _HaltId);

    const _row = await haltHandle.fetchRow(session);
    type _FullRow = Assert<IsEqual<typeof _row, HaltRecord | undefined>>;
    void (0 as unknown as _FullRow);

    const _masked = await haltHandle.fetchRow(session, {
      fields: { status: true, errorMessage: true },
    });
    type _MaskedRow = Assert<
      IsEqual<
        typeof _masked,
        Pick<HaltRecord, "status" | "errorMessage"> | undefined
      >
    >;
    void (0 as unknown as _MaskedRow);
  }

  const _total = await workflowHandle.halts.count(
    session,
    ({ status }) => eq(status, "resolved"),
  );
  type _HaltCount = Assert<IsEqual<typeof _total, number>>;

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

  await compHandle.attempts.find(
    session,
    ({ code }) => eq(code, "ForwardFail"),
    { fields: { manual: true, message: true } },
  );

  await compHandle.compensation.fetchRow(session, {
    fields: { status: true, payload: true },
  });
  const compSkip: SkipOutcome = await compHandle.compensation.skip(session, {
    undone: true,
  });
  void compSkip;

  const compEscalation: RequestCompensationEscalateToManualOutcome =
    await compHandle.compensation.escalateToManual(session, {
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

  await compHandle.compensation.attempts.find(
    session,
    ({ code }) => eq(code, "CompFail"),
  );

  const plainId = "req-2" as RequestId<"aiuPlainRequest">;
  const plainHandle = client.requests.aiuPlainRequest.get(plainId);
  type _PlainHandle = Assert<IsEqual<typeof plainHandle, _PlainRequestHandle>>;
  // @ts-expect-error non-compensable requests omit `.compensation`
  void plainHandle.compensation;
  await plainHandle.attempts.count(session);

  const voidId = "req-3" as RequestId<"aiuVoidCompRequest">;
  const voidHandle = client.requests.aiuVoidCompRequest.get(voidId);
  await voidHandle.compensation.skip(session);
  // @ts-expect-error void compensation skip does not accept a result argument
  await voidHandle.compensation.skip(session, { undone: true });
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
  async (_ctx) => ({ ok: true }),
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
          await ctx.forward.attempts.find({
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

client.queues.aiuEmailQueue.registerHandler(async (_ctx) => undefined, {
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

client.requests.aiuCompensableRequest.registerHandler(async (_ctx) => ({ ok: true }), {
  retryPolicy: { maxAttempts: 1 },
  retentionPolicy: async (ctx) => {
    if (ctx.status === "resolved") {
      void ctx.response.ok;
    }
    await ctx.attempts.find(({ attemptNumber }) => eq(attemptNumber, 1));
    return 3600;
  },
});

// =============================================================================
// DEAD-LETTER HANDLE — operator attempt namespace.
// =============================================================================

async function _exerciseDeadLetterAttempts(): Promise<void> {
   
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

  // @ts-expect-error get is identity-only; prefetch via find fields
  void handle.attempts.get(1, { code: true, deadLetter: true });

  await handle.attempts.find(
    session,
    ({ deadLetter }) => eq(deadLetter, true),
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
  const _row = await _compBlockHandle.fetchRow(session, {
    fields: { status: true, payload: true },
  });
  type _Row = Assert<
    IsEqual<
      typeof _row,
      | Pick<
          RequestCompensationRow<{ id: string }, { undone: boolean }>,
          "status" | "payload"
        >
      | undefined
    >
  >;
  void (0 as unknown as _Row);
}
void _exerciseCompBlockHandleFetchRow;

declare const _compId: CompensationId<typeof chargeStep>;
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
    typeof chargeStep,
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
  const handles =
    await client.compensations.requests.aiuCompensableRequest.find(session);
  const found = handles[0];
  if (found) {
    void found.id;
    await found.fetchRow(session, { fields: { status: true } });
    await found.attempts.find(
      session,
      ({ code }) => eq(code, "CompFail"),
    );
  }

  const _blocks = await client.compensations.steps.aiuChargeStep.find(session, {
    limit: 10,
  });
  type _Blocks = Assert<
    IsEqual<
      (typeof _blocks)[number]["id"],
      CompensationId<typeof chargeStep>
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
