import { z } from "zod";
import { defineWorkflow } from "../workflow";
import type {
  DeterministicAwaitable,
  FirstResult,
  Listener,
  ListenerEvent,
  SelectDataKeyedUnion,
  WorkflowContext,
  CompensationContext,
  WorkflowConcurrencyContext,
  CompensationConcurrencyContext,
  ScopeDivider,
  BranchDivider,
  AppendScopeName,
  AppendBranchKey,
} from "../types";
import { bookFlight, cancelFlight, campaignWorker } from "../examples/shared";

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
type _AwaitedDeterministicAwaitable = Awaited<
  DeterministicAwaitable<"timed_out">
>;
type _AwaitedIsNotUnwrapped = Assert<
  IsEqual<_AwaitedDeterministicAwaitable, DeterministicAwaitable<"timed_out">>
>;

// AwaitedDeterministic<> still extracts T correctly via the phantom field.
type _AwaitedDeterministicExtract = AwaitedDeterministic<
  DeterministicAwaitable<"timed_out">
>;
type _AwaitedDeterministicNoAny = Assert<
  IsAny<_AwaitedDeterministicExtract> extends false ? true : false
>;
type _AwaitedDeterministicIsLiteral = Assert<
  IsEqual<_AwaitedDeterministicExtract, "timed_out">
>;

// =============================================================================
// ScopePath symbol types
// =============================================================================

// AppendScopeName inserts a ScopeDivider before the name.
type _AppendedScope = AppendScopeName<[], "MyScope">;
type _AppendedScopeShape = Assert<
  IsEqual<_AppendedScope, [ScopeDivider, "MyScope"]>
>;

// AppendBranchKey inserts a BranchDivider before the key.
type _AppendedBranch = AppendBranchKey<[ScopeDivider, "MyScope"], "myKey">;
type _AppendedBranchShape = Assert<
  IsEqual<_AppendedBranch, [ScopeDivider, "MyScope", BranchDivider, "myKey"]>
>;

// =============================================================================
// FirstResult type
// =============================================================================

type _SampleEntries = {
  timer: () => Promise<"timed_out">;
  booking: () => Promise<{ id: string }>;
};
type _SampleFirstResult = FirstResult<_SampleEntries>;
type _FirstResultIsDiscriminated = Assert<
  IsEqual<
    _SampleFirstResult,
    | { key: "timer"; result: "timed_out" }
    | { key: "booking"; result: { id: string } }
  >
>;

// =============================================================================
// Listener type
// =============================================================================

const MatrixArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
});

const CancelMessage = z.object({
  type: z.literal("cancel"),
  reason: z.string(),
});

/**
 * Regression matrix for the new concurrency API.
 *
 * Validates:
 * - ctx.execute() for steps, child workflows, scope(), all(), first()
 * - ctx.join() is only available on concurrency contexts, not base contexts
 * - ctx.join() accepts BranchHandle, rejects StepCall
 * - scope entries' branchCtx is typed as path-specialized WorkflowContext
 * - scope() on concurrency context returns DeterministicAwaitable (not BranchHandle)
 * - ctx.listen() available on all contexts; yields { key, message }
 * - ctx.select() only on concurrency contexts
 * - ctx.match(sel) returns AsyncIterable<SelectDataKeyedUnion<M>>
 * - ctx.match(sel, onFailure) overload works
 * - ctx.first() return type is discriminated { key, result } union
 * - CompensationConcurrencyContext naming (no WorkflowCompensationConcurrencyContext)
 * - execution-root handles cannot be executed from CompensationContext
 */
export const concurrencyTypeMatrixRegressionWorkflow = defineWorkflow({
  name: "concurrencyTypeMatrixRegression",
  args: MatrixArgs,
  channels: { cancel: CancelMessage },
  streams: { log: z.object({ msg: z.string() }) },
  steps: { bookFlight, cancelFlight },
  childWorkflows: { campaign: campaignWorker },
  result: z.object({ ok: z.boolean() }),

  async execute(ctx, args) {
    // WorkflowAwaitable (sleep, sleepUntil) is directly awaitable — no ctx.execute() needed.
    const sleepResult = await ctx.sleep(30);
    type _SleepResultIsVoid = Assert<IsEqual<typeof sleepResult, void>>;

    // ctx.execute() resolves a DeterministicAwaitable (step call) to its inner type.
    const stepResult = await ctx.execute(
      ctx.steps.bookFlight(args.destination, args.customerId),
    );
    type _StepResultNoAny = Assert<
      IsAny<typeof stepResult> extends false ? true : false
    >;
    type _StepResultHasId = Assert<
      IsEqual<typeof stepResult, { id: string; price: number }>
    >;

    // Tier-1 (DeterministicAwaitable): no .then() — execute-only.
    // @ts-expect-error StepCall has no then() method
    ctx.steps.bookFlight(args.destination, args.customerId).then(() => "bad");

    // Tier-2/3: .then() IS available on WorkflowAwaitable and DirectAwaitable.
    ctx.sleep(30).then(() => "ok");
    ctx.channels.cancel.receive().then(() => "ok");
    ctx.channels.cancel.receiveNowait().then(() => "ok");
    ctx.streams.log.write({ msg: "test" }).then(() => "ok");

    // Base context has NO .join() — only .execute()
    // @ts-expect-error .join() is not available on base WorkflowContext
    await ctx.join(ctx.steps.bookFlight(args.destination, args.customerId));

    // ctx.execute() with child workflow
    const campaignHandle = await ctx.childWorkflows.campaign.startDetached({
      idempotencyKey: "test-campaign",
      args: { userId: "user-1" },
    });
    type _DetachedHandleNoAny = Assert<
      IsAny<typeof campaignHandle> extends false ? true : false
    >;
    await campaignHandle.channels.nudge.send({ type: "nudge" });

    // receiveNowait() returns DirectAwaitable — directly awaitable, non-blocking.
    const nowaitResult = await ctx.channels.cancel.receiveNowait();
    type _NowaitResultNoAny = Assert<
      IsAny<typeof nowaitResult> extends false ? true : false
    >;

    // Blocking receive is directly awaitable (WorkflowAwaitable).
    const receiveResult = await ctx.channels.cancel.receive();
    type _ReceiveResultNoAny = Assert<
      IsAny<typeof receiveResult> extends false ? true : false
    >;

    // Base context listen (channel-only) — replaces old base context select.
    const baseListener = ctx.listen({
      cancelStream: ctx.channels.cancel,
      cancelOnce: ctx.channels.cancel.receive(0),
    });
    type _BaseListenerIsListener = Assert<
      typeof baseListener extends Listener<any> ? true : false
    >;
    for await (const { key, message } of baseListener) {
      type _BaseListenKeyNoAny = Assert<
        IsAny<typeof key> extends false ? true : false
      >;
      type _BaseListenMessageNoAny = Assert<
        IsAny<typeof message> extends false ? true : false
      >;
      break;
    }

    // Base context does NOT have select()
    // @ts-expect-error ctx.select is not available on base WorkflowContext
    ctx.select({ cancel: ctx.channels.cancel });

    // ctx.all() with closure entries
    const allResults = await ctx.execute(
      ctx.all({
        timer: async (_branchCtx) => {
          await ctx.sleep(1);
          return "timed_out" as const;
        },
        booking: async (branchCtx) => {
          return branchCtx.execute(
            branchCtx.steps.bookFlight(args.destination, args.customerId),
          );
        },
      }),
    );
    type _AllResultNoAny = Assert<
      IsAny<typeof allResults> extends false ? true : false
    >;
    type _AllTimerLiteral = Assert<
      IsEqual<typeof allResults.timer, "timed_out">
    >;
    type _AllBookingId = Assert<
      IsEqual<typeof allResults.booking, { id: string; price: number }>
    >;

    // ctx.first() return type is discriminated { key, result } union
    const firstResult = await ctx.execute(
      ctx.first({
        timer: async (_branchCtx) => {
          await ctx.sleep(1);
          return "timed_out" as const;
        },
        booking: async (branchCtx) => {
          return branchCtx.execute(
            branchCtx.steps.bookFlight(args.destination, args.customerId),
          );
        },
      }),
    );
    type _FirstResultNoAny = Assert<
      IsAny<typeof firstResult> extends false ? true : false
    >;
    type _FirstResultIsDiscriminatedUnion = Assert<
      IsEqual<
        typeof firstResult,
        | { key: "timer"; result: "timed_out" }
        | { key: "booking"; result: { id: string; price: number } }
      >
    >;

    // ==========================================================================
    // scope() on base WorkflowContext: branch closure receives path-specialized
    // WorkflowContext with AppendBranchKey path
    // ==========================================================================

    await ctx.execute(
      ctx.scope(
        "BranchCtxTypingRegression",
        {
          timer: async (branchCtx) => {
            // branchCtx is WorkflowContext with path-specialized scope path
            type _BranchCtxIsWorkflowContext = Assert<
              typeof branchCtx extends WorkflowContext<any, any, any, any, any, any, any, any, any, any>
                ? true
                : false
            >;
            // branchCtx has execute() but NOT join()
            type _HasExecute = Assert<"execute" extends keyof typeof branchCtx ? true : false>;
            // @ts-expect-error join is not available on branch WorkflowContext
            branchCtx.join;
            await branchCtx.sleep(5);
            return "timed_out" as const;
          },
          booking: async (branchCtx) =>
            branchCtx.execute(
              branchCtx.steps.bookFlight(args.destination, args.customerId),
            ),
        },
        async (ctx, { timer, booking }) => {
          // scope() on concurrency context returns DeterministicAwaitable (not BranchHandle)
          const innerScope = ctx.scope(
            "InnerScope",
            {
              inner: async (_branchCtx) => "inner_done" as const,
            },
            async (innerCtx, { inner }) => await innerCtx.join(inner),
          );
          type _InnerScopeIsDeterministicAwaitable = Assert<
            typeof innerScope extends DeterministicAwaitable<any, any> ? true : false
          >;

          // ctx.join() works for BranchHandles
          const timerValue = await ctx.join(timer);
          type _TimerNotAny = Assert<
            IsAny<typeof timerValue> extends false ? true : false
          >;
          type _TimerLiteral = Assert<IsEqual<typeof timerValue, "timed_out">>;

          // ctx.execute() also works for lazy handles (steps, etc.)
          const bookingResult = await ctx.execute(
            ctx.steps.bookFlight(args.destination, args.customerId),
          );
          type _BookingNotAny = Assert<
            IsAny<typeof bookingResult> extends false ? true : false
          >;

          // ctx.select() is available on concurrency context
          const sel = ctx.select({ timer, booking });

          // ctx.match(sel) — no handler, yields { key, result } keyed union
          for await (const event of ctx.match(sel)) {
            type _EventKeyedUnion = Assert<
              IsEqual<
                typeof event,
                SelectDataKeyedUnion<{
                  timer: typeof timer;
                  booking: typeof booking;
                }>
              >
            >;
            type _EventNoAny = Assert<IsAny<typeof event> extends false ? true : false>;
            break;
          }

          // ctx.match(sel, onFailure) — no handlers, just default failure callback
          for await (const val of ctx.match(
            ctx.select({ timer, booking }),
            () => "default_failed" as const,
          )) {
            type _ValNoAny = Assert<IsAny<typeof val> extends false ? true : false>;
            break;
          }

          // ctx.match(sel, handlers) — per-key handlers
          for await (const val of ctx.match(
            ctx.select({ timer, booking }),
            {
              timer: () => "timed_out" as const,
              booking: () => "booked" as const,
            },
          )) {
            type _MatchNotAny = Assert<IsAny<typeof val> extends false ? true : false>;
            break;
          }

          // ctx.match(sel, handlers, onFailure) — per-key handlers + default failure
          for await (const val of ctx.match(
            ctx.select({ timer, booking }),
            {
              timer: () => "timed_out" as const,
            },
            () => "default_failed" as const,
          )) {
            type _MatchHandlersFailureNoAny = Assert<
              IsAny<typeof val> extends false ? true : false
            >;
            break;
          }

          // ctx.listen() also available on concurrency context
          const concurrencyListener = ctx.listen({
            cancel: ctx.channels.cancel,
          });
          for await (const { key, message } of concurrencyListener) {
            type _ListenerEventKeyNoAny = Assert<
              IsAny<typeof key> extends false ? true : false
            >;
            type _ListenerMessageIsCancel = Assert<
              IsEqual<typeof message, { type: "cancel"; reason: string }>
            >;
            break;
          }
        },
      ),
    );

    // ==========================================================================
    // ctx.join() is NOT available on base WorkflowContext (only on concurrency ctx)
    // ==========================================================================

    // ctx.join() should be unavailable on base context
    // (already tested above with @ts-expect-error)

    // ==========================================================================
    // EXECUTION / COMPENSATION ROOT ENFORCEMENT
    // ==========================================================================

    const executionStepHandle = ctx.steps.bookFlight(
      args.destination,
      args.customerId,
    );
    ctx.addCompensation(async (compCtx) => {
      // @ts-expect-error execution-root handle cannot be executed from CompensationContext
      await compCtx.execute(executionStepHandle);

      // Base CompensationContext has execute() but NOT join()
      // @ts-expect-error join is not available on base CompensationContext
      compCtx.join;

      const compStepHandle = compCtx.steps.cancelFlight(
        args.destination,
        args.customerId,
      );
      // @ts-expect-error compensation-root handle cannot be executed from WorkflowContext
      await ctx.execute(compStepHandle);

      // Correct: execute from compensation context.
      const compResult = await compCtx.execute(compStepHandle);
      type _CompResultNoAny = Assert<
        IsAny<typeof compResult> extends false ? true : false
      >;

      // CompensationContext also has listen()
      const compListener = compCtx.listen({
        cancel: compCtx.channels.cancel,
      });
      for await (const { key, message } of compListener) {
        type _CompListenKeyNoAny = Assert<
          IsAny<typeof key> extends false ? true : false
        >;
        break;
      }

      // CompensationContext also has all() and first()
      await compCtx.execute(
        compCtx.all({
          step1: async (branchCtx) =>
            branchCtx.execute(branchCtx.steps.cancelFlight(args.destination, args.customerId)),
        }),
      );

      const firstComp = await compCtx.execute(
        compCtx.first({
          step1: async (branchCtx) =>
            branchCtx.execute(branchCtx.steps.cancelFlight(args.destination, args.customerId)),
        }),
      );
      type _FirstCompKey = Assert<
        IsAny<typeof firstComp> extends false ? true : false
      >;
    });

    // ==========================================================================
    // scope() on concurrency context: returns DeterministicAwaitable always
    // ==========================================================================

    await ctx.execute(
      ctx.scope(
        "ScopeReturnTypeRegression",
        {},
        async (concurrencyCtx) => {
          // scope() on WorkflowConcurrencyContext returns DeterministicAwaitable
          const innerScope = concurrencyCtx.scope(
            "InnerDet",
            {},
            async () => "done" as const,
          );
          type _InnerScopeIsDeterministic = Assert<
            typeof innerScope extends DeterministicAwaitable<"done", any> ? true : false
          >;
          // NOT a BranchHandle (no scopePathBrand)
          // We just check it's DeterministicAwaitable and not anything we'd
          // erroneously use as a branch handle directly with ctx.select()
          const result = await concurrencyCtx.execute(innerScope);
          type _InnerResultIsDone = Assert<IsEqual<typeof result, "done">>;
        },
      ),
    );

    // ==========================================================================
    // CompensationConcurrencyContext naming check
    // ==========================================================================

    ctx.addCompensation(async (compCtx) => {
      await compCtx.execute(
        compCtx.scope(
          "CompMatrix",
          {
            cancelAttempt: async (branchCtx) =>
              branchCtx.execute(
                branchCtx.steps.cancelFlight(args.destination, args.customerId),
              ),
            timer: async (_branchCtx) => {
              await compCtx.sleep(1);
              return "done" as const;
            },
          },
          async (ctx, { cancelAttempt, timer }) => {
            // ctx is CompensationConcurrencyContext
            type _IsCompConcurrencyCtx = Assert<
              typeof ctx extends CompensationConcurrencyContext<any, any, any, any, any, any, any, any, any, any>
                ? true
                : false
            >;
            // Has execute() and join()
            type _HasExecute = Assert<"execute" extends keyof typeof ctx ? true : false>;
            type _HasJoin = Assert<"join" extends keyof typeof ctx ? true : false>;
            // Has select() and match()
            type _HasSelect = Assert<"select" extends keyof typeof ctx ? true : false>;
            type _HasMatch = Assert<"match" extends keyof typeof ctx ? true : false>;
            // Has listen()
            type _HasListen = Assert<"listen" extends keyof typeof ctx ? true : false>;

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

            for await (const { key, result } of ctx.match(compSel)) {
              type _CompMatchKeyedUnionNoAny = Assert<
                IsAny<typeof key> extends false ? true : false
              >;
              break;
            }

            for await (const value of ctx.match(compSel, {
              timer: (v) => v,
              cancelAttempt: (r) => r.status,
              cancelOnce: (msg) => (msg ? msg.reason : "none"),
            })) {
              type _CompSelectNoAny = Assert<
                IsAny<typeof value> extends false ? true : false
              >;
              break;
            }

            // ctx.match(sel, onFailure) overload
            for await (const value of ctx.match(compSel, () => "failed" as const)) {
              type _CompMatchOnFailureNoAny = Assert<
                IsAny<typeof value> extends false ? true : false
              >;
              break;
            }

            const compAll = await ctx.execute(
              ctx.all({
                cancelAttempt: async (branchCtx) =>
                  branchCtx.execute(
                    branchCtx.steps.cancelFlight(args.destination, args.customerId),
                  ),
              }),
            );
            type _CompAllNoAny = Assert<
              IsAny<typeof compAll> extends false ? true : false
            >;

            const compFirst = await ctx.execute(
              ctx.first({
                timer: async (_branchCtx) => {
                  await compCtx.sleep(1);
                  return "done" as const;
                },
              }),
            );
            type _CompFirstNoAny = Assert<
              IsAny<typeof compFirst> extends false ? true : false
            >;
            type _CompFirstIsDiscriminated = Assert<
              IsEqual<typeof compFirst, { key: "timer"; result: "done" }>
            >;
          },
        ),
      );
    });

    return { ok: true };
  },
});
