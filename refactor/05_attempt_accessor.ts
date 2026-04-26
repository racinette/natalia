import { z } from "zod";
import {
  AttemptError,
  defineQueue,
  defineRequest,
  defineStep,
  defineTopic,
} from "../workflow";
import type { Attempt, AttemptAccessor, Failure, JsonInput } from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const failure: Failure = {
  startedAt: new Date(),
  failedAt: new Date(),
  message: null,
  type: null,
  details: undefined,
};

const attempt: Attempt = {
  ...failure,
  attempt: 1,
};

type _AttemptExtendsFailure = Assert<Attempt extends Failure ? true : false>;
type _FailureDoesNotRequireAttempt = Assert<
  "attempt" extends keyof Failure ? false : true
>;
type _AttemptFields = Assert<
  IsEqual<
    Pick<Attempt, "attempt" | "message" | "type" | "details">,
    {
      readonly attempt: number;
      readonly message: string | null;
      readonly type: string | null;
      readonly details: JsonInput | undefined;
    }
  >
>;

declare const attempts: AttemptAccessor;

async function inspectAttempts(): Promise<void> {
  const last = await attempts.last();
  type _LastAttempt = Assert<IsEqual<typeof last, Attempt>>;

  const all = await attempts.all();
  type _AllAttempts = Assert<IsEqual<typeof all, Attempt[]>>;

  const count = await attempts.count();
  type _Count = Assert<IsEqual<typeof count, number>>;

  for await (const item of attempts) {
    type _IteratorItem = Assert<IsEqual<typeof item, Attempt>>;
  }

  for await (const item of attempts.reverse()) {
    type _ReverseItem = Assert<IsEqual<typeof item, Attempt>>;
  }

  // @ts-expect-error count is async and callable, not a number property
  const badCount: number = attempts.count;
}

void inspectAttempts;

const structured = new AttemptError({
  type: "ValidationError",
  message: "payload was invalid",
  details: { field: "email", reason: "missing" },
});
type _AttemptErrorIsThrowable = Assert<typeof structured extends Error ? true : false>;

// @ts-expect-error details must be JSON-serializable
new AttemptError({ details: new Set(["not-json"]) });

defineStep({
  name: "attemptAccessorStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    throw new AttemptError({ type: "StepFailed", message: "step failed" });
  },
});

defineQueue({
  name: "attemptAccessorQueue",
  message: z.object({ id: z.string() }),
}).registerHandler(async (_ctx, message) => {
  if (message.id === "bad") {
    throw new AttemptError({ type: "BadMessage", details: message });
  }
});

defineRequest({
  name: "attemptAccessorRequest",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
}).registerHandler(async () => {
  throw new AttemptError({ type: "RemoteSystemDown" });
});

defineTopic({
  name: "attemptAccessorTopic",
  record: z.object({ id: z.string() }),
}).registerConsumer("attempts", async () => {
  throw new AttemptError({ type: "CannotConsume" });
});

// Removed public name.
// @ts-expect-error StepErrorAccessor was replaced by AttemptAccessor
type _NoStepErrorAccessor = import("../types").StepErrorAccessor;

void attempt;
