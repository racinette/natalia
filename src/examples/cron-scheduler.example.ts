import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { sendNotification } from "./shared";

const DailyReportJobArgs = z.object({
  userId: z.string(),
  reportDate: z.string(),
});

/**
 * Showcases:
 * - a per-tick workflow with no scheduling concerns
 * - regular step execution inside a detached child workflow
 */
export const dailyReportJobWorkflow = defineWorkflow({
  name: "dailyReportJob",
  args: DailyReportJobArgs,
  steps: { sendNotification },

  async execute(ctx, args) {
    await ctx.steps.sendNotification(
      args.userId,
      `Your daily report for ${args.reportDate} is ready.`,
    );
  },
});

const DailyReportSchedulerArgs = z.object({
  userId: z.string(),
});

/**
 * Showcases:
 * - ctx.schedule() for cron-like durable scheduling
 * - step-level deadlineUntil via .retry(...) override
 * - deadlineUntil on detached child workflow calls
 * - fast-forward over missed ticks without custom lateness logic
 */
export const dailyReportSchedulerWorkflow = defineWorkflow({
  name: "dailyReportScheduler",
  args: DailyReportSchedulerArgs,
  steps: { sendNotification },
  childWorkflows: { job: dailyReportJobWorkflow },
  rng: { ids: true },

  async execute(ctx, args) {
    const schedule = ctx.schedule("0 9 * * 1-5", "America/New_York");

    for await (const tick of schedule) {
      await ctx.steps.sendNotification(
        args.userId,
        `Preparing daily report for ${tick.scheduledAt.toISOString()}`,
      ).retry({
        maxAttempts: 5,
        intervalSeconds: 10,
        deadlineUntil: tick.nextScheduledAt,
      });

      await ctx.childWorkflows.job({
        id: `daily-report-${ctx.rng.ids.uuidv4()}`,
        args: {
          userId: args.userId,
          reportDate: tick.scheduledAt.toISOString(),
        },
        detached: true,
        deadlineUntil: tick.nextScheduledAt,
      });
    }
  },
});
