import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { paymentWorkflow, campaignWorker } from "./shared";

const PaymentOrchestrationArgs = z.object({
  customerId: z.string(),
  amount: z.number(),
  existingCampaignId: z.string(),
});

/**
 * Showcases:
 * - child workflow builders (.compensate/.failure/.complete)
 * - detached child start via call option
 * - foreign workflow get/send
 * - addCompensation
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

  async execute(ctx, args) {
    ctx.addCompensation(async (compCtx) => {
      compCtx.logger.info("Payment orchestration compensating", {
        workflowId: compCtx.workflowId,
      });
    });

    const receiptId = await ctx.childWorkflows
      .payment({
        workflowId: `payment-${ctx.rng.ids.uuidv4()}`,
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
          ctx.logger.error("Payment workflow terminated");
        }
        await failure.compensate();
        return null;
      })
      .complete((data) => data.receiptId);

    const campaignHandle = await ctx.childWorkflows.campaignWorker({
      workflowId: `campaign-${ctx.rng.ids.uuidv4()}`,
      args: { userId: args.customerId },
      detached: true,
    });

    const foreign = ctx.foreignWorkflows.campaignWorker.get(
      args.existingCampaignId,
    );
    await foreign.channels.nudge.send({ type: "nudge" });
    await campaignHandle.channels.nudge.send({ type: "nudge" });

    return { receiptId, campaignStarted: true };
  },
});
