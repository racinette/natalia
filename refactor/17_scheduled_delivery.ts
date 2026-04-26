import { z } from "zod";
import { createWorkflowClient } from "../client";
import { defineQueue, defineWorkflow, defineWorkflowHeader } from "../workflow";
import type { ScheduledDeliveryOptions } from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const noSchedule: ScheduledDeliveryOptions = {};
const byDelay: ScheduledDeliveryOptions = { delaySeconds: 60 };
const byDate: ScheduledDeliveryOptions = {
  scheduledAt: new Date("2027-01-01T00:00:00.000Z"),
};

// @ts-expect-error schedule options are mutually exclusive
const invalidBoth: ScheduledDeliveryOptions = {
  delaySeconds: 60,
  scheduledAt: new Date(),
};

const followUpHeader = defineWorkflowHeader({
  name: "scheduledFollowUp",
  args: z.object({ parentId: z.string() }),
  result: z.object({ ok: z.boolean() }),
});

const scheduledQueue = defineQueue({
  name: "scheduledQueueAcceptance",
  message: z.object({ id: z.string() }),
});

export const scheduledDeliveryAcceptanceWorkflow = defineWorkflow({
  name: "scheduledDeliveryAcceptance",
  queues: { scheduled: scheduledQueue },
  childWorkflows: { followUp: followUpHeader },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.queues.scheduled.enqueue({ id: "q-1" }, { delaySeconds: 30 });
    ctx.queues.scheduled.enqueue(
      { id: "q-2" },
      { scheduledAt: new Date("2027-01-01T00:00:00.000Z") },
    );

    // @ts-expect-error enqueue schedule accepts one scheduling mode
    ctx.queues.scheduled.enqueue({ id: "q-3" }, { delaySeconds: 1, scheduledAt: new Date() });

    const attached = await ctx.childWorkflows.followUp({
      idempotencyKey: "follow-up-attached",
      args: { parentId: "parent-1" },
      delaySeconds: 86400,
    });
    type _AttachedScheduled = Assert<
      IsEqual<
        typeof attached,
        | { ok: true; result: { ok: boolean } }
        | { ok: false; status: "failed"; error: unknown }
      >
    >;

    ctx.childWorkflows.followUp.startDetached({
      idempotencyKey: "follow-up-detached",
      args: { parentId: "parent-2" },
      scheduledAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    // @ts-expect-error child workflow schedule accepts one scheduling mode
    ctx.childWorkflows.followUp.startDetached({
      idempotencyKey: "bad-schedule",
      args: { parentId: "parent-3" },
      delaySeconds: 10,
      scheduledAt: new Date(),
    });

    return { ok: true };
  },
});

const client = createWorkflowClient({
  scheduledDeliveryAcceptance: scheduledDeliveryAcceptanceWorkflow,
});

async function rootStartScheduling(): Promise<void> {
  await client.workflows.scheduledDeliveryAcceptance.start({
    idempotencyKey: "scheduled-root-delay",
    delaySeconds: 3600,
  });

  await client.workflows.scheduledDeliveryAcceptance.start({
    idempotencyKey: "scheduled-root-date",
    scheduledAt: new Date("2027-01-01T00:00:00.000Z"),
  });

  // @ts-expect-error root workflow start schedule accepts one scheduling mode
  await client.workflows.scheduledDeliveryAcceptance.start({
    idempotencyKey: "scheduled-root-invalid",
    delaySeconds: 3600,
    scheduledAt: new Date(),
  });
}

void noSchedule;
void byDelay;
void byDate;
void invalidBoth;
void rootStartScheduling;
