import { z } from "zod";
import { defineWorkflow } from "../workflow";
import {
  bookFlight,
  cancelFlight,
  bookHotel,
  cancelHotel,
  sendEmail,
} from "./shared";

const FlightBookingArgs = z.object({
  destination: z.string(),
  backupDestination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  customerId: z.string(),
  customerEmail: z.string(),
});

/**
 * Showcases:
 * - scope with closure entries
 * - ctx.match() race pattern
 * - nested scope
 * - ctx.match() with explicit + onFailure handlers
 */
export const flightBookingWorkflow = defineWorkflow({
  name: "flightBooking",
  args: FlightBookingArgs,
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },
  result: z.object({ flightId: z.string(), hotelId: z.string() }),

  async execute(ctx, args) {
    const flight = await ctx
      .first({
        provider1: async (ctx) =>
          ctx.steps
            .bookFlight(`${args.destination}/p1`, args.customerId)
            .compensate(async (ctx) => {
              await ctx.steps
                .cancelFlight(`${args.destination}/p1`, args.customerId)
                .resolve(ctx);
            })
            .resolve(ctx),
        provider2: async (ctx) =>
          ctx.steps
            .bookFlight(`${args.destination}/p2`, args.customerId)
            .compensate(async (ctx) => {
              await ctx.steps
                .cancelFlight(`${args.destination}/p2`, args.customerId)
                .resolve(ctx);
            })
            .retry({ maxAttempts: 5 })
            .resolve(ctx),
      })
      .resolve(ctx);

    const hotelId = await ctx
      .scope(
        "PickHotelProvider",
        {
          primary: async (ctx) =>
            ctx.steps
              .bookHotel(args.destination, args.checkIn, args.checkOut)
              .compensate(async (ctx) => {
                await ctx.steps
                  .cancelHotel(args.destination, args.checkIn, args.checkOut)
                  .resolve(ctx);
              })
              .resolve(ctx),
          backup: async (ctx) =>
            ctx.steps
              .bookHotel(args.backupDestination, args.checkIn, args.checkOut)
              .compensate(async (ctx) => {
                await ctx.steps
                  .cancelHotel(
                    args.backupDestination,
                    args.checkIn,
                    args.checkOut,
                  )
                  .resolve(ctx);
              })
              .resolve(ctx),
        },
        async (ctx, { primary, backup }) => {
          const sel = ctx.select({ primary, backup });
          for await (const result of ctx.match(
            sel,
            {
              primary: {
                complete: (data) => ({
                  ok: true as const,
                  id: data.id,
                  dest: args.destination,
                }),
                failure: (failure) => {
                  ctx.logger.warn("Primary hotel failed — falling back");
                  if (failure.kind === "step") {
                    ctx.logger.warn("Primary failure kind", { step: failure.name });
                  }
                  return { ok: false as const, id: null, dest: null };
                },
              },
              backup: (data) => ({
                ok: true as const,
                id: data.id,
                dest: args.backupDestination,
              }),
            },
            async (failure) => {
              ctx.logger.error("Backup hotel also failed");
              if (failure.kind === "exception") {
                ctx.logger.error("Backup scope exception", { error: failure.error });
              }
              return { ok: false as const, id: null, dest: null };
            },
          )) {
            if (result.ok) {
              ctx.logger.info("Hotel booked", { dest: result.dest });
              return result.id;
            }
          }
          throw new Error(
            "No hotel available at primary or backup destination",
          );
        },
      )
      .resolve(ctx);

    await ctx.steps
      .sendEmail(
        args.customerEmail,
        "Booking Confirmed",
        `Flight: ${flight.result.id}, Hotel: ${hotelId}`,
      )
      .resolve(ctx);

    return { flightId: flight.result.id, hotelId };
  },
});
