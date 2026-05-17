import { z } from "zod";
import { createWorkflowClient } from "../client";
import { and, eq } from "../search";
import {
  defineRequest,
  defineWorkflow,
  MANUAL,
  registerRequestCompensationHandler,
} from "../workflow";
import type {
  FindManyResult,
  FindUniqueResult,
  HandleWithRow,
  RequestCompensationInfo,
  RequestHandleExternal,
  RequestNamespaceExternal,
  RequestRow,
  Unsubscribe,
} from "../types";
import type { RequestId } from "../types/schema";
import type { Assert, IsEqual } from "./type-assertions";

const approvalRequest = defineRequest({
  name: "approvalRequestAcceptance",
  payload: z.object({ documentId: z.string(), tenantId: z.string() }),
  response: z.object({ approved: z.boolean(), reviewerId: z.string() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
  },
});

const pingRequest = defineRequest({
  name: "pingRequestAcceptance",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

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
      { approved: boolean; reviewerId: string }
    >
  >
>;

// The namespace is keyed by the request definition name, not by the workflow's
// local `requests` slot name.
// @ts-expect-error workflow-local request aliases do not become client namespaces
void client.requests.approval;

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
            { approved: boolean; reviewerId: string }
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
  type _PrefetchedPayload = Assert<
    IsEqual<typeof request.row.payload, { documentId: string; tenantId: string }>
  >;

  await request.resolve({
    approved: true,
    reviewerId: "manual-reviewer",
  });
  await request.cancel();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- regression-only cast to branded `RequestId`
  const requestId = "request-id" as RequestId<"approvalRequestAcceptance">;
  const requestHandle = client.requests.approvalRequestAcceptance.get(requestId);
  type _RequestHandle = Assert<
    IsEqual<
      typeof requestHandle,
      RequestHandleExternal<
        "approvalRequestAcceptance",
        { documentId: string; tenantId: string },
        { approved: boolean; reviewerId: string },
        { approved: boolean; reviewerId: string }
      >
    >
  >;

  const fetched = await requestHandle.fetchRow({ payload: true, status: true });
  type _Fetched = Assert<
    IsEqual<
      typeof fetched,
      FindUniqueResult<
        Pick<
          RequestRow<
            "approvalRequestAcceptance",
            { documentId: string; tenantId: string },
            { approved: boolean; reviewerId: string }
          >,
          "payload" | "status"
        >
      >
    >
  >;
  void fetched;

  const count = await client.requests.approvalRequestAcceptance.count((scope) =>
    eq(scope.status, "manual"),
  );
  type _Count = Assert<IsEqual<typeof count, number>>;
  void count;

  const found = await client.requests.approvalRequestAcceptance.findUnique(
    ({ payload }) => eq(payload.documentId, "doc-1"),
  );
  type _Found = Assert<
    IsEqual<
      typeof found,
      FindUniqueResult<
        RequestHandleExternal<
          "approvalRequestAcceptance",
          { documentId: string; tenantId: string },
          { approved: boolean; reviewerId: string },
          { approved: boolean; reviewerId: string }
        >
      >
    >
  >;
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

const unregister = approvalRequest.registerHandler(async (payload, { signal }) => {
  type _Payload = Assert<
    IsEqual<typeof payload, { documentId: string; tenantId: string }>
  >;
  if (signal.aborted) {
    return { approved: false, reviewerId: "aborted" };
  }
  return { approved: true, reviewerId: "reviewer-1" };
});

const unregisterApprovalCompensation = registerRequestCompensationHandler(
  approvalRequest,
  async (payload, info, _opts) => {
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
    if (info.status === "completed") {
      return { cancelled: info.response.approved };
    }
    return MANUAL;
  },
  { retryPolicy: { timeoutSeconds: 30 } },
);

registerRequestCompensationHandler(
  // @ts-expect-error non-compensable requests cannot have compensation handlers
  pingRequest,
  async () => undefined,
  { retryPolicy: { timeoutSeconds: 30 } },
);

type _Unregister = Assert<IsEqual<typeof unregister, Unsubscribe>>;
type _UnregisterComp = Assert<
  IsEqual<typeof unregisterApprovalCompensation, Unsubscribe>
>;

void unregister;
void unregisterApprovalCompensation;
void manualResolution;
