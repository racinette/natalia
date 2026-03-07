import { z } from "zod";
import { defineWorkflow } from "../workflow";
import {
  bookFlight,
  cancelFlight,
  bookHotel,
  cancelHotel,
  sendEmail,
} from "./shared";

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
 * - compensation context scope/select/match/sleep/channels/streams/events
 * - CompensationStepCall.retry()
 * - human-in-the-loop compensation via channels + events + streams
 */
export const compensationHooksWorkflow = defineWorkflow({
  name: "compensationHooks",
  args: CompensationHooksArgs,
  channels: {
    compAck: CompensationCommand,
    operatorResolution: OperatorResolution,
  },
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
    ctx.logger.info("Compensation starting", { id: ctx.workflowId });
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

    await ctx
      .scope(
        "CompensationNotifications",
        {
          logEntry: async (ctx) =>
            ctx.steps
              .sendEmail(
                args.notificationEmail,
                "Order Compensated",
                `Your order to ${args.destination} was cancelled and refunded.`,
              )
              .resolve(ctx),
          auditEntry: async (ctx) =>
            ctx.steps
              .sendEmail(
                "audit@example.com",
                "Compensation Complete",
                `Workflow ${ctx.workflowId} fully compensated.`,
              )
              .retry({ maxAttempts: 5 })
              .resolve(ctx),
        },
        async (ctx, { logEntry, auditEntry }) => {
          const sel = ctx.select({ logEntry, auditEntry });
          const notificationResults: {
            logEntry?: boolean;
            auditEntry?: boolean;
          } = {};
          for await (const result of ctx.match(sel, {
            logEntry: (data) => ({ key: "logEntry" as const, ok: data.ok }),
            auditEntry: (data) => ({ key: "auditEntry" as const, ok: data.ok }),
          })) {
            notificationResults[result.key] = result.ok;
          }
          if (!notificationResults.logEntry) {
            ctx.logger.warn("Customer notification failed to send");
          }
          if (!notificationResults.auditEntry) {
            ctx.logger.warn("Audit notification failed to send");
          }
        },
      )
      .resolve(ctx);

    await ctx.streams.compLog.write({
      msg: "Compensation finalized",
      ts: ctx.timestamp,
    });
    await ctx.events.compensationComplete.set();
  },

  async execute(ctx, args) {
    await ctx.steps
      .bookFlight(args.destination, args.customerId)
      .compensate(async (ctx) => {
        let result = await ctx.steps
          .cancelFlight(args.destination, args.customerId)
          .retry({ maxAttempts: 15, intervalSeconds: 10, backoffRate: 2 })
          .resolve(ctx);

        if (!result.ok) {
          ctx.logger.error("Flight cancellation failed after retries", {
            reason: result.reason,
          });

          // Human-in-the-loop flow:
          // Compensation cannot be compensated itself, so we must explicitly
          // handle failure paths. Emit durable signals/logs and wait for operator input.
          await ctx.events.manualInterventionRequested.set();
          await ctx.streams.interventionLog.write({
            kind: "requested",
            note: `cancelFlight failed (${result.reason}); waiting for operator resolution`,
            ts: ctx.timestamp,
          });

          for await (const resolution of ctx.channels.operatorResolution) {
            if (resolution.action === "retry_cancel") {
              result = await ctx.steps
                .cancelFlight(args.destination, args.customerId)
                .retry({ maxAttempts: 5, intervalSeconds: 5 })
                .resolve(ctx);

              if (result.ok) {
                await ctx.events.manualInterventionResolved.set();
                await ctx.streams.interventionLog.write({
                  kind: "resolved",
                  note: `operator requested retry and cancellation succeeded: ${resolution.note}`,
                  ts: ctx.timestamp,
                });
                break;
              }

              await ctx.streams.interventionLog.write({
                kind: "retry_failed",
                note: `operator retry failed (${result.reason}): ${resolution.note}`,
                ts: ctx.timestamp,
              });
              continue;
            }

            if (resolution.action === "confirm_resolved") {
              await ctx.events.manualInterventionResolved.set();
              await ctx.streams.interventionLog.write({
                kind: "resolved",
                note: `operator confirmed externally resolved: ${resolution.note}`,
                ts: ctx.timestamp,
              });
              break;
            }

            await ctx.streams.interventionLog.write({
              kind: "aborted",
              note: `operator aborted compensation path: ${resolution.note}`,
              ts: ctx.timestamp,
            });
            break;
          }
        }
      })
      .resolve(ctx);

    await ctx.steps
      .bookHotel(args.destination, args.checkIn, args.checkOut)
      .compensate(async (ctx) => {
        await ctx
          .scope(
            "HotelCompensationBranches",
            {
              cancel: async (ctx) =>
                ctx.steps
                  .cancelHotel(args.destination, args.checkIn, args.checkOut)
                  .retry({ maxAttempts: 10 })
                  .resolve(ctx),
              notify: async (ctx) =>
                ctx.steps
                  .sendEmail(
                    args.notificationEmail,
                    "Hotel Cancelled",
                    `Hotel booking for ${args.destination} was cancelled.`,
                  )
                  .resolve(ctx),
            },
            async (ctx, { cancel, notify }) => {
              const sel = ctx.select({ cancel, notify });
              for await (const _event of ctx.match(sel)) {
                ctx.logger.debug("Compensation branch resolved");
              }
            },
          )
          .resolve(ctx);

        await ctx.streams.compLog.write({
          msg: `Hotel compensation complete for ${args.destination}`,
          ts: ctx.timestamp,
        });
      })
      .resolve(ctx);

    throw new Error("Intentional failure to trigger compensation demo");
  },
});
