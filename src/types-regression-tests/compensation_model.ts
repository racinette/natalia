import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  MANUAL,
  registerRequestCompensationHandler,
} from "../workflow";
import type {
  CompensationBlockHandle,
  CompensationBlockStatus,
  CompensationInfo,
  FindUniqueResult,
  RequestCompensationInfo,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const refundStep = defineStep({
  name: "refundStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ refundId: z.string() }),
  async execute(_ctx, args) {
    return { refundId: `refund:${args.chargeId}` };
  },
});

const auditStep = defineStep({
  name: "auditStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ recorded: z.boolean() }),
  async execute(_ctx, _args) {
    return { recorded: true };
  },
});

const chargeStep = defineStep({
  name: "chargeStep",
  args: z.object({ customerId: z.string(), amount: z.number() }),
  result: z.object({ chargeId: z.string(), amount: z.number() }),
  compensation: {
    steps: { refundStep },
    result: z.object({
      status: z.enum(["refunded", "manual_review"]),
      refundId: z.string().optional(),
    }),
    async undo(ctx, args, info) {
      type _Args = Assert<
        IsEqual<typeof args, { customerId: string; amount: number }>
      >;
      type _Info = Assert<
        typeof info extends CompensationInfo<{
          chargeId: string;
          amount: number;
        }>
          ? true
          : false
      >;

      if (info.status === "completed") {
        const refund = await ctx.steps.refundStep({
          chargeId: info.result.chargeId,
        });
        return { status: "refunded" as const, refundId: refund.refundId };
      }

      if (info.status === "timed_out") {
        type _Reason = Assert<
          IsEqual<typeof info.reason, "attempts_exhausted" | "deadline">
        >;
        // @ts-expect-error timed-out forward outcomes do not expose a result
        info.result;
      }

      if (info.status === "terminated") {
        await info.attempts.count();
        // @ts-expect-error terminated forward outcomes do not expose a result
        info.result;
      }

      // @ts-expect-error compensation blocks only see declared dependencies
      ctx.steps.auditStep({ chargeId: "charge:missing" });
      // @ts-expect-error compensation undo has no workflow error factories
      ctx.errors.CompensationFailed("not available");

      const last = await info.attempts.last();
      if (last.type === "GatewayTimeout") {
        return { status: "manual_review" as const };
      }

      return { status: "manual_review" as const };
    },
  },
  async execute(_ctx, args) {
    return { chargeId: `charge:${args.customerId}`, amount: args.amount };
  },
});

const trackingStep = defineStep({
  name: "trackingStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ trackingId: z.string() }),
  compensation: {
    async undo(_ctx, _args, _info) {},
  },
  async execute(_ctx, args) {
    return { trackingId: `track:${args.chargeId}` };
  },
});

// @ts-expect-error compensation dependencies cannot themselves be compensable
defineStep({
  name: "recursiveCompensableStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    steps: { trackingStep },
    async undo() {},
  },
  async execute() {
    return { ok: true };
  },
});

const approvalRequest = defineRequest({
  name: "approvalRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ approved: z.boolean() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
  },
});

const unregisterApprovalCompensation = registerRequestCompensationHandler(
  approvalRequest,
  async (_ctx, payload, info) => {
    type _Payload = Assert<IsEqual<typeof payload, { chargeId: string }>>;
    type _Info = Assert<
      typeof info extends RequestCompensationInfo<{ approved: boolean }>
        ? true
        : false
    >;
    return { cancelled: info.status !== "completed" };
  },
  { retryPolicy: { timeoutSeconds: 30 } },
);

const manualReviewRequest = defineRequest({
  name: "manualReviewRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ accepted: z.boolean() }),
  compensation: true,
});

const unregisterManualReviewCompensation = registerRequestCompensationHandler(
  manualReviewRequest,
  async (_ctx, payload, info) => {
    type _Payload = Assert<IsEqual<typeof payload, { chargeId: string }>>;

    if (info.status === "completed") {
      type _Response = Assert<
        IsEqual<typeof info.response, { accepted: boolean }>
      >;
      return;
    }

    if (info.status === "timed_out") {
      type _Reason = Assert<
        IsEqual<typeof info.reason, "attempts_exhausted" | "deadline">
      >;
      // @ts-expect-error timed-out request outcomes do not expose a response
      info.response;
    }

    return MANUAL;
  },
  {
    retryPolicy: { timeoutSeconds: 30, totalTimeoutSeconds: 120 },
    onExhausted: {
      async callback(_ctx, payload, info) {
        type _Payload = Assert<IsEqual<typeof payload, { chargeId: string }>>;
        type _Info = Assert<
          typeof info extends RequestCompensationInfo<{ accepted: boolean }>
            ? true
            : false
        >;
        return MANUAL;
      },
      retryPolicy: { intervalMs: 1_000 },
    },
  },
);

const nonCompensableRequest = defineRequest({
  name: "nonCompensableRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

registerRequestCompensationHandler(
  // @ts-expect-error request compensation handlers require compensable requests
  nonCompensableRequest,
  async () => undefined,
  { retryPolicy: { timeoutSeconds: 30 } },
);

// @ts-expect-error request compensation handlers register separately
defineRequest({
  name: "inlineRequestCompensation",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.object({ undone: z.boolean() }),
    async undo() {
      return { undone: true };
    },
  },
});

// @ts-expect-error compensation dependencies cannot include compensable requests
defineStep({
  name: "requestRecursiveCompensableStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    requests: { approvalRequest },
    async undo() {},
  },
  async execute() {
    return { ok: true };
  },
});

const noResultCompensatedStep = defineStep({
  name: "noResultCompensatedStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    async undo(_ctx, _args, _info) {},
  },
  async execute() {
    return { ok: true };
  },
});

const childWorkflow = defineWorkflow({
  name: "compensationModelChild",
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

export const compensationModelAcceptanceWorkflow = defineWorkflow({
  name: "compensationModelAcceptance",
  steps: { chargeStep, auditStep },
  requests: { approvalRequest },
  childWorkflows: { childWorkflow },
  result: z.object({ ok: z.boolean() }),
  // @ts-expect-error workflow-level compensation hooks are removed
  async beforeCompensate() {},
  async execute(ctx) {
    const charge = await ctx.steps.chargeStep({
      customerId: "cust-1",
      amount: 10,
    });

    await ctx.requests.approvalRequest({ chargeId: charge.chargeId });

    const entry = ctx.steps.chargeStep({ customerId: "cust-2", amount: 20 });
    // @ts-expect-error compensation is definition-bound, not call-site-bound
    entry.compensate(async () => undefined);
    // @ts-expect-error general ad hoc compensation registration is removed
    ctx.addCompensation(async () => undefined);

    const child = ctx.childWorkflows.childWorkflow({});
    // @ts-expect-error child compensation is no longer call-site-bound
    child.compensate(async () => undefined);

    return { ok: true };
  },
});

declare const handle: CompensationBlockHandle<typeof chargeStep>;
declare const noResultHandle: CompensationBlockHandle<typeof noResultCompensatedStep>;

async function inspectCompensationBlock(): Promise<void> {
  const block = handle.findUnique("block-1");
  // @ts-expect-error findUnique is grounded by instance id, not stale selector objects
  handle.findUnique({ id: "block-1" });

  const status = await block.status();
  type _Status = Assert<
    IsEqual<typeof status, FindUniqueResult<CompensationBlockStatus>>
  >;

  const result = await block.result();
  type _Result = Assert<
    IsEqual<
      typeof result,
      FindUniqueResult<
        | { status: "refunded"; refundId?: string }
        | { status: "manual_review"; refundId?: string }
        | null
      >
    >
  >;

  const noResult = await noResultHandle.findUnique("block-2").result();
  type _NoResult = Assert<IsEqual<typeof noResult, FindUniqueResult<null>>>;
}

void unregisterApprovalCompensation;
void unregisterManualReviewCompensation;
void inspectCompensationBlock;
