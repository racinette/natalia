import { z } from "zod";
import { createWorkflowClient } from "../client";
import { and, eq } from "../search";
import {
  defineRequest,
  defineWorkflow,
  registerRequestCompensationHandler,
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
  RequestOnExhaustedHandlerContext,
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
      InferRequestErrors<typeof approvalRequest>
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
  { retryPolicy: { maxAttempts: 3, timeoutSeconds: 30 } },
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
// COMPENSATION `ctx.errors`
// =============================================================================

const unregisterApprovalCompensation = registerRequestCompensationHandler(
  approvalRequest,
  async (payload, info, ctx) => {
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
  { retryPolicy: { timeoutSeconds: 30 } },
);

client.requests.approvalRequestAcceptance.registerHandler(
  async () => ({ approved: true, reviewerId: "fallback" }),
  {
    retryPolicy: { maxAttempts: 1 },
    onExhausted: {
      callback: async (_payload, ctx) => {
        type _ExhaustCtx = Assert<
          typeof ctx extends RequestOnExhaustedHandlerContext<
            InferRequestErrors<typeof approvalRequest>
          >
            ? true
            : false
        >;
        throw ctx.errors.NeedsHumanReview("Retries exhausted — waiting for human");
        // @ts-expect-error onExhausted ctx.errors do not take { manual }
        ctx.errors.NeedsHumanReview("bad", { manual: true });
      },
    },
  },
);

registerRequestCompensationHandler(
  // @ts-expect-error non-compensable requests cannot have compensation handlers
  pingRequest,
  async () => undefined,
  { retryPolicy: { timeoutSeconds: 30 } },
);

type _RegistrationOptionsShape = Assert<
  RequestHandlerRegistrationOptions<
    InferRequestErrors<typeof approvalRequest>,
    { documentId: string; tenantId: string },
    { approved: boolean; reviewerId: string }
  > extends {
    retryPolicy?: unknown;
    maxConcurrent?: number;
    onExhausted?: unknown;
  }
    ? true
    : false
>;
void (0 as unknown as _RegistrationOptionsShape);

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
  await request.cancel();

  const requestId = "request-id" as RequestId<"approvalRequestAcceptance">;
  const requestHandle = client.requests.approvalRequestAcceptance.get(requestId);

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
type _UnregisterComp = Assert<
  IsEqual<typeof unregisterApprovalCompensation, Unsubscribe>
>;
type _RequestHandlerDeclaredError = Assert<
  RequestHandlerDeclaredError extends Error ? true : false
>;

void noErrorsClient;
void unregister;
void unregisterApprovalCompensation;
void manualResolution;
