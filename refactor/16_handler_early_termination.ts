import { z } from "zod";
import {
  AttemptError,
  defineQueue,
  defineRequest,
  defineTopic,
  MANUAL,
  UnrecoverableError,
} from "../workflow";
import type { Attempt, ManualSentinel } from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const manualRequest = defineRequest({
  name: "manualRequestAcceptance",
  payload: z.object({ externalId: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

manualRequest.registerHandler(async (_ctx, payload) => {
  if (payload.externalId === "wait") {
    return MANUAL;
  }
  return { ok: true };
});

type _ManualSentinel = Assert<IsEqual<typeof MANUAL, ManualSentinel>>;

manualRequest.registerHandler(async () => {
  // @ts-expect-error request handlers return MANUAL instead of throwing UnrecoverableError
  throw new UnrecoverableError("use MANUAL for requests");
});

const earlyQueue = defineQueue({
  name: "earlyTerminationQueue",
  message: z.object({ id: z.string(), valid: z.boolean() }),
});

earlyQueue.registerHandler(async (_ctx, message) => {
  if (!message.valid) {
    throw new UnrecoverableError("invalid message");
  }
  if (message.id === "transient") {
    throw new AttemptError({ type: "TransientQueueError" });
  }
});

earlyQueue.registerHandler(async () => {
  // @ts-expect-error queues do not use MANUAL
  return MANUAL;
});

const earlyTopic = defineTopic({
  name: "earlyTerminationTopic",
  record: z.object({ id: z.string(), valid: z.boolean() }),
});

earlyTopic.registerConsumer(
  "consumer",
  async (_ctx, record) => {
    if (!record.payload.valid) {
      throw new UnrecoverableError("invalid record");
    }
    if (record.payload.id === "transient") {
      throw new AttemptError({ type: "TransientTopicError" });
    }
  },
  {
    onConsumeError: {
      callback: async (_ctx, event) => {
        if (event.type === "attemptsExhausted") {
          const last = await event.attempts.last();
          type _AttemptRecorded = Assert<
            IsEqual<typeof last, Attempt>
          >;
          return "skip";
        }
        return "halt";
      },
    },
  },
);

earlyTopic.registerConsumer("badConsumer", async () => {
  // @ts-expect-error topics do not use MANUAL
  return MANUAL;
});
