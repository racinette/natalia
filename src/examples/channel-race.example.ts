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
 * - select({ branch, channel.receive() }) with for-await (one-shot race)
 * - select({ branch, channel }) with match() (streaming channel in select)
 * - match() with explicit handlers for all keys including streaming channel
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
    const outcome = await ctx.join(
      ctx.scope(
        "BookingCancelRace",
        {
          booking: ctx.steps
            .bookFlight(args.destination, args.customerId)
            .compensate(async (ctx) => {
              await ctx.join(
                ctx.steps.cancelFlight(args.destination, args.customerId),
              );
            }),
        },
        async (ctx, { booking }) => {
          // One-shot race: booking completes OR a single cancel message arrives.
          // channel.receive() produces a ChannelReceiveCall — finite, removed from
          // remaining once resolved, so the for-await loop terminates naturally.
          const sel = ctx.select({
            booking,
            cancel: ctx.channels.cancel.receive(),
          });
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
      ),
    );

    if (outcome.outcome === "cancelled") {
      ctx.logger.info("Booking cancelled by user");
      return { outcome: "cancelled" as const, flightId: null };
    }

    const cancelMsg = await ctx.join(
      ctx.scope(
        "StreamingCancelRace",
        {
          booking2: ctx.steps
            .bookFlight(`${args.destination}-2`, args.customerId)
            .compensate(async (ctx) => {
              await ctx.join(
                ctx.steps.cancelFlight(
                  `${args.destination}-2`,
                  args.customerId,
                ),
              );
            }),
        },
        async (ctx, { booking2 }) => {
          // Streaming channel: passes the raw ChannelHandle so the channel branch
          // fires on each incoming cancel message (never removed from remaining).
          // match() iterates events; we break after the first to get a one-shot result.
          const sel2 = ctx.select({ booking2, cancel2: ctx.channels.cancel });
          for await (const result of sel2.match({
            booking2: {
              complete: (data) => ({ type: "booked" as const, id: data.id }),
              failure: async () => ({ type: "failed" as const, id: null }),
            },
            cancel2: (data) => ({
              type: "cancelled" as const,
              reason: data.reason,
            }),
          })) {
            return result;
          }
          throw new Error("Selection exhausted unexpectedly");
        },
      ),
    );

    ctx.logger.info("Second scope result", { cancelMsg });
    return { outcome: "booked" as const, flightId: outcome.flightId };
  },
});
