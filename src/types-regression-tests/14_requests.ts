import { z } from "zod";
import { createWorkflowClient } from "../client";
import { and, eq } from "../search";
import {
  defineRequest,
  defineWorkflow,
  RequestHandlerDeclaredError,
} from "../workflow";
import type {
  BaseError,
  DeclaredRequestHandlerAttempt,
  FindManyResult,
  FindUniqueResult,
  HandleWithRow,
  RequestCompensationHandlerContext,
  RequestCompensationInfo,
  RequestHandlerAttempt,
  RequestHandlerAttemptAccessor,
  RequestHandlerAttemptDetails,
  RequestHandlerContext,
  RequestHandlerRegistrationOptions,
  RequestManualEscalationInput,
  RequestRetentionContext,
  RequestRetentionPolicy,
  RequestTerminalStatus,
  RequestHandleExternal,
  RequestNamespaceExternal,
  RequestRow,
  UnhandledRequestHandlerAttempt,
  Unsubscribe,
} from "../types";
import type { RequestId } from "../types/schema";
import type {
  HasRequestCompensationErrors,
  HasRequestErrors,
  InferRequestCompensationDef,
  InferRequestCompensationErrors,
  InferRequestErrors,
} from "../types/helpers";
import type { Assert, IsEqual } from "./type-assertions";

const approvalRequest = defineRequest({
  name: "approvalRequestAcceptance",
  payload: z.object({ documentId: z.string(), tenantId: z.string() }),
  response: z.object({ approved: z.boolean(), reviewerId: z.string() }),
  errors: {
    NeedsHumanReview: true,
    RulesEngineRejected: z.object({ ruleId: z.string() }),
  },
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
    errors: {
      ReleaseBlocked: true,
      ProviderUnavailable: z.object({ provider: z.string() }),
    },
  },
});

type _ApprovalRequestErrors = {
  NeedsHumanReview: true;
  RulesEngineRejected: z.ZodObject<{ ruleId: z.ZodString }>;
};
void (0 as unknown as _ApprovalRequestErrors);

type _ApprovalRequestErrorsInferred = Assert<
  IsEqual<
    InferRequestErrors<typeof approvalRequest>,
    {
      NeedsHumanReview: true;
      RulesEngineRejected: z.ZodObject<{
        ruleId: z.ZodString;
      }>;
    }
  >
>;

type _ApprovalCompensationErrorsInferred = Assert<
  IsEqual<
    InferRequestCompensationErrors<typeof approvalRequest>,
    {
      ReleaseBlocked: true;
      ProviderUnavailable: z.ZodObject<{
        provider: z.ZodString;
      }>;
    }
  >
>;

const pingRequest = defineRequest({
  name: "pingRequestAcceptance",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

type _ApprovalHasErrors = Assert<IsEqual<HasRequestErrors<typeof approvalRequest>, true>>;
type _PingHasErrors = Assert<IsEqual<HasRequestErrors<typeof pingRequest>, false>>;
type _ApprovalCompHasErrors = Assert<
  IsEqual<HasRequestCompensationErrors<typeof approvalRequest>, true>
>;

export const requestsAcceptanceWorkflow = defineWorkflow({
  name: "requestsAcceptance",
  requests: { approval: approvalRequest, ping: pingRequest },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    const direct = await ctx.requests.approval({
      documentId: "doc-1",
      tenantId: "tenant-1",
    });
    type _DirectResponse = Assert<
      IsEqual<typeof direct, { approved: boolean; reviewerId: string }>
    >;

    const timed = await ctx.requests.approval(
      { documentId: "doc-2", tenantId: "tenant-1" },
      { priority: 5, timeout: 3600 },
    );
    type _TimedResponse = Assert<
      IsEqual<
        typeof timed,
        | { ok: true; result: { approved: boolean; reviewerId: string } }
        | { ok: false; status: "timeout" }
      >
    >;
    void timed;

    // @ts-expect-error request payload is schema-checked
    await ctx.requests.approval({ documentId: "doc-3" });
    // @ts-expect-error priority belongs in options
    ctx.requests.approval({ documentId: "doc-4", tenantId: "tenant-1" }).priority(1);

    return { ok: direct.approved };
  },
});

const client = createWorkflowClient({ requestsAcceptance: requestsAcceptanceWorkflow });

type _RequestNamespace = Assert<
  IsEqual<
    typeof client.requests.approvalRequestAcceptance,
    RequestNamespaceExternal<
      "approvalRequestAcceptance",
      { documentId: string; tenantId: string },
      { approved: boolean; reviewerId: string },
      { approved: boolean; reviewerId: string },
      InferRequestErrors<typeof approvalRequest>,
      InferRequestCompensationDef<typeof approvalRequest>,
      InferRequestCompensationErrors<typeof approvalRequest>
    >
  >
>;

// @ts-expect-error workflow-local request aliases do not become client namespaces
void client.requests.approval;

// =============================================================================
// `ctx.errors` — FORWARD REQUEST HANDLER ERROR FACTORIES
// =============================================================================

type _RulesEngineRejectedDetails = { ruleId: string };

type _DetailsShape = Assert<
  IsEqual<
    RequestHandlerAttemptDetails<_RulesEngineRejectedDetails>,
    | {
        readonly ok: true;
        readonly status: "serialized";
        readonly result: _RulesEngineRejectedDetails;
      }
    | {
        readonly ok: false;
        readonly status: "serialization_error";
        readonly error: BaseError;
      }
    | { readonly ok: false; readonly status: "unspecified" }
  >
>;

type _DeclaredTrueAttempt = Assert<
  IsEqual<
    DeclaredRequestHandlerAttempt<
      InferRequestErrors<typeof approvalRequest>,
      "NeedsHumanReview"
    >,
    {
      readonly attempt: number;
      readonly manual: boolean;
      readonly code: "NeedsHumanReview";
      readonly message: string;
      readonly details: undefined;
    }
  >
>;

type _UnhandledAttempt = Assert<
  IsEqual<
    UnhandledRequestHandlerAttempt,
    {
      readonly attempt: number;
      readonly manual: boolean;
      readonly code: null;
      readonly message: string | null;
      readonly type: string | null;
      readonly details: { readonly status: "unspecified" };
    }
  >
>;

const _constructedTrueError = new RequestHandlerDeclaredError(
  "NeedsHumanReview",
  "constructed for regression",
  undefined,
  true,
);
void _constructedTrueError;

const unregister = client.requests.approvalRequestAcceptance.registerHandler(
  async (payload, ctx) => {
    type _Payload = Assert<
      IsEqual<typeof payload, { documentId: string; tenantId: string }>
    >;
    type _Ctx = Assert<
      typeof ctx extends RequestHandlerContext<
        InferRequestErrors<typeof approvalRequest>
      >
        ? true
        : false
    >;

    if (payload.documentId === "manual") {
      throw ctx.errors.NeedsHumanReview("Needs senior reviewer", { manual: true });
    }

    throw ctx.errors.RulesEngineRejected(
      "Rule rejected document",
      { ruleId: "R-1" },
      { manual: false },
    );
  },
  {
    retryPolicy: { maxAttempts: 3, timeoutSeconds: 30 },
    compensation: {
      handler: async (payload, info, ctx) => {
        type _Payload = Assert<
          IsEqual<typeof payload, { documentId: string; tenantId: string }>
        >;
        type _Info = Assert<
          typeof info extends RequestCompensationInfo<{
            approved: boolean;
            reviewerId: string;
          }>
            ? true
            : false
        >;
        type _Ctx = Assert<
          typeof ctx extends RequestCompensationHandlerContext<
            InferRequestCompensationErrors<typeof approvalRequest>
          >
            ? true
            : false
        >;

        if (info.status !== "completed") {
          throw ctx.errors.ReleaseBlocked("Nothing to release");
        }

        // @ts-expect-error compensation ctx.errors do not take { manual }
        ctx.errors.ReleaseBlocked("bad", { manual: true });

        return { cancelled: info.response.approved };
      },
      retryPolicy: { timeoutSeconds: 30 },
    },
  },
);

client.requests.approvalRequestAcceptance.registerHandler(
  async (_payload, ctx) => {
    const manualErr = ctx.errors.NeedsHumanReview("Needs senior reviewer", {
      manual: true,
    });
    type _ManualErr = Assert<
      IsEqual<
        typeof manualErr,
        RequestHandlerDeclaredError<"NeedsHumanReview", undefined>
      >
    >;
    void manualErr.manual;
    void manualErr.code;

    // @ts-expect-error manual is required
    ctx.errors.NeedsHumanReview("missing disposition");

    // @ts-expect-error unknown error code
    ctx.errors.UnknownCode("nope", { manual: true });

    return { approved: true, reviewerId: "reviewer-1" };
  },
  { retryPolicy: { maxAttempts: 1 } },
);

const noErrorsRequest = defineRequest({
  name: "noErrorsRequestAcceptance",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const noErrorsWorkflow = defineWorkflow({
  name: "noErrorsRequestWorkflow",
  requests: { ping: noErrorsRequest },
  result: z.void(),
  async execute() {},
});

const noErrorsClient = createWorkflowClient({
  noErrorsRequestWorkflow: noErrorsWorkflow,
});

noErrorsClient.requests.noErrorsRequestAcceptance.registerHandler(
  async (_payload, ctx) => {
    type _NoErrorsCtx = Assert<
      typeof ctx extends RequestHandlerContext<Record<string, never>> ? true : false
    >;
    type _AssertNoErrorsCtx = Assert<_NoErrorsCtx>;
    return { ok: true };
  },
  { retryPolicy: { maxAttempts: 1 } },
);

type _RequestHandlerAttemptUnion = Assert<
  IsEqual<
    RequestHandlerAttempt<InferRequestErrors<typeof approvalRequest>>,
    | DeclaredRequestHandlerAttempt<
        InferRequestErrors<typeof approvalRequest>,
        "NeedsHumanReview"
      >
    | DeclaredRequestHandlerAttempt<
        InferRequestErrors<typeof approvalRequest>,
        "RulesEngineRejected"
      >
    | UnhandledRequestHandlerAttempt
  >
>;

// =============================================================================
// `retentionPolicy` — ROW RETENTION AT FINALIZE
// =============================================================================

type _ApprovalPayload = { documentId: string; tenantId: string };
type _ApprovalResponse = { approved: boolean; reviewerId: string };
type _ApprovalErrors = InferRequestErrors<typeof approvalRequest>;

type _RetentionContext = Assert<
  IsEqual<
    RequestRetentionContext<_ApprovalErrors, _ApprovalPayload, _ApprovalResponse>,
    | {
        readonly status: "resolved";
        readonly payload: _ApprovalPayload;
        readonly response: _ApprovalResponse;
        readonly attempts: RequestHandlerAttemptAccessor<_ApprovalErrors>;
      }
    | {
        readonly status: "timedOut";
        readonly payload: _ApprovalPayload;
        readonly attempts: RequestHandlerAttemptAccessor<_ApprovalErrors>;
      }
  >
>;

const retentionPolicy: RequestRetentionPolicy<
  _ApprovalErrors,
  _ApprovalPayload,
  _ApprovalResponse
> = async (ctx) => {
  type _Ctx = Assert<
    IsEqual<
      typeof ctx,
      RequestRetentionContext<_ApprovalErrors, _ApprovalPayload, _ApprovalResponse>
    >
  >;
  type _TerminalStatus = Assert<IsEqual<RequestTerminalStatus, typeof ctx.status>>;

  if (ctx.status === "resolved") {
    type _Response = IsEqual<typeof ctx.response, _ApprovalResponse>;
    void 0 as unknown as _Response;
    return 86400;
  }
  const count = await ctx.attempts.count();
  return count > 3 ? 86400 * 7 : 86400;
};

type _RetentionPolicyReturn = Assert<
  Awaited<ReturnType<typeof retentionPolicy>> extends number | null ? true : false
>;

const _registrationWithRetention: RequestHandlerRegistrationOptions<
  _ApprovalErrors,
  _ApprovalPayload,
  _ApprovalResponse
> = {
  retryPolicy: { maxAttempts: 3 },
  retentionPolicy,
};
void _registrationWithRetention;

client.requests.approvalRequestAcceptance.registerHandler(
  async () => ({ approved: true, reviewerId: "retention-test" }),
  {
    retryPolicy: { maxAttempts: 1 },
    retentionPolicy: async (ctx) => {
      type _CtxShape = Assert<
        typeof ctx extends RequestRetentionContext<
          _ApprovalErrors,
          _ApprovalPayload,
          _ApprovalResponse
        >
          ? true
          : false
      >;
      if (ctx.status === "resolved") {
        void ctx.response.approved;
      }
      await ctx.attempts.all();
      return null;
    },
  },
);

client.requests.approvalRequestAcceptance.registerHandler(
  async () => ({ approved: true, reviewerId: "retention-test" }),
  {
    retryPolicy: { maxAttempts: 1 },
    // @ts-expect-error retentionPolicy must return number | null
    retentionPolicy: async () => "forever",
  },
);

client.requests.pingRequestAcceptance.registerHandler(
  async () => ({ ok: true }),
  {
    retryPolicy: { maxAttempts: 1 },
    // @ts-expect-error non-compensable requests cannot register compensation handlers
    compensation: {
      handler: async () => ({ cancelled: false }),
      retryPolicy: { timeoutSeconds: 30 },
    },
  },
);

type _RegistrationOptionsShape = Assert<
  RequestHandlerRegistrationOptions<
    InferRequestErrors<typeof approvalRequest>,
    { documentId: string; tenantId: string },
    { approved: boolean; reviewerId: string },
    InferRequestCompensationDef<typeof approvalRequest>,
    InferRequestCompensationErrors<typeof approvalRequest>
  > extends {
    retryPolicy?: unknown;
    maxConcurrent?: unknown;
    retentionPolicy?: unknown;
    compensation?: unknown;
  }
    ? true
    : false
>;
void (0 as unknown as _RegistrationOptionsShape);

// =============================================================================
// `escalateToManual` — EXTERNAL MANUAL ESCALATION
// =============================================================================

const _untypedEscalation: RequestManualEscalationInput<_ApprovalErrors> = {
  message: "Ops took over",
  type: "OperatorAction",
};

const _typedMarkerEscalation: RequestManualEscalationInput<_ApprovalErrors> = {
  code: "NeedsHumanReview",
  message: "Escalated from admin console",
};

const _typedSchemaEscalation: RequestManualEscalationInput<_ApprovalErrors> = {
  code: "RulesEngineRejected",
  message: "Rules engine unavailable",
  details: { ruleId: "R-42" },
};

void _untypedEscalation;
void _typedMarkerEscalation;
void _typedSchemaEscalation;

const _badEscalationDetails: RequestManualEscalationInput<_ApprovalErrors> = {
  code: "RulesEngineRejected",
  message: "bad",
  details: {
    // @ts-expect-error persisted details union is not valid escalation input
    ok: true,
    status: "serialized",
    result: { ruleId: "R-42" },
  },
};

type _RejectMissingEscalationDetails = Assert<
  {
    code: "RulesEngineRejected";
    message: string;
  } extends RequestManualEscalationInput<_ApprovalErrors>
    ? false
    : true
>;
void (0 as unknown as _RejectMissingEscalationDetails);

const _noErrorsEscalation: RequestManualEscalationInput<
  InferRequestErrors<typeof noErrorsRequest>
> = {
  message: "External escalation",
};

void _noErrorsEscalation;

const _explicitNullCode: RequestManualEscalationInput<_ApprovalErrors> = {
  // @ts-expect-error untyped escalation omits code — do not pass code: null
  code: null,
  message: "bad",
  type: null,
};

type _RejectDeclaredCodeWithoutErrors = Assert<
  RequestManualEscalationInput<
    InferRequestErrors<typeof noErrorsRequest>
  > extends {
    code: "NeedsHumanReview";
    message: string;
  }
    ? false
    : true
>;
void (0 as unknown as _RejectDeclaredCodeWithoutErrors);

type _AttemptAccessorShape = Assert<
  RequestHandlerAttemptAccessor<InferRequestErrors<typeof approvalRequest>> extends {
    last(): Promise<RequestHandlerAttempt<InferRequestErrors<typeof approvalRequest>>>;
    all(): Promise<RequestHandlerAttempt<InferRequestErrors<typeof approvalRequest>>[]>;
    count(): Promise<number>;
  }
    ? true
    : false
>;
void (0 as unknown as _AttemptAccessorShape);

async function manualResolution(): Promise<void> {
  const requestMany = client.requests.approvalRequestAcceptance.findMany(
    ({ status, payload }) =>
      and(eq(status, "manual"), eq(payload.documentId, "doc-1")),
    {
      fields: { id: true, payload: true },
      sort: [{ path: "priority", direction: "desc" }],
      limit: 1,
    },
  );

  type _RequestMany = Assert<
    IsEqual<
      typeof requestMany,
      FindManyResult<
        HandleWithRow<
          RequestHandleExternal<
            "approvalRequestAcceptance",
            { documentId: string; tenantId: string },
            { approved: boolean; reviewerId: string },
            { approved: boolean; reviewerId: string },
            InferRequestErrors<typeof approvalRequest>
          >,
          Pick<
            RequestRow<
              "approvalRequestAcceptance",
              { documentId: string; tenantId: string },
              { approved: boolean; reviewerId: string }
            >,
            "id" | "payload"
          >
        >
      >
    >
  >;

  const requests = await requestMany;
  const request = requests[0];
  if (!request) {
    return;
  }

  await request.resolve({
    approved: true,
    reviewerId: "manual-reviewer",
  });
  await request.escalateToManual({
    code: "NeedsHumanReview",
    message: "Escalated while reviewing queue",
  });

  const requestId = "request-id" as RequestId<"approvalRequestAcceptance">;
  const requestHandle = client.requests.approvalRequestAcceptance.get(requestId);

  await requestHandle.escalateToManual({
    message: "Stop automation",
    type: "AdminConsole",
  });

  const fetched = await requestHandle.fetchRow({ payload: true, status: true });
  void fetched;

  const count = await client.requests.approvalRequestAcceptance.count((scope) =>
    eq(scope.status, "manual"),
  );
  void count;

  const found = await client.requests.approvalRequestAcceptance.findUnique(
    ({ payload }) => eq(payload.documentId, "doc-1"),
  );
  void found;

  // @ts-expect-error request ids are branded by request definition name
  client.requests.approvalRequestAcceptance.get("plain-id");
  // @ts-expect-error resolve payload must match the request response schema
  await requestHandle.resolve({ approved: true });
  client.requests.approvalRequestAcceptance.findMany(
    // @ts-expect-error predicates are typed to the request payload shape
    ({ payload }) => eq(payload.unknownField, "x"),
  );
}

type _AttemptAccessor = Assert<_AttemptAccessorShape>;

type _Unregister = Assert<IsEqual<typeof unregister, Unsubscribe>>;
type _RequestHandlerDeclaredError = Assert<
  RequestHandlerDeclaredError extends Error ? true : false
>;

void noErrorsClient;
void unregister;
void manualResolution;
