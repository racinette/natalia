import { z } from "zod";
import { defineWorkflow } from "../workflow";

const ChannelTimeoutDemoMessage = z.object({
  type: z.literal("message"),
  id: z.string(),
  body: z.string(),
});

/**
 * Showcases:
 * - `receiveNowait()` as a non-blocking poll (returns immediately)
 * - `receive(timeoutSeconds)` returning `undefined` on timeout
 * - `receive(timeoutSeconds, defaultValue)` returning the provided default on timeout
 */
export const channelTimeoutWorkflow = defineWorkflow({
  name: "channelTimeout",
  channels: { inbox: ChannelTimeoutDemoMessage },
  result: z.object({
    nowaitMessageId: z.string().nullable(),
    timedMessageId: z.string().nullable(),
    timeoutWithDefaultType: z.enum(["message", "timeout"]),
    blockingMessageId: z.string(),
  }),

  async execute(ctx) {
    // Non-blocking poll: returns immediately with message or undefined.
    const nowait = await ctx.channels.inbox.receiveNowait();

    // Timed receive: returns undefined if no message arrives within 120 seconds.
    const timed = await ctx.channels.inbox.receive(120);

    // Timed receive with fallback: returns fallback object instead of undefined.
    const timeoutWithDefault = await ctx.channels.inbox.receive(120, {
      type: "timeout" as const,
      id: "timeout",
      body: "No inbox message within 120 seconds",
    });

    // Plain receive: blocks until a message is available.
    const blocking = await ctx.channels.inbox.receive();

    return {
      nowaitMessageId: nowait?.id ?? null,
      timedMessageId: timed?.id ?? null,
      timeoutWithDefaultType: timeoutWithDefault.type,
      blockingMessageId: blocking.id,
    };
  },
});
