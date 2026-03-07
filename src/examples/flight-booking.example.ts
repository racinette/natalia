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
    const flight = await ctx.execute(
      ctx.first({
        provider1: async (ctx) =>
          ctx.execute(
            ctx.steps
              .bookFlight(`${args.destination}/p1`, args.customerId)
              .compensate(async (ctx) => {
                await ctx.execute(
                  ctx.steps.cancelFlight(
                    `${args.destination}/p1`,
                    args.customerId,
                  ),
                );
              }),
          ),
        provider2: async (ctx) =>
          ctx.execute(
            ctx.steps
              .bookFlight(`${args.destination}/p2`, args.customerId)
              .compensate(async (ctx) => {
                await ctx.execute(
                  ctx.steps.cancelFlight(
                    `${args.destination}/p2`,
                    args.customerId,
                  ),
                );
              })
              .retry({ maxAttempts: 5 }),
          ),
      }),
    );

    const hotelId = await ctx.execute(
      ctx.scope(
        "PickHotelProvider",
        {
          primary: async (ctx) =>
            ctx.execute(
              ctx.steps
                .bookHotel(args.destination, args.checkIn, args.checkOut)
                .compensate(async (ctx) => {
                  await ctx.execute(
                    ctx.steps.cancelHotel(
                      args.destination,
                      args.checkIn,
                      args.checkOut,
                    ),
                  );
                }),
            ),
          backup: async (ctx) =>
            ctx.execute(
              ctx.steps
                .bookHotel(args.backupDestination, args.checkIn, args.checkOut)
                .compensate(async (ctx) => {
                  await ctx.execute(
                    ctx.steps.cancelHotel(
                      args.backupDestination,
                      args.checkIn,
                      args.checkOut,
                    ),
                  );
                }),
            ),
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
                failure: () => {
                  ctx.logger.warn("Primary hotel failed — falling back");
                  return { ok: false as const, id: null, dest: null };
                },
              },
              backup: (data) => ({
                ok: true as const,
                id: data.id,
                dest: args.backupDestination,
              }),
            },
            async () => {
              ctx.logger.error("Backup hotel also failed");
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
      ),
    );

    await ctx.execute(
      ctx.steps.sendEmail(
        args.customerEmail,
        "Booking Confirmed",
        `Flight: ${flight.result.id}, Hotel: ${hotelId}`,
      ),
    );

    return { flightId: flight.result.id, hotelId };
  },
});
