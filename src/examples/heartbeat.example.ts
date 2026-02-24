import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { sendEmail } from "./shared";

/**
 * Showcases:
 * - minimal step execution
 * - id/timestamp/date/logger
 * - streams.write + events.set + sleep
 */
export const heartbeatWorkflow = defineWorkflow({
  name: "heartbeat",
  steps: { sendEmail },
  streams: { auditLog: z.object({ msg: z.string(), ts: z.number() }) },
  events: { done: true },

  async execute(ctx) {
    ctx.logger.info("Heartbeat started", {
      id: ctx.workflowId,
      ts: ctx.timestamp,
      date: ctx.date.toISOString(),
    });
    ctx.logger.debug("Debug probe");
    ctx.logger.warn("Example warning for demo");
    ctx.logger.error("Example error for demo");

    await ctx.streams.auditLog.write({
      msg: "Heartbeat check initiated",
      ts: ctx.timestamp,
    });

    await ctx.sleep(1);

    await ctx.steps.sendEmail(
      "ops@example.com",
      "Heartbeat",
      `System alive as of ${ctx.date.toISOString()}`,
    );

    await ctx.events.done.set();

    await ctx.streams.auditLog.write({
      msg: "Heartbeat complete",
      ts: ctx.timestamp,
    });
  },
});
