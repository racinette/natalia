import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { bookFlight, cancelFlight } from "./shared";

const ChannelRaceArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
});

const CancelCommand = z.object({
  type: z.literal("cancel"),
  reason: z.string(),
});

/**
 * Showcases:
 * - channels.receive standalone
 * - select({ branch, channel }) with for-await
 * - match with default handler
 */
export const channelRaceWorkflow = defineWorkflow({
  name: "channelRace",
  args: ChannelRaceArgs,
  channels: { cancel: CancelCommand },
  steps: { bookFlight, cancelFlight },
  result: z.object({
    outcome: z.enum(["booked", "cancelled"]),
    flightId: z.string().nullable(),
  }),

  async execute(ctx, args) {
    const outcome = await ctx.scope(
      {
        booking: ctx.steps
          .bookFlight(args.destination, args.customerId)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelFlight(args.destination, args.customerId);
          }),
      },
      async ({ booking }) => {
        const sel = ctx.select({ booking, cancel: ctx.channels.cancel });
        for await (const data of sel) {
          ctx.logger.info("Race event received", { data });
          if ("id" in data) {
            return {
              outcome: "booked" as const,
              flightId: (data as { id: string }).id,
            };
          }
          return { outcome: "cancelled" as const, flightId: null };
        }
        throw new Error("Selection exhausted unexpectedly");
      },
    );

    if (outcome.outcome === "cancelled") {
      ctx.logger.info("Booking cancelled by user");
      return { outcome: "cancelled" as const, flightId: null };
    }

    const cancelMsg = await ctx.scope(
      {
        booking2: ctx.steps
          .bookFlight(`${args.destination}-2`, args.customerId)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelFlight(
              `${args.destination}-2`,
              args.customerId,
            );
          }),
      },
      async ({ booking2 }) => {
        const sel2 = ctx.select({ booking2, cancel2: ctx.channels.cancel });
        const result = await sel2.match(
          {
            booking2: {
              complete: (data) => ({ type: "booked" as const, id: data.id }),
              failure: async () => ({ type: "failed" as const, id: null }),
            },
          },
          (event) => ({
            type: "unhandled" as const,
            key: event.key,
          }),
        );

        return result;
      },
    );

    ctx.logger.info("Second scope result", { cancelMsg });
    return { outcome: "booked" as const, flightId: outcome.flightId };
  },
});
