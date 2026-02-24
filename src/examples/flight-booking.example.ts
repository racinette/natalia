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
 * - scope with shorthand entries
 * - for-await race
 * - nested scope
 * - selection.remaining + .match loop
 */
export const flightBookingWorkflow = defineWorkflow({
  name: "flightBooking",
  args: FlightBookingArgs,
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },
  result: z.object({ flightId: z.string(), hotelId: z.string() }),

  async execute(ctx, args) {
    const flight = await ctx.scope(
      {
        provider1: ctx.steps
          .bookFlight(`${args.destination}/p1`, args.customerId)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelFlight(
              `${args.destination}/p1`,
              args.customerId,
            );
          }),
        provider2: ctx.steps
          .bookFlight(`${args.destination}/p2`, args.customerId)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelFlight(
              `${args.destination}/p2`,
              args.customerId,
            );
          })
          .retry({ maxAttempts: 5 }),
      },
      async ({ provider1, provider2 }) => {
        const sel = ctx.select({ provider1, provider2 });
        for await (const data of sel) {
          return data;
        }
        throw new Error("All flight providers exhausted");
      },
    );

    const hotelId = await ctx.scope(
      {
        primary: ctx.steps
          .bookHotel(args.destination, args.checkIn, args.checkOut)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelHotel(
              args.destination,
              args.checkIn,
              args.checkOut,
            );
          }),
        backup: ctx.steps
          .bookHotel(args.backupDestination, args.checkIn, args.checkOut)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelHotel(
              args.backupDestination,
              args.checkIn,
              args.checkOut,
            );
          }),
      },
      async ({ primary, backup }) => {
        const sel = ctx.select({ primary, backup });
        while (sel.remaining.size > 0) {
          const result = await sel.match({
            primary: {
              complete: (data) => ({
                ok: true as const,
                id: data.id,
                dest: args.destination,
              }),
              failure: async ({ compensate }) => {
                ctx.logger.warn("Primary hotel failed — falling back");
                await compensate();
                return { ok: false as const, id: null, dest: null };
              },
            },
            backup: {
              complete: (data) => ({
                ok: true as const,
                id: data.id,
                dest: args.backupDestination,
              }),
              failure: async (failure) => {
                ctx.logger.error("Backup hotel also failed");
                await failure.compensate();
                return { ok: false as const, id: null, dest: null };
              },
            },
          });

          if (result.status === "exhausted") break;
          if (result.data.ok) {
            ctx.logger.info("Hotel booked", { dest: result.data.dest });
            return result.data.id;
          }
        }
        throw new Error("No hotel available at primary or backup destination");
      },
    );

    await ctx.steps.sendEmail(
      args.customerEmail,
      "Booking Confirmed",
      `Flight: ${flight.id}, Hotel: ${hotelId}`,
    );

    return { flightId: flight.id, hotelId };
  },
});
