import { z } from "zod";
import { AttemptError, defineStep } from "../workflow";
import type { Attempt, AttemptAccessor, Failure, JsonInput } from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// `Failure` BASE RECORD
//
// `Failure` is the base captured-throw record. It has no `attempt` field;
// `Attempt extends Failure` adds the 1-indexed attempt number for retried
// operations.
// =============================================================================

const failure: Failure = {
  startedAt: new Date(),
  failedAt: new Date(),
  message: null,
  type: null,
  details: undefined,
};
void failure;

type _FailureDoesNotRequireAttempt = Assert<
  "attempt" extends keyof Failure ? false : true
>;

// =============================================================================
// `Attempt` RECORD
//
// Used by `AttemptAccessor` for steps, queue handlers, request handlers, and
// topic consumers. All fields except `attempt`, `startedAt`, and `failedAt`
// are nullable because JavaScript can throw any value, and an attempt may
// reach the I/O boundary without producing structured error info.
// =============================================================================

const attempt: Attempt = {
  ...failure,
  attempt: 1,
};
void attempt;

type _AttemptExtendsFailure = Assert<Attempt extends Failure ? true : false>;
type _AttemptShape = Assert<
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

// =============================================================================
// `AttemptAccessor`
//
// Lazy, async-iterable accessor over a retried operation's attempt history.
// Same shape across every attempt-bearing context: steps, queue handlers,
// request handlers, topic consumers, and `CompensationInfo.attempts` /
// `RequestCompensationInfo.attempts`.
// =============================================================================

declare const attempts: AttemptAccessor;

async function inspectAttempts(): Promise<void> {
  const last = await attempts.last();
  type _Last = Assert<IsEqual<typeof last, Attempt>>;

  const all = await attempts.all();
  type _All = Assert<IsEqual<typeof all, Attempt[]>>;

  // `count` is an async method, not a property.
  const count = await attempts.count();
  type _Count = Assert<IsEqual<typeof count, number>>;

  for await (const item of attempts) {
    type _Item = Assert<IsEqual<typeof item, Attempt>>;
  }

  for await (const item of attempts.reverse()) {
    type _ReverseItem = Assert<IsEqual<typeof item, Attempt>>;
  }

  // @ts-expect-error count is async-callable, not a number property
  const badCount: number = attempts.count;
  void badCount;
}
void inspectAttempts;

// =============================================================================
// `AttemptError` THROWABLE
//
// Structured error class for handler code (step execute, queue handlers,
// topic consumers, request handlers). Extends `Error`. `details` is typed
// as `JsonInput` at the throw site so non-JSON values are rejected.
// =============================================================================

const structured = new AttemptError({
  type: "ValidationError",
  message: "payload was invalid",
  details: { field: "email", reason: "missing" },
});
type _AttemptErrorIsError = Assert<typeof structured extends Error ? true : false>;

// `details` defaults to `JsonInput | undefined`.
const noDetails = new AttemptError({ type: "RemoteSystemDown" });
type _NoDetailsIsError = Assert<typeof noDetails extends Error ? true : false>;
void noDetails;

// All constructor fields are optional.
const empty = new AttemptError();
void empty;

// @ts-expect-error details must be JSON-serializable (no Set/Map/etc.)
new AttemptError({ details: new Set(["not-json"]) });

// =============================================================================
// USABLE INSIDE A STEP `execute`
//
// The handler-side throwable is just an `Error` subclass — the engine's
// extraction rules (Part 15) persist `type` / `message` / `details` directly
// when `AttemptError` is caught, falling back to best-effort extraction for
// other thrown values.
// =============================================================================

defineStep({
  name: "attemptAccessorStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute(_ctx, args) {
    if (args.id === "bad") {
      throw new AttemptError({
        type: "StepFailed",
        message: "synthetic",
        details: { id: args.id },
      });
    }
    return { ok: true };
  },
});

// =============================================================================
// REMOVED PUBLIC NAME
// =============================================================================

// @ts-expect-error StepErrorAccessor was renamed to AttemptAccessor
import type { StepErrorAccessor as _RemovedStepErrorAccessor } from "../types";
