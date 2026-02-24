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
const OperatorResolution = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry_cancel"),
    note: z.string(),
  }),
  z.object({
    action: z.literal("confirm_resolved"),
    note: z.string(),
  }),
  z.object({
    action: z.literal("abort_compensation"),
    note: z.string(),
  }),
]);

/**
 * Showcases:
 * - beforeCompensate / afterCompensate
 * - compensation context scope/forEach/select/sleep/channels/streams/events
 * - CompensationStepCall.retry()
 * - human-in-the-loop compensation via channels + events + streams
 */
export const compensationHooksWorkflow = defineWorkflow({
  name: "compensationHooks",
  args: CompensationHooksArgs,
  channels: { compAck: CompensationCommand, operatorResolution: OperatorResolution },
  streams: {
    compLog: z.object({ msg: z.string(), ts: z.number() }),
    interventionLog: z.object({
      kind: z.enum(["requested", "retry_failed", "resolved", "aborted"]),
      note: z.string(),
      ts: z.number(),
    }),
  },
  events: {
    compensationStarted: true,
    compensationComplete: true,
    manualInterventionRequested: true,
    manualInterventionResolved: true,
  },
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
        let result = await compCtx.steps
          .cancelFlight(args.destination, args.customerId)
          .retry({ maxAttempts: 15, intervalSeconds: 10, backoffRate: 2 });

        if (!result.ok) {
          compCtx.logger.error("Flight cancellation failed after retries", {
            reason: result.reason,
          });

          // Human-in-the-loop flow:
          // Compensation cannot be compensated itself, so we must explicitly
          // handle failure paths. Emit durable signals/logs and wait for operator input.
          await compCtx.events.manualInterventionRequested.set();
          await compCtx.streams.interventionLog.write({
            kind: "requested",
            note: `cancelFlight failed (${result.reason}); waiting for operator resolution`,
            ts: compCtx.timestamp,
          });

          while (true) {
            const resolution = await compCtx.channels.operatorResolution.receive();
            if (resolution.action === "retry_cancel") {
              result = await compCtx.steps
                .cancelFlight(args.destination, args.customerId)
                .retry({ maxAttempts: 5, intervalSeconds: 5 });

              if (result.ok) {
                await compCtx.events.manualInterventionResolved.set();
                await compCtx.streams.interventionLog.write({
                  kind: "resolved",
                  note: `operator requested retry and cancellation succeeded: ${resolution.note}`,
                  ts: compCtx.timestamp,
                });
                break;
              }

              await compCtx.streams.interventionLog.write({
                kind: "retry_failed",
                note: `operator retry failed (${result.reason}): ${resolution.note}`,
                ts: compCtx.timestamp,
              });
              continue;
            }

            if (resolution.action === "confirm_resolved") {
              await compCtx.events.manualInterventionResolved.set();
              await compCtx.streams.interventionLog.write({
                kind: "resolved",
                note: `operator confirmed externally resolved: ${resolution.note}`,
                ts: compCtx.timestamp,
              });
              break;
            }

            await compCtx.streams.interventionLog.write({
              kind: "aborted",
              note: `operator aborted compensation path: ${resolution.note}`,
              ts: compCtx.timestamp,
            });
            break;
          }
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
