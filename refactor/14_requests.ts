import { z } from "zod";
import {
  defineRequest,
  defineWorkflow,
  MANUAL,
  UnrecoverableError,
} from "../workflow";
import { createWorkflowClient } from "../client";
import type {
  RequestAccessorResult,
  RequestCompensationInfo,
  Unsubscribe,
} from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const approvalRequest = defineRequest({
  name: "approvalRequestAcceptance",
  payload: z.object({ documentId: z.string(), tenantId: z.string() }),
  response: z.object({ approved: z.boolean(), reviewerId: z.string() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
    async undo(_ctx, payload, info) {
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
      return { cancelled: info.status !== "completed" };
    },
  },
});

export const requestsAcceptanceWorkflow = defineWorkflow({
  name: "requestsAcceptance",
  requests: { approval: approvalRequest },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    const direct = await ctx.requests.approval({
      documentId: "doc-1",
      tenantId: "tenant-1",
    });
    type _DirectNoAny = Assert<IsAny<typeof direct> extends false ? true : false>;
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

    // @ts-expect-error request payload is schema-checked
    await ctx.requests.approval({ documentId: "doc-3" });
    // @ts-expect-error priority belongs in options
    ctx.requests.approval({ documentId: "doc-4", tenantId: "tenant-1" }).priority(1);

    return { ok: direct.approved };
  },
});

const client = createWorkflowClient({ requestsAcceptance: requestsAcceptanceWorkflow });

const unregister = client.registerRequestHandler(
  approvalRequest,
  async ({ signal }, payload) => {
    type _Payload = Assert<
      IsEqual<typeof payload, { documentId: string; tenantId: string }>
    >;
    if (signal.aborted) {
      return MANUAL;
    }
    if (payload.documentId === "wait") {
      return MANUAL;
    }
    return { approved: true, reviewerId: "reviewer-1" };
  },
  {
    retryPolicy: {
      timeoutSeconds: 30,
      maxAttempts: 3,
      intervalSeconds: 5,
    },
    onExhausted: async (_ctx, request) => {
      type _RequestResult = Assert<
        typeof request extends RequestAccessorResult<
          { documentId: string; tenantId: string },
          { approved: boolean; reviewerId: string }
        >
          ? true
          : false
      >;
      return MANUAL;
    },
  },
);

client.registerRequestHandler(approvalRequest, async () => {
  // @ts-expect-error requests use MANUAL, not UnrecoverableError, for early termination
  throw new UnrecoverableError("not a request pattern");
});

async function manualResolution(): Promise<void> {
  const page = await client.requests.approval.search({
    where: { kind: "eq", namespace: "request", path: "status", value: "manual" },
  });
  const request = page.items[0];
  await client.requests.approval.resolve(request.id, {
    approved: true,
    reviewerId: "manual-reviewer",
  });
  await client.requests.approval.cancel(request.id);
}

type _Unregister = Assert<IsEqual<typeof unregister, Unsubscribe>>;

void manualResolution;
