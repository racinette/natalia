import { z } from "zod";
import { defineWorkflow } from "../workflow";
import {
  bookFlight,
  cancelFlight,
  bookHotel,
  cancelHotel,
  sendEmail,
} from "./shared";

const OrderArgs = z.object({
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  customerId: z.string(),
  customerEmail: z.string(),
});

const ApprovalMessage = z.object({ approved: z.boolean(), reason: z.string() });

/**
 * Showcases:
 * - sequential compensation (unconditional)
 * - .failure/.complete/.retry
 * - dontCompensate
 * - channels.receive + afterCompensate + mutable state
 */
export const orderWorkflow = defineWorkflow({
  name: "order",
  args: OrderArgs,
  channels: { approval: ApprovalMessage },
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },
  result: z.object({
    flightId: z.string().nullable(),
    hotelId: z.string().nullable(),
    approved: z.boolean(),
  }),
  state: () => ({
    phase: "init" as "init" | "flightBooked" | "approved" | "done",
    flightId: null as string | null,
    hotelId: null as string | null,
  }),
  afterCompensate: async ({ ctx: compCtx, args }) => {
    compCtx.logger.info("Order failed — notifying customer", {
      id: compCtx.workflowId,
    });
    const result = await compCtx.steps.sendEmail(
      args.customerEmail,
      "Order Failed",
      "We were unable to complete your order. Any charges have been refunded.",
    );
    if (!result.ok) {
      compCtx.logger.error("Failed to send failure notification");
    }
  },

  async execute(ctx, args) {
    const flightId = await ctx.steps
      .bookFlight(args.destination, args.customerId)
      .compensate(async (compCtx) => {
        await compCtx.steps.cancelFlight(args.destination, args.customerId);
      })
      .retry({ maxAttempts: 5, intervalSeconds: 2, backoffRate: 1.5 })
      .failure(async (failure) => {
        ctx.logger.warn("Flight booking failed", {
          reason: failure.reason,
          attempts: failure.errors.count,
        });
        await failure.compensate();
        return null;
      })
      .complete((data) => data.id);

    ctx.state.flightId = flightId;
    ctx.state.phase = "flightBooked";

    const approval = await ctx.channels.approval.receive();
    if (!approval.approved) {
      ctx.logger.info("Order rejected", { reason: approval.reason });
      return { flightId: ctx.state.flightId, hotelId: null, approved: false };
    }

    ctx.state.phase = "approved";

    const hotelId = await ctx.scope(
      {
        hotel: ctx.steps
          .bookHotel(args.destination, args.checkIn, args.checkOut)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelHotel(
              args.destination,
              args.checkIn,
              args.checkOut,
            );
          }),
      },
      async ({ hotel }) => {
        const result = await ctx.map(
          { hotel },
          {
            hotel: {
              complete: (data) => data.id as string | null,
              failure: (failure) => {
                failure.dontCompensate();
                ctx.logger.error(
                  "Hotel booking failed — no side effects, skipping compensation",
                );
                return null;
              },
            },
          },
        );
        return result.hotel ?? null;
      },
    );

    ctx.state.hotelId = hotelId;
    ctx.state.phase = "done";

    return {
      flightId: ctx.state.flightId,
      hotelId: ctx.state.hotelId,
      approved: true,
    };
  },
});
