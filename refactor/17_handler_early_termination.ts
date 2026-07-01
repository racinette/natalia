import { z } from "zod";
import {
  AttemptError,
  defineQueue,
  defineRequest,
  defineTopic,
  RequestHandlerDeclaredError,
  UnrecoverableError,
} from "../workflow";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const manualRequest = defineRequest({
  name: "manualRequestAcceptance",
  payload: z.object({ externalId: z.string() }),
  response: z.object({ ok: z.boolean() }),
  errors: {
    AwaitingExternalActor: true,
  },
});

manualRequest.registerHandler(async (payload, ctx) => {
  if (payload.externalId === "wait") {
    throw ctx.errors.AwaitingExternalActor("Waiting for external actor", {
      manual: true,
    });
  }
  return { ok: true };
});

type _DeclaredError = Assert<
  RequestHandlerDeclaredError extends Error ? true : false
>;

manualRequest.registerHandler(async () => {
  // @ts-expect-error request handlers throw ctx.errors instead of UnrecoverableError
  throw new UnrecoverableError("use ctx.errors with manual disposition");
});

const earlyQueue = defineQueue({
  name: "earlyTerminationQueue",
  message: z.object({ id: z.string(), valid: z.boolean() }),
});

earlyQueue.registerHandler(async (message, _opts) => {
  if (!message.valid) {
    throw new UnrecoverableError("invalid message");
  }
  if (message.id === "transient") {
    throw new AttemptError({ type: "TransientQueueError" });
  }
}, { retryPolicy: { maxAttempts: 1 } });

earlyQueue.registerHandler(async () => {
  // @ts-expect-error queue handlers return void
  return { ok: true };
}, { retryPolicy: { maxAttempts: 1 } });

const earlyTopic = defineTopic({
  name: "earlyTerminationTopic",
  record: z.object({ id: z.string(), valid: z.boolean() }),
});

earlyTopic.registerConsumer(
  "consumer",
  async (record, _opts) => {
    if (!record.valid) {
      throw new UnrecoverableError("invalid record");
    }
    if (record.id === "transient") {
      throw new AttemptError({ type: "TransientTopicError" });
    }
  },
  {
    onConsumeError: {
      callback: async (_ctx, event) => {
        if (event.type === "attemptsExhausted") {
          const last = await event.attempts.last();
          type _AttemptRecorded = Assert<IsEqual<typeof last, import("../types").Attempt>>;
          return "skip";
        }
        return "halt";
      },
    },
  },
);

earlyTopic.registerConsumer("badConsumer", async () => {
  // @ts-expect-error topic consumers return void
  return { ok: true };
});
