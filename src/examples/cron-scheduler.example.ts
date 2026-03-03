import { z } from "zod";
import { defineWorkflow, defineWorkflowHeader } from "../workflow";
import { sendNotification } from "./shared";

// =============================================================================
// SCHEMAS
// =============================================================================

const DailyReportJobArgs = z.object({
  userId: z.string(),
  reportDate: z.string(),
});

const SchedulerManagerArgs = z.object({
  userId: z.string(),
  resumeAt: z.iso.datetime().optional(),
});

const SchedulerWorkerArgs = z.object({
  userId: z.string(),
  managerIdempotencyKey: z.string(),
  resumeAt: z.iso.datetime().optional(),
  maxTicks: z.number(),
});

// undefined lastTickAt signals zero progress — manager retries from same resumeAt.
const WorkerDonePayload = z.object({
  workerId: z.string(),
  lastTickAt: z.string().optional(),
});

// =============================================================================
// JOB WORKFLOW — one per tick, no scheduling concerns
// =============================================================================

export const dailyReportJobWorkflow = defineWorkflow({
  name: "dailyReportJob",
  args: DailyReportJobArgs,
  steps: { sendNotification },

  async execute(ctx, args) {
    await ctx.join(ctx.steps.sendNotification(
      args.userId,
      `Your daily report for ${args.reportDate} is ready.`,
    ));
  },
});

// =============================================================================
// MANAGER HEADER
//
// Captures the manager's authoring contract — name + channels — before the
// full definition exists. The worker references this header in its
// foreignWorkflows, breaking the circular dependency. The manager then spreads
// the header into its own defineWorkflow call so the name and channel schemas
// are declared exactly once.
//
// In a multi-file project this would live in manager.ts and be imported by
// worker.ts; the circular dependency resolves naturally at module load time.
// =============================================================================

const schedulerManagerHeader = defineWorkflowHeader({
  name: "dailyReportSchedulerManager",
  channels: { workerDone: WorkerDonePayload },
});

// =============================================================================
// WORKER WORKFLOW
//
// Runs a bounded number of ticks, then completes naturally. History is O(maxTicks),
// so it stays small and is GC'd quickly after the handoff.
//
// Showcases:
// - detached child workflows (workers must not participate in manager compensation)
// - beforeSettle with status-discriminated context for unified handoff delivery
// - state-based dateSent guard for idempotent workerDone signaling
// - undefined lastTickAt when zero progress was made
// =============================================================================

export const dailyReportSchedulerWorkerWorkflow = defineWorkflow({
  name: "dailyReportSchedulerWorker",
  args: SchedulerWorkerArgs,
  steps: { sendNotification },
  childWorkflows: { job: dailyReportJobWorkflow },
  foreignWorkflows: { manager: schedulerManagerHeader },
  rng: { ids: true },
  state: () => ({
    lastTickAt: undefined as string | undefined,
  }),
  retention: {
    complete: 3600,
    failed: 86400 * 30,
    terminated: 3600,
  },

  // Runs once before final status is settled:
  // - complete: WorkflowContext + result
  // - failed/terminated: CompensationContext
  // This lets us send workerDone from one place on every outcome.
  beforeSettle: async (params) => {
    const { ctx, args } = params;
    await ctx.join(ctx.foreignWorkflows.manager
      .get(args.managerIdempotencyKey)
      .channels.workerDone.send({
        workerId: ctx.workflowId,
        lastTickAt: ctx.state.lastTickAt,
      }));
  },

  async execute(ctx, args) {
    const schedule = ctx.schedule("0 9 * * 1-5", {
      timezone: "America/New_York",
      resumeAt: args.resumeAt ? new Date(args.resumeAt) : undefined,
    });

    let count = 0;
    for await (const tick of schedule) {
      await ctx.join(ctx.steps
        .sendNotification(
          args.userId,
          `Preparing daily report for ${tick.scheduledAt.toISOString()}`,
        )
        .retry({
          maxAttempts: 5,
          intervalSeconds: 10,
          deadlineUntil: tick.nextScheduledAt,
        }));

      await ctx.join(ctx.childWorkflows.job({
        idempotencyKey: `daily-report-${ctx.rng.ids.uuidv4()}`,
        args: {
          userId: args.userId,
          reportDate: tick.scheduledAt.toISOString(),
        },
        detached: true,
        deadlineUntil: tick.nextScheduledAt,
        retention: {
          complete: 7 * 24 * 3600,
          failed: 30 * 24 * 3600,
          terminated: 7 * 24 * 3600,
        },
      }));

      ctx.state.lastTickAt = tick.scheduledAt.toISOString();
      if (++count >= args.maxTicks) break;
    }
  },
});

// =============================================================================
// MANAGER WORKFLOW
//
// Stable idempotency key, infinite loop. History grows at O(total_ticks / maxTicks) —
// one child-start + one channel-receive per worker generation.
// At 1000 ticks/generation on a daily schedule that is roughly one new
// history entry every 2.7 years.
//
// Showcases:
// - manager/worker split as the idiomatic "continue-as-new" replacement
// - detached worker start (workers are independent; manager failure must not
//   trigger their compensation)
// - workerDone channel with workerId deduplication to drain stale messages
//   left from a previous manager replay
// - streams.currentWorker for external consumers that need to observe or
//   interact with the active scheduler generation
// - resumeAt advances only when the worker made progress; a zero-progress
//   worker leaves the anchor unchanged so the next generation retries it
// =============================================================================

export const dailyReportSchedulerManagerWorkflow = defineWorkflow({
  ...schedulerManagerHeader, // name + channels declared once
  args: SchedulerManagerArgs,
  streams: {
    currentWorker: z.object({ workerId: z.string() }),
  },
  childWorkflows: { worker: dailyReportSchedulerWorkerWorkflow },
  rng: { gen: true },

  async execute(ctx, args) {
    let resumeAt = args.resumeAt;

    while (true) {
      const workerId = `scheduler-worker-${ctx.rng.gen.uuidv4()}`;

      await ctx.join(ctx.childWorkflows.worker({
        idempotencyKey: workerId,
        args: {
          userId: args.userId,
          managerIdempotencyKey: ctx.workflowId,
          resumeAt,
          maxTicks: 1000,
        },
        detached: true,
      }));

      // Broadcast the current generation for external observers.
      await ctx.join(ctx.streams.currentWorker.write({ workerId }));

      // Drain stale messages: if the manager replayed after a crash mid-handoff,
      // the previous worker's message may still be in the channel queue.
      let msg;
      do {
        msg = await ctx.join(ctx.channels.workerDone.receive());
      } while (msg.workerId !== workerId);

      // No lastTickAt means zero progress — keep the same anchor so the next
      // worker retries from exactly where this one could not start.
      if (msg.lastTickAt) {
        resumeAt = msg.lastTickAt;
      }
    }
  },
});
