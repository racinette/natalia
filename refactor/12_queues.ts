import { z } from "zod";
import { createWorkflowClient } from "../client";
import { defineQueue, defineWorkflow, UnrecoverableError } from "../workflow";
import type {
  DeadLetteredMessage,
  DeadLetterSearchQuery,
  QueueHandlerContext,
  ScheduledDeliveryOptions,
  Unsubscribe,
} from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const EmailMessage = z.object({
  userId: z.string(),
  template: z.enum(["welcome", "receipt"]),
  metadata: z.object({ tenantId: z.string() }),
});

const emailQueue = defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  ttlSeconds: 86400,
});

const scheduleA: ScheduledDeliveryOptions = { delaySeconds: 60 };
const scheduleB: ScheduledDeliveryOptions = {
  scheduledAt: new Date("2027-01-01T00:00:00.000Z"),
};
// @ts-expect-error delaySeconds and scheduledAt are mutually exclusive
const invalidSchedule: ScheduledDeliveryOptions = {
  delaySeconds: 60,
  scheduledAt: new Date(),
};

export const queuesAcceptanceWorkflow = defineWorkflow({
  name: "queuesAcceptance",
  queues: { email: emailQueue },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.queues.email.enqueue({
      userId: "u-1",
      template: "welcome",
      metadata: { tenantId: "t-1" },
    });

    ctx.queues.email.enqueue(
      {
        userId: "u-2",
        template: "receipt",
        metadata: { tenantId: "t-1" },
      },
      { priority: 10, delaySeconds: 30, ttlSeconds: 3600 },
    );

    // @ts-expect-error enqueue is a buffered synchronous operation
    await ctx.queues.email.enqueue({
      userId: "u-3",
      template: "welcome",
      metadata: { tenantId: "t-1" },
    });

    // @ts-expect-error payload must match queue message schema input
    ctx.queues.email.enqueue({ userId: "u-4", template: "unknown" });

    return { ok: true };
  },
});

const client = createWorkflowClient({ queuesAcceptance: queuesAcceptanceWorkflow });

const unregister = client.registerQueueHandler(
  emailQueue,
  async (handlerCtx, message) => {
    type _HandlerCtx = Assert<
      typeof handlerCtx extends QueueHandlerContext ? true : false
    >;
    type _MessageNoAny = Assert<IsAny<typeof message> extends false ? true : false>;
    type _MessageDecoded = Assert<
      IsEqual<
        typeof message,
        {
          userId: string;
          template: "welcome" | "receipt";
          metadata: { tenantId: string };
        }
      >
    >;

    if (message.template === "receipt") {
      throw new UnrecoverableError("receipt template disabled");
    }
  },
  {
    retryPolicy: {
      timeoutSeconds: 10,
      maxAttempts: 5,
      intervalSeconds: 1,
      backoffRate: 2,
      maxIntervalSeconds: 30,
    },
  },
);

type _Unregister = Assert<IsEqual<typeof unregister, Unsubscribe>>;

async function inspectDeadLetters(): Promise<void> {
  const query: DeadLetterSearchQuery<
    { tenantId: string },
    z.output<typeof EmailMessage>
  > = {
    where: {
      kind: "eq",
      namespace: "payload",
      path: "template",
      value: "receipt",
    },
  };

  const page = await client.queues.email.deadLetters.search(query);
  const message = page.items[0];
  type _DeadLetterRecord = Assert<
    typeof message extends DeadLetteredMessage<z.output<typeof EmailMessage>, any>
      ? true
      : false
  >;

  await client.queues.email.deadLetters.retry(message.id);
  await client.queues.email.deadLetters.purge(message.id);
}

void scheduleA;
void scheduleB;
void invalidSchedule;
void inspectDeadLetters;
