import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail } from "./shared";

const CompensationHooksArgs = z.object({
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  customerId: z.string(),
  notificationEmail: z.string(),
});

const CompensationCommand = z.object({ type: z.literal("ack") });

/**
 * Showcases:
 * - beforeCompensate / afterCompensate
 * - compensation context scope/forEach/select/sleep/channels/streams/events
 * - CompensationStepCall.retry()
 */
export const compensationHooksWorkflow = defineWorkflow({
  name: "compensationHooks",
  args: CompensationHooksArgs,
  channels: { compAck: CompensationCommand },
  streams: { compLog: z.object({ msg: z.string(), ts: z.number() }) },
  events: { compensationStarted: true, compensationComplete: true },
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },

  beforeCompensate: async ({ ctx, args }) => {
    ctx.logger.info("Compensation starting", { workflowId: ctx.workflowId });
    await ctx.streams.compLog.write({
      msg: `Compensation started for ${args.destination}`,
      ts: ctx.timestamp,
    });
    await ctx.events.compensationStarted.set();

    const ack = await ctx.channels.compAck.receive();
    ctx.logger.info("Compensation ack received", { type: ack.type });
    await ctx.sleep(1);
  },

  afterCompensate: async ({ ctx, args }) => {
    ctx.logger.info("All compensations done");

    await ctx.scope(
      {
        logEntry: async () => {
          const result = await ctx.steps.sendEmail(
            args.notificationEmail,
            "Order Compensated",
            `Your order to ${args.destination} was cancelled and refunded.`,
          );
          return result;
        },
        auditEntry: async () => {
          const result = await ctx.steps
            .sendEmail(
              "audit@example.com",
              "Compensation Complete",
              `Workflow ${ctx.workflowId} fully compensated.`,
            )
            .retry({ maxAttempts: 5 });
          return result;
        },
      },
      async ({ logEntry, auditEntry }) => {
        await ctx.forEach(
          { logEntry, auditEntry },
          {
            logEntry: (data) => {
              if (!data.ok) ctx.logger.warn("Customer notification failed to send");
            },
            auditEntry: (data) => {
              if (!data.ok) ctx.logger.warn("Audit notification failed to send");
            },
          },
        );
      },
    );

    await ctx.streams.compLog.write({
      msg: "Compensation finalized",
      ts: ctx.timestamp,
    });
    await ctx.events.compensationComplete.set();
  },

  async execute(ctx, args) {
    await ctx.steps
      .bookFlight(args.destination, args.customerId)
      .compensate(async (compCtx) => {
        const result = await compCtx.steps
          .cancelFlight(args.destination, args.customerId)
          .retry({ maxAttempts: 15, intervalSeconds: 10, backoffRate: 2 });

        if (!result.ok) {
          compCtx.logger.error("Flight cancellation failed after retries", {
            reason: result.reason,
          });
        }
      });

    await ctx.steps
      .bookHotel(args.destination, args.checkIn, args.checkOut)
      .compensate(async (compCtx) => {
        await compCtx.scope(
          {
            cancel: compCtx.steps
              .cancelHotel(args.destination, args.checkIn, args.checkOut)
              .retry({ maxAttempts: 10 }),
            notify: compCtx.steps.sendEmail(
              args.notificationEmail,
              "Hotel Cancelled",
              `Hotel booking for ${args.destination} was cancelled.`,
            ),
          },
          async ({ cancel, notify }) => {
            const sel = compCtx.select({ cancel, notify });
            for await (const _data of sel) {
              compCtx.logger.debug("Compensation branch resolved");
            }
          },
        );

        await compCtx.streams.compLog.write({
          msg: `Hotel compensation complete for ${args.destination}`,
          ts: compCtx.timestamp,
        });
      });

    throw new Error("Intentional failure to trigger compensation demo");
  },
});
