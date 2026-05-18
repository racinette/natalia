import { z } from "zod";
import { createWorkflowClient } from "../client";
import { eq } from "../search";
import {
  DEAD_LETTER,
  defineQueue,
  defineWorkflow,
  MANUAL,
  UnrecoverableError,
} from "../workflow";
import type {
  DeadLetterHandleExternal,
  DeadLetterNamespaceExternal,
  DeadLetterSentinel,
  FindManyResult,
  FindUniqueResult,
  HandleWithRow,
  QueueHandlerContext,
  QueueHandlerResult,
  QueueNamespaceExternal,
  ScheduledDeliveryOptions,
  Unsubscribe,
} from "../types";
import type { DeadLetterId, DeadLetterRow } from "../types/schema";
import type { Assert, IsEqual } from "./type-assertions";

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

type _QueueNameLiteral = Assert<IsEqual<typeof emailQueue.name, "emailQueue">>;

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

    const _enqueueVoid = ctx.queues.email.enqueue({
      userId: "u-3",
      template: "welcome",
      metadata: { tenantId: "t-1" },
    });
    type _EnqueueReturnsVoid = Assert<IsEqual<typeof _enqueueVoid, void>>;

    // @ts-expect-error payload must match queue message schema input
    ctx.queues.email.enqueue({ userId: "u-4", template: "unknown" });

    ctx.queues.email.enqueue(
      {
        userId: "u-5",
        template: "welcome",
        metadata: { tenantId: "t-1" },
      },
      // @ts-expect-error workflow enqueue does not accept txOrConn
      { txOrConn: undefined },
    );

    return { ok: true };
  },
});

const client = createWorkflowClient({ queuesAcceptance: queuesAcceptanceWorkflow });

type _QueueNamespace = Assert<
  IsEqual<
    typeof client.queues.emailQueue,
    QueueNamespaceExternal<
      "emailQueue",
      {
        userId: string;
        template: "welcome" | "receipt";
        metadata: { tenantId: string };
      }
    >
  >
>;

// Workflow-local queue aliases do not become client namespaces.
// @ts-expect-error workflow-local queue slot names are not client keys
void client.queues.email;

const unregister = client.queues.emailQueue.registerHandler(
  async (message, _handlerOpts) => {
    type _HandlerOpts = Assert<
      typeof _handlerOpts extends QueueHandlerContext ? true : false
    >;
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
      return DEAD_LETTER;
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
    maxConcurrent: 5,
  },
);

type _DeadLetterSentinel = Assert<IsEqual<typeof DEAD_LETTER, DeadLetterSentinel>>;
type _QueueHandlerResult = Assert<
  IsEqual<QueueHandlerResult, void | DeadLetterSentinel>
>;

// @ts-expect-error queue handlers do not use MANUAL
client.queues.emailQueue.registerHandler(async () => MANUAL);

// @ts-expect-error queue handlers return void or DEAD_LETTER only
client.queues.emailQueue.registerHandler(async () => new UnrecoverableError("use DEAD_LETTER for queues"));

client.queues.emailQueue.registerHandler(
  async () => undefined,
  // @ts-expect-error handler registration does not accept txOrConn
  { txOrConn: undefined },
);

type _Unregister = Assert<IsEqual<typeof unregister, Unsubscribe>>;

// @ts-expect-error queue handlers do not use MANUAL
emailQueue.registerHandler(async () => MANUAL);

async function inspectDeadLetters(): Promise<void> {
  const deadLetterMany = client.queues.emailQueue.deadLetters.findMany(
    ({ payload }) => eq(payload.template, "receipt"),
    {
      fields: { id: true, payload: true },
      limit: 1,
      txOrConn: undefined,
    },
  );

  type _DeadLetterMany = Assert<
    IsEqual<
      typeof deadLetterMany,
      FindManyResult<
        HandleWithRow<
          DeadLetterHandleExternal<
            "emailQueue",
            {
              userId: string;
              template: "welcome" | "receipt";
              metadata: { tenantId: string };
            }
          >,
          Pick<
            DeadLetterRow<
              "emailQueue",
              {
                userId: string;
                template: "welcome" | "receipt";
                metadata: { tenantId: string };
              }
            >,
            "id" | "payload"
          >
        >
      >
    >
  >;

  const deadLetters = await deadLetterMany;
  const deadLetter = deadLetters[0];
  if (!deadLetter) {
    return;
  }

  await deadLetter.retry({ txOrConn: undefined });
  await deadLetter.purge({ txOrConn: undefined });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- regression-only cast to branded `DeadLetterId`
  const deadLetterId = "dead-letter-id" as DeadLetterId<"emailQueue">;
  const deadLetterHandle = client.queues.emailQueue.deadLetters.get(deadLetterId);
  type _DeadLetterHandle = Assert<
    IsEqual<
      typeof deadLetterHandle,
      DeadLetterHandleExternal<
        "emailQueue",
        {
          userId: string;
          template: "welcome" | "receipt";
          metadata: { tenantId: string };
        }
      >
    >
  >;

  const fetched = await deadLetterHandle.fetchRow({ payload: true, reason: true });
  type _Fetched = Assert<
    IsEqual<
      typeof fetched,
      FindUniqueResult<
        Pick<
          DeadLetterRow<
            "emailQueue",
            {
              userId: string;
              template: "welcome" | "receipt";
              metadata: { tenantId: string };
            }
          >,
          "payload" | "reason"
        >
      >
    >
  >;
  void fetched;

  const count = await client.queues.emailQueue.deadLetters.count(
    ({ reason }) => eq(reason, "max_attempts"),
    { txOrConn: undefined },
  );
  type _Count = Assert<IsEqual<typeof count, number>>;
  void count;

  const found = await client.queues.emailQueue.deadLetters.findUnique(
    ({ payload }) => eq(payload.userId, "u-1"),
    { txOrConn: undefined },
  );
  type _Found = Assert<
    IsEqual<
      typeof found,
      FindUniqueResult<
        DeadLetterHandleExternal<
          "emailQueue",
          {
            userId: string;
            template: "welcome" | "receipt";
            metadata: { tenantId: string };
          }
        >
      >
    >
  >;
  void found;

  // @ts-expect-error dead-letter ids are branded by queue definition name
  client.queues.emailQueue.deadLetters.get("plain-id");
  // @ts-expect-error get is synchronous and does not accept txOrConn
  client.queues.emailQueue.deadLetters.get(deadLetterId, { txOrConn: undefined });
  client.queues.emailQueue.deadLetters.findMany(
    // @ts-expect-error predicates are typed to the dead-letter payload shape
    ({ payload }) => eq(payload.unknownField, "x"),
  );
}

type _DeadLetterNamespace = Assert<
  IsEqual<
    typeof client.queues.emailQueue.deadLetters,
    DeadLetterNamespaceExternal<
      "emailQueue",
      {
        userId: string;
        template: "welcome" | "receipt";
        metadata: { tenantId: string };
      }
    >
  >
>;

void scheduleA;
void scheduleB;
void invalidSchedule;
void unregister;
void inspectDeadLetters;
