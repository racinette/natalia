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

// Extract the inner type T from DeterministicAwaitable<T> via phantom field inference.
type AwaitedDeterministic<T> =
  T extends DeterministicAwaitable<infer U> ? U : never;

// DeterministicAwaitable is no longer natively awaitable — Awaited<> does NOT unwrap it.
type _AwaitedDeterministicAwaitable = Awaited<DeterministicAwaitable<"timed_out">>;
type _AwaitedIsNotUnwrapped = Assert<
  IsEqual<_AwaitedDeterministicAwaitable, DeterministicAwaitable<"timed_out">>
>;

// AwaitedDeterministic<> still extracts T correctly via the phantom field.
type _AwaitedDeterministicExtract = AwaitedDeterministic<DeterministicAwaitable<"timed_out">>;
type _AwaitedDeterministicNoAny = Assert<
  IsAny<_AwaitedDeterministicExtract> extends false ? true : false
>;
type _AwaitedDeterministicIsLiteral = Assert<
  IsEqual<_AwaitedDeterministicExtract, "timed_out">
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
 * - `ctx.join()` type inference for all handle shapes
 * - Execution / compensation root enforcement on `ctx.join()`
 * - BranchHandle scope-path enforcement on `ctx.join()`
 * - `scope` entry shapes: single, array, map, direct deterministic awaitables
 * - `select` input shapes: BranchHandle, BranchHandle[], Map, ChannelHandle, ChannelReceiveCall
 * - `map` input shapes and callbacks: single/array/map/ChannelReceiveCall
 * - compensation-context `scope/select/map`
 * - negative check: direct raw Promise in scope entries is rejected
 * - negative check: `then()` no longer exists on DeterministicAwaitable
 */
export const concurrencyTypeMatrixRegressionWorkflow = defineWorkflow({
  name: "concurrencyTypeMatrixRegression",
  args: MatrixArgs,
  channels: { cancel: CancelMessage },
  steps: { bookFlight, cancelFlight },
  result: z.object({ ok: z.boolean() }),

  async execute(ctx, args) {
    // ctx.join() resolves a plain DeterministicAwaitable to its inner type.
    const sleepResult = await ctx.join(ctx.sleep(30));
    type _SleepResultIsVoid = Assert<IsEqual<typeof sleepResult, void>>;

    const stepResult = await ctx.join(
      ctx.steps.bookFlight(args.destination, args.customerId),
    );
    type _StepResultNoAny = Assert<
      IsAny<typeof stepResult> extends false ? true : false
    >;
    type _StepResultHasId = Assert<
      IsEqual<typeof stepResult, { id: string; price: number }>
    >;

    // DeterministicAwaitable no longer has .then() — it is not directly awaitable.
    // @ts-expect-error DeterministicAwaitable has no then() method
    ctx.sleep(30).then(() => "bad");
    // @ts-expect-error StepCall has no then() method
    ctx.steps.bookFlight(args.destination, args.customerId).then(() => "bad");
    // @ts-expect-error ChannelReceiveCall has no then() method
    ctx.channels.cancel.receive(0).then(() => "bad");

    // ctx.join() infers the inner type from ChannelReceiveCall.
    const receiveResult = await ctx.join(ctx.channels.cancel.receive(0));
    type _ReceiveResultNoAny = Assert<
      IsAny<typeof receiveResult> extends false ? true : false
    >;

    // Base context select (channel-only).
    const baseSel = ctx.select({
      cancelStream: ctx.channels.cancel,
      cancelOnce: ctx.channels.cancel.receive(0),
    });
    for await (const data of baseSel) {
      type _BaseSelNoAny = Assert<
        IsAny<typeof data> extends false ? true : false
      >;
      break;
    }

    // Reject eager promise values as scope entries.
    const eager = Promise.resolve("eager");
    // @ts-expect-error raw Promise must not be accepted as scope entry
    await ctx.join(ctx.scope("InvalidRawPromiseEntry", { eager }, async () => {
      return "never";
    }));

    // ctx.join() applied to a scope — types thread through correctly.
    await ctx.join(
      ctx.scope(
        "ScopeEntryTypeRegression",
        {
          timer: async () => {
            await ctx.join(ctx.sleep(5));
            return "timed_out" as const;
          },
          booking: async () => {
            await ctx.join(ctx.steps.bookFlight(args.destination, args.customerId));
            return "booked" as const;
          },
        },
        async (ctx, { timer, booking }) => {
          const timerValue = await ctx.join(timer);
          const bookingValue = await ctx.join(booking);

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
        },
      ),
    );

    // Nested scope: child scope handle is selectable from parent — IsPrefix check.
    await ctx.join(
      ctx.scope(
        "NestedScopeSelectableRegression",
        {
          parentTimer: async () => {
            await ctx.join(ctx.sleep(1));
            return "parent_done" as const;
          },
        },
        async (ctx, { parentTimer }) => {
          const childScope = ctx.scope(
            "ChildScope",
            {
              childTimer: async () => {
                await ctx.join(ctx.sleep(1));
                return "child_done" as const;
              },
            },
            async (ctx, { childTimer }) => {
              return await ctx.join(childTimer);
            },
          );

          // Child can join parent handle (IsPrefix<["NestedScopeSelectableRegression"], ["NestedScopeSelectableRegression", "ChildScope"]> = true).
          // Both parentTimer (path ["NestedScopeSelectableRegression"]) and childScope (BranchHandle on parent's path) are selectable from here.
          const childSel = ctx.select({ parentTimer, childScope });
          for await (const value of childSel) {
            type _ChildScopeSelectNoAny = Assert<
              IsAny<typeof value> extends false ? true : false
            >;
            break;
          }
        },
      ),
    );

    // ==========================================================================
    // SCOPE PATH LIFETIME ENFORCEMENT: sibling handles cannot be joined
    // ==========================================================================

    await ctx.join(
      ctx.scope(
        "ScopeSiblingRejection",
        {},
        async (outerCtx) => {
          const siblingA = outerCtx.scope(
            "SiblingA",
            {
              data: async () => "sibling_a_data" as const,
            },
            async (innerCtxA, { data }) => await innerCtxA.join(data),
          );

          await outerCtx.join(
            outerCtx.scope(
              "SiblingB",
              {},
              async (innerCtxB) => {
                // siblingA has path ["ScopeSiblingRejection"] (parent path).
                // innerCtxB's TScopePath = ["ScopeSiblingRejection", "SiblingB"].
                // IsPrefix<["ScopeSiblingRejection"], ["ScopeSiblingRejection", "SiblingB"]> = true.
                // A child scope CAN join its parent's BranchHandle.
                await innerCtxB.join(siblingA);

                // However, a handle created INSIDE SiblingA (with path
                // ["ScopeSiblingRejection", "SiblingA"]) cannot be joined from SiblingB.
                // That would require the handle to have escaped its scope, which our
                // type system prevents at the point of handle creation (handles only
                // exist as parameters inside their own scope callback).
              },
            ),
          );
        },
      ),
    );

    // ==========================================================================
    // EXECUTION / COMPENSATION ROOT ENFORCEMENT
    // ==========================================================================

    // An execution-context handle cannot be joined from compensation context.
    const executionStepHandle = ctx.steps.bookFlight(
      args.destination,
      args.customerId,
    );
    ctx.addCompensation(async (compCtx) => {
      // @ts-expect-error execution-root handle cannot be joined from CompensationContext
      await compCtx.join(executionStepHandle);
    });

    // A compensation-context handle cannot be joined from execution context.
    ctx.addCompensation(async (compCtx) => {
      const compStepHandle = compCtx.steps.cancelFlight(
        args.destination,
        args.customerId,
      );
      // @ts-expect-error compensation-root handle cannot be joined from WorkflowContext
      await ctx.join(compStepHandle);

      // Correct: join from compensation context.
      const compResult = await compCtx.join(compStepHandle);
      type _CompResultNoAny = Assert<
        IsAny<typeof compResult> extends false ? true : false
      >;
    });


    // ==========================================================================
    // ctx.all() — join all and collect
    // ==========================================================================

    const allResults = await ctx.join(
      ctx.all({
        timer: async () => {
          await ctx.join(ctx.sleep(1));
          return "timed_out" as const;
        },
        providers: [async () => 1, async () => 2],
        quotes: new Map<string, () => Promise<"A" | "B">>([
          ["a", async () => "A" as const],
          ["b", async () => "B" as const],
        ]),
      }),
    );
    type _AllResultNoAny = Assert<
      IsAny<typeof allResults> extends false ? true : false
    >;
    type _AllTimerLiteral = Assert<
      IsEqual<typeof allResults.timer, "timed_out">
    >;
    type _AllProvidersNoAny = Assert<
      IsAny<(typeof allResults.providers)[number]> extends false ? true : false
    >;
    for (const quote of allResults.quotes.values()) {
      type _AllQuotesNoAny = Assert<
        IsAny<typeof quote> extends false ? true : false
      >;
      break;
    }

    // ==========================================================================
    // Full matrix scope: select + map with all handle shapes
    // ==========================================================================

    await ctx.join(
      ctx.scope(
        "MatrixScope",
        {
          single: ctx.steps.bookFlight(args.destination, args.customerId),
          timeout: async () => {
            await ctx.join(ctx.sleep(5));
            return "timed_out" as const;
          },
          providers: [async () => 1, async () => 2],
          quotes: new Map<string, () => Promise<"A" | "B">>([
            ["a", async () => "A" as const],
            ["b", async () => "B" as const],
          ]),
        },
        async (ctx, { single, timeout, providers, quotes }) => {
          const timeoutValue = await ctx.join(timeout);
          type _TimeoutNotAny = Assert<
            IsAny<typeof timeoutValue> extends false ? true : false
          >;
          type _TimeoutLiteral = Assert<
            IsEqual<typeof timeoutValue, "timed_out">
          >;

          const singleData = await ctx.join(single);
          type _SingleDataNotAny = Assert<
            IsAny<typeof singleData> extends false ? true : false
          >;
          type _SingleDataId = Assert<IsEqual<typeof singleData, { id: string; price: number }>>;

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
          const mappedIdentity = await ctx.join(
            ctx.map({
              single,
              providers,
              quotes,
              timeout,
              cancelOnce: ctx.channels.cancel.receive(0),
            }),
          );
          type _MapIdentityNoAny = Assert<
            IsAny<typeof mappedIdentity> extends false ? true : false
          >;
          type _MapTimeoutLiteral = Assert<
            IsEqual<typeof mappedIdentity.timeout, "timed_out">
          >;

          // Scope map: callback mode
          const mapped = await ctx.join(
            ctx.map(
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
            ),
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
      ),
    );

    // ==========================================================================
    // Compensation context matrix
    // ==========================================================================

    ctx.addCompensation(async (compCtx) => {
      await compCtx.join(
        compCtx.scope(
          "CompMatrix",
          {
            timer: async () => {
              await compCtx.join(compCtx.sleep(1));
              return "done" as const;
            },
            cancelAttempt: compCtx.steps.cancelFlight(
              args.destination,
              args.customerId,
            ),
          },
          async (ctx, { timer, cancelAttempt }) => {
            const timerValue = await ctx.join(timer);
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

            const compMapped = await ctx.join(
              ctx.map(
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
              ),
            );
            type _CompMapNoAny = Assert<
              IsAny<typeof compMapped> extends false ? true : false
            >;

            const compAll = await ctx.join(
              ctx.all({
                timer,
                cancelAttempt,
                cancelOnce: ctx.channels.cancel.receive(0),
              }),
            );
            type _CompAllNoAny = Assert<
              IsAny<typeof compAll> extends false ? true : false
            >;
          },
        ),
      );
    });

    return { ok: true };
  },
});
