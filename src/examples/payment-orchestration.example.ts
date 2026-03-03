import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { paymentWorkflow, campaignWorker } from "./shared";

const PaymentOrchestrationArgs = z.object({
  customerId: z.string(),
  amount: z.number(),
  existingCampaignIdempotencyKey: z.string(),
});

/**
 * Showcases:
 * - child workflow builders (.compensate/.failure/.complete)
 * - detached child start via call option
 * - foreign workflow get/send
 * - afterCompensate hook
 */
export const paymentOrchestrationWorkflow = defineWorkflow({
  name: "paymentOrchestration",
  args: PaymentOrchestrationArgs,
  childWorkflows: { payment: paymentWorkflow, campaignWorker },
  foreignWorkflows: { campaignWorker },
  result: z.object({
    receiptId: z.string().nullable(),
    campaignStarted: z.boolean(),
  }),
  rng: { ids: true },
  afterCompensate: async ({ ctx: compCtx }) => {
    compCtx.logger.info("Payment orchestration compensating", {
      id: compCtx.workflowId,
    });
  },

  async execute(ctx, args) {
    const receiptId = await ctx.childWorkflows
      .payment({
        idempotencyKey: `payment-${ctx.rng.ids.uuidv4()}`,
        metadata: {
          tenantId: `tenant-${args.customerId}`,
          correlationId: `corr-payment-${args.customerId}`,
        },
        seed: `payment-seed-${args.customerId}`,
        args: { customerId: args.customerId, amount: args.amount },
      })
      .compensate(async (compCtx, _result) => {
        compCtx.logger.info("Triggering payment child compensation");
      })
      .failure(async (failure) => {
        if (failure.status === "failed") {
          ctx.logger.error("Payment workflow failed", {
            error: failure.error.message,
          });
        } else {
          ctx.logger.error("Payment workflow terminated", {
            reason: failure.reason,
          });
        }
        return null;
      })
      .complete((data) => data.receiptId);

    const campaignHandle = await ctx.childWorkflows.campaignWorker({
      idempotencyKey: `campaign-${ctx.rng.ids.uuidv4()}`,
      metadata: {
        tenantId: `tenant-${args.customerId}`,
        correlationId: `corr-campaign-${args.customerId}`,
      },
      seed: `campaign-seed-${args.customerId}`,
      args: { userId: args.customerId },
      detached: true,
    });

    const foreign = ctx.foreignWorkflows.campaignWorker.get(
      args.existingCampaignIdempotencyKey,
    );
    await foreign.channels.nudge.send({ type: "nudge" });
    await campaignHandle.channels.nudge.send({ type: "nudge" });

    return { receiptId, campaignStarted: true };
  },
});
