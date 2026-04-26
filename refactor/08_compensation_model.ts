import { z } from "zod";
import { defineRequest, defineStep, defineWorkflow } from "../workflow";
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
        const refund = await ctx.steps.refundStep({ chargeId: info.result.chargeId });
        return { status: "refunded" as const, refundId: refund.refundId };
      }

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

const approvalRequest = defineRequest({
  name: "approvalRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ approved: z.boolean() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
    async undo(_ctx, payload, info) {
      type _Payload = Assert<IsEqual<typeof payload, { chargeId: string }>>;
      type _Info = Assert<
        typeof info extends RequestCompensationInfo<{ approved: boolean }>
          ? true
          : false
      >;
      return { cancelled: info.status !== "completed" };
    },
  },
});

export const compensationModelAcceptanceWorkflow = defineWorkflow({
  name: "compensationModelAcceptance",
  steps: { chargeStep },
  requests: { approvalRequest },
  result: z.object({ ok: z.boolean() }),
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

    return { ok: true };
  },
});

declare const handle: CompensationBlockHandle<typeof chargeStep>;

async function inspectCompensationBlock(): Promise<void> {
  const found = await handle.findUnique({ id: "block-1" });
  type _FindUnique = Assert<
    IsEqual<
      typeof found,
      FindUniqueResult<{
        readonly status: CompensationBlockStatus;
        readonly result:
          | { status: "refunded"; refundId?: string }
          | { status: "manual_review"; refundId?: string }
          | undefined;
      }>
    >
  >;
}

void inspectCompensationBlock;
