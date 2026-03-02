import { z } from "zod";
import { defineWorkflow } from "../workflow";
import type { DeterministicAwaitable } from "../types";
import { bookFlight, cancelFlight } from "../examples/shared";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type AwaitedDeterministic<T> =
  T extends DeterministicAwaitable<infer U> ? U : never;

type _AwaitedDeterministicAwaitable = Awaited<
  DeterministicAwaitable<"timed_out">
>;
type _AwaitedNoAny = Assert<
  IsAny<_AwaitedDeterministicAwaitable> extends false ? true : false
>;
type _AwaitedIsLiteral = Assert<
  IsEqual<_AwaitedDeterministicAwaitable, "timed_out">
>;

const MatrixArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
});

const CancelMessage = z.object({
  type: z.literal("cancel"),
  reason: z.string(),
});

/**
 * Regression matrix for deterministic concurrency typing.
 *
 * Covers:
 * - `scope` entry shapes: single, array, map, direct deterministic awaitables
 * - `select` input shapes: BranchHandle, BranchHandle[], Map, ChannelHandle, ChannelReceiveCall
 * - `map` input shapes and callbacks: single/array/map/ChannelReceiveCall
 * - compensation-context `scope/select/map`
 * - negative check: direct raw Promise in scope entries is rejected
 */
export const concurrencyTypeMatrixRegressionWorkflow = defineWorkflow({
  name: "concurrencyTypeMatrixRegression",
  args: MatrixArgs,
  channels: { cancel: CancelMessage },
  steps: { bookFlight, cancelFlight },
  result: z.object({ ok: z.boolean() }),

  async execute(ctx, args) {
    // Deterministic awaitable chaining basics
    const sleepThen = ctx.sleep(30).then(() => "a");
    type SleepThenType = AwaitedDeterministic<typeof sleepThen>;
    type _SleepThenNoAny = Assert<
      IsAny<SleepThenType> extends false ? true : false
    >;
    type _SleepThenIsString = Assert<IsEqual<SleepThenType, string>>;
    ctx.sleep(30).then(
      () => "ok",
      // @ts-expect-error deterministic awaitables do not expose rejection continuations
      () => "bad",
    );

    ctx.sleep(1).then((value) => {
      type _SleepValueIsVoid = Assert<IsEqual<typeof value, void>>;
      return 123;
    });

    const stepThen = ctx.steps
      .bookFlight(args.destination, args.customerId)
      .then((flight) => flight.id);
    type StepThenType = AwaitedDeterministic<typeof stepThen>;
    type _StepThenNoAny = Assert<
      IsAny<StepThenType> extends false ? true : false
    >;
    type _StepThenIsString = Assert<IsEqual<StepThenType, string>>;
    ctx.steps.bookFlight(args.destination, args.customerId).then(
      () => "ok",
      // @ts-expect-error deterministic step-call thenable does not accept onrejected
      () => "bad",
    );

    const stepChained = ctx.steps
      .bookFlight(args.destination, args.customerId)
      .then(() => "a")
      .then((x) => x.toUpperCase());
    type StepChainedType = AwaitedDeterministic<typeof stepChained>;
    type _StepChainedNoAny = Assert<
      IsAny<StepChainedType> extends false ? true : false
    >;
    type _StepChainedIsString = Assert<IsEqual<StepChainedType, string>>;

    // Base context select (channel-only)
    const baseSel = ctx.select({
      cancelStream: ctx.channels.cancel,
      cancelOnce: ctx.channels.cancel.receive(0),
    });
    ctx.channels.cancel.receive(0).then(
      () => "ok",
      // @ts-expect-error deterministic awaitables do not support onrejected callbacks
      () => "bad",
    );
    for await (const data of baseSel) {
      type _BaseSelNoAny = Assert<
        IsAny<typeof data> extends false ? true : false
      >;
      break;
    }

    // Reject eager promise values as scope entries.
    const eager = Promise.resolve("eager");
    // @ts-expect-error raw Promise must not be accepted as scope entry
    await ctx.scope("InvalidRawPromiseEntry", { eager }, async () => {
      return "never";
    });

    await ctx.scope(
      "ScopeEntryTypeRegression",
      {
        timer: ctx.sleep(5).then(() => "timed_out" as const),
        booking: ctx.steps
          .bookFlight(args.destination, args.customerId)
          .then(() => "booked" as const),
      },
      async (ctx, { timer, booking }) => {
        const timerValue = await timer;
        const bookingValue = await booking;

        type _TimerNotAny = Assert<
          IsAny<typeof timerValue> extends false ? true : false
        >;
        type _BookingNotAny = Assert<
          IsAny<typeof bookingValue> extends false ? true : false
        >;
        type _TimerLiteral = Assert<IsEqual<typeof timerValue, "timed_out">>;
        type _BookingLiteral = Assert<IsEqual<typeof bookingValue, "booked">>;

        const sel = ctx.select({ timer, booking });
        for await (const value of sel.match({
          timer: () => "timed_out" as const,
          booking: () => "booked" as const,
        })) {
          type _MatchNotAny = Assert<
            IsAny<typeof value> extends false ? true : false
          >;
          break;
        }

        const timerThen = timer.then((n) => n.length);
        type TimerThenType = AwaitedDeterministic<typeof timerThen>;
        type _TimerThenNoAny = Assert<
          IsAny<TimerThenType> extends false ? true : false
        >;
        type _TimerThenIsNumber = Assert<IsEqual<TimerThenType, number>>;
      },
    );

    await ctx.scope(
      "MatrixScope",
      {
        single: ctx.steps.bookFlight(args.destination, args.customerId),
        timeout: ctx.sleep(5).then(() => "timed_out" as const),
        providers: [async () => 1, async () => 2],
        quotes: new Map<
          string,
          (() => Promise<"A">) | DeterministicAwaitable<"B">
        >([
          ["a", async () => "A" as const],
          ["b", ctx.sleep(1).then(() => "B" as const)],
        ]),
      },
      async (ctx, { single, timeout, providers, quotes }) => {
        const timeoutValue = await timeout;
        type _TimeoutNotAny = Assert<
          IsAny<typeof timeoutValue> extends false ? true : false
        >;
        type _TimeoutLiteral = Assert<
          IsEqual<typeof timeoutValue, "timed_out">
        >;

        const singleId = await single.then((v) => v.id);
        type _SingleIdNotAny = Assert<
          IsAny<typeof singleId> extends false ? true : false
        >;
        type _SingleIdString = Assert<IsEqual<typeof singleId, string>>;

        // Scope select: all handle shapes
        const sel = ctx.select({
          single,
          providers,
          quotes,
          timeout,
          cancelOnce: ctx.channels.cancel.receive(0),
          cancelStream: ctx.channels.cancel,
        });

        for await (const value of sel.match(
          {
            single: {
              complete: (data) => data.id,
              failure: () => "single_failed" as const,
            },
            providers: {
              complete: ({ data, innerKey }) => `${innerKey}:${data}`,
              failure: () => "provider_failed",
            },
            quotes: {
              complete: ({
                data,
                innerKey,
              }: {
                data: "A" | "B";
                innerKey: string;
              }) => `${innerKey}:${data}`,
              failure: () => "quote_failed",
            },
            timeout: (v) => v,
            cancelOnce: (msg) => (msg ? msg.reason : "none"),
            cancelStream: (msg) => msg.reason,
          },
          () => "default_failed" as const,
        )) {
          type _SelectMatchNoAny = Assert<
            IsAny<typeof value> extends false ? true : false
          >;
          break;
        }

        // Scope map: identity mode
        const mappedIdentity = await ctx.map({
          single,
          providers,
          quotes,
          timeout,
          cancelOnce: ctx.channels.cancel.receive(0),
        });
        type _MapIdentityNoAny = Assert<
          IsAny<typeof mappedIdentity> extends false ? true : false
        >;
        type _MapTimeoutLiteral = Assert<
          IsEqual<typeof mappedIdentity.timeout, "timed_out">
        >;

        // Scope map: callback mode
        const mapped = await ctx.map(
          {
            providers,
            quotes,
            timeout,
            cancelOnce: ctx.channels.cancel.receive(0),
          },
          {
            providers: (n, i) => `${i}:${n}`,
            quotes: (q: "A" | "B", key: string) => `${key}:${q}`,
            timeout: (v) => v,
            cancelOnce: (msg) => (msg ? msg.reason : "none"),
          },
          () => "default_failed" as const,
        );
        type _MapNoAny = Assert<
          IsAny<typeof mapped> extends false ? true : false
        >;
        type _MapProvidersNoAny = Assert<
          IsAny<(typeof mapped.providers)[number]> extends false ? true : false
        >;
        type _MapProvidersPerItemFallback = Assert<
          IsEqual<(typeof mapped.providers)[number], string | "default_failed">
        >;
        type _MapQuotesNoWholeFallback = Assert<
          IsEqual<Extract<typeof mapped.quotes, "default_failed">, never>
        >;
        for (const quoteValue of mapped.quotes.values()) {
          type _MapQuotesNoAny = Assert<
            IsAny<typeof quoteValue> extends false ? true : false
          >;
          break;
        }
        type _MapTimeoutUnion = Assert<
          IsEqual<typeof mapped.timeout, "timed_out" | "default_failed">
        >;
        type _MapChannelReceiveNoFailureFallback = Assert<
          IsEqual<typeof mapped.cancelOnce, string>
        >;
      },
    );

    // Compensation context matrix
    ctx.addCompensation(async (compCtx) => {
      await compCtx.scope(
        "CompMatrix",
        {
          timer: compCtx.sleep(1).then(() => "done" as const),
          cancelAttempt: compCtx.steps.cancelFlight(
            args.destination,
            args.customerId,
          ),
        },
        async (ctx, { timer, cancelAttempt }) => {
          const timerValue = await timer;
          type _CompTimerNotAny = Assert<
            IsAny<typeof timerValue> extends false ? true : false
          >;
          type _CompTimerLiteral = Assert<IsEqual<typeof timerValue, "done">>;

          const compSel = ctx.select({
            timer,
            cancelAttempt,
            cancelOnce: ctx.channels.cancel.receive(0),
          });

          for await (const value of compSel.match({
            timer: (v) => v,
            cancelAttempt: (r) => r.status,
            cancelOnce: (msg) => (msg ? msg.reason : "none"),
          })) {
            type _CompSelectNoAny = Assert<
              IsAny<typeof value> extends false ? true : false
            >;
            break;
          }

          const compMapped = await ctx.map(
            {
              timer,
              cancelAttempt,
              cancelOnce: ctx.channels.cancel.receive(0),
            },
            {
              timer: (v) => v,
              cancelAttempt: (r) => r.status,
              cancelOnce: (msg) => (msg ? msg.reason : "none"),
            },
          );
          type _CompMapNoAny = Assert<
            IsAny<typeof compMapped> extends false ? true : false
          >;
        },
      );
    });

    return { ok: true };
  },
});
