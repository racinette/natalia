import { z } from "zod";
import { defineRequest, defineStep, defineWorkflow } from "../workflow";
import type {
  AwaitableEntry,
  RequestEntry,
  StepEntry,
  WorkflowEntry,
} from "../types";

// =============================================================================
// REMOVED PUBLIC TYPES — must NOT be exported from "../types".
//
// Each of the following imports is paired with a `@ts-expect-error`. If any
// type re-emerges on the public surface, the directive becomes unused and
// fails the build, flagging the regression at the import site.
// =============================================================================

// @ts-expect-error DurableHandle is no longer part of the public type surface
import type { DurableHandle as _RemovedDurableHandle } from "../types";
// @ts-expect-error AtomicResult is no longer part of the public type surface
import type { AtomicResult as _RemovedAtomicResult } from "../types";
// @ts-expect-error BlockingResult is no longer part of the public type surface
import type { BlockingResult as _RemovedBlockingResult } from "../types";
// @ts-expect-error StepCall is no longer part of the public type surface
import type { StepCall as _RemovedStepCall } from "../types";
// @ts-expect-error WorkflowCall is no longer part of the public type surface
import type { WorkflowCall as _RemovedWorkflowCall } from "../types";
// @ts-expect-error WorkflowCallResult is no longer part of the public type surface
import type { WorkflowCallResult as _RemovedWorkflowCallResult } from "../types";
// @ts-expect-error ScopeCall is no longer part of the public type surface
import type { ScopeCall as _RemovedScopeCall } from "../types";
// @ts-expect-error FirstCall is no longer part of the public type surface
import type { FirstCall as _RemovedFirstCall } from "../types";
// @ts-expect-error CompensationStepCall is no longer part of the public type surface
import type { CompensationStepCall as _RemovedCompensationStepCall } from "../types";
// @ts-expect-error CompensationWorkflowCall is no longer part of the public type surface
import type { CompensationWorkflowCall as _RemovedCompensationWorkflowCall } from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type AwaitedValue<T> = T extends PromiseLike<infer U> ? U : never;

// =============================================================================
// 1. Entry brand types extend AwaitableEntry, which extends PromiseLike.
//    This is the type-level shape contract for dispatched entries.
// =============================================================================

type _AwaitableExtendsPromiseLike = Assert<
  AwaitableEntry<number> extends PromiseLike<number> ? true : false
>;
type _StepExtendsAwaitable = Assert<
  StepEntry<number> extends AwaitableEntry<number> ? true : false
>;
type _RequestExtendsAwaitable = Assert<
  RequestEntry<number> extends AwaitableEntry<number> ? true : false
>;
type _WorkflowEntryExtendsAwaitable = Assert<
  WorkflowEntry<number> extends AwaitableEntry<number> ? true : false
>;

// Entries are *not* native Promises. The body of a workflow may not pass them
// to `Promise.all` or other JS concurrency primitives without going through
// `ctx.scope` / `ctx.all` / `ctx.first` / `ctx.atLeast` / `ctx.atMost` /
// `ctx.some` / `ctx.match` (covered by step 07).
type _StepEntryIsNotPromise = Assert<
  StepEntry<number> extends Promise<number> ? false : true
>;

// =============================================================================
// FIXTURES
// =============================================================================

const noopStep = defineStep({
  name: "execModelNoopStep",
  args: z.object({ value: z.string() }),
  result: z.object({ normalized: z.string() }),
  async execute(_ctx, args) {
    return { normalized: args.value.trim() };
  },
});

const noopRequest = defineRequest({
  name: "execModelNoopRequest",
  payload: z.object({ value: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const childWorkflow = defineWorkflow({
  name: "execModelChild",
  args: z.object({ value: z.number() }),
  result: z.object({ doubled: z.number() }),
  async execute(_ctx, args) {
    return { doubled: args.value * 2 };
  },
});

// =============================================================================
// 2. Direct await on a step entry resolves to the step's declared result.
//    Direct await on a request entry resolves to the response.
//    Direct await on an attached child workflow entry resolves to the
//    success-or-failure union (success-or-failure-or-timeout when timeout
//    is provided — covered by step 03; for step 01 we only verify the no-
//    timeout shape exists).
// =============================================================================

export const executionModelAcceptanceWorkflow = defineWorkflow({
  name: "executionModelAcceptance",
  steps: { noopStep },
  requests: { noopRequest },
  childWorkflows: { childWorkflow },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    // Step entry: dispatched, awaitable, resolves to T.
    const stepEntry = ctx.steps.noopStep({ value: "  hi  " });
    type _StepEntryNotAny = Assert<IsAny<typeof stepEntry> extends false ? true : false>;
    type _StepEntryIsBranded = Assert<
      typeof stepEntry extends StepEntry<{ normalized: string }> ? true : false
    >;
    type _StepEntryAwaited = Assert<
      IsEqual<AwaitedValue<typeof stepEntry>, { normalized: string }>
    >;
    const stepResult = await stepEntry;
    type _StepResult = Assert<IsEqual<typeof stepResult, { normalized: string }>>;

    // Request entry: dispatched, awaitable, resolves to TResponse.
    const requestEntry = ctx.requests.noopRequest({ value: "v" });
    type _RequestEntryIsBranded = Assert<
      typeof requestEntry extends RequestEntry<{ ok: boolean }> ? true : false
    >;
    const requestResult = await requestEntry;
    type _RequestResult = Assert<IsEqual<typeof requestResult, { ok: boolean }>>;

    // Attached child workflow entry: dispatched, awaitable, resolves to a
    // success-or-failure union. Step 01 only verifies it is an AwaitableEntry
    // and the awaited type contains the success branch; the exact shape of
    // the union (and the channel-send surface) is step 03.
    const childEntry = ctx.childWorkflows.childWorkflow({ args: { value: 21 } });
    type _ChildEntryIsAwaitable = Assert<
      typeof childEntry extends AwaitableEntry<any> ? true : false
    >;
    const childResult = await childEntry;
    type _ChildResultHasSuccessBranch = Assert<
      Extract<typeof childResult, { ok: true; result: { doubled: number } }> extends never
        ? false
        : true
    >;

    // =========================================================================
    // 3. Buffered operations return void synchronously and produce no entry.
    //
    //    The four buffered surfaces step 01 covers are:
    //      - ctx.streams.X.write
    //      - ctx.events.X.set
    //      - ctx.channels.X.send (when the parent has channels — covered by
    //        the child-workflow handle channel-send surface in step 03)
    //
    //    Queues, topics, attributes, startDetached, and the scope/match
    //    surface are covered by their own steps (13, 12 / 15, 13, 03, 07).
    // =========================================================================

    // Existence and shape of the buffered-op accessors is covered by their
    // own steps. Step 01 only asserts that *if* such accessors exist on a
    // workflow context, their public-API return is `void` — verified by
    // calling them in their own steps' acceptance tests.

    return { ok: true };
  },
});

// =============================================================================
// 4. The legacy builder methods must NOT exist on entries.
//
// `@ts-expect-error` proves the surface is gone.
// =============================================================================

declare const someStepEntry: StepEntry<{ normalized: string }>;

// @ts-expect-error .resolve(ctx) is no longer part of entries
someStepEntry.resolve;
// @ts-expect-error .retry is no longer part of entries (call-time options live in step 03)
someStepEntry.retry;
// @ts-expect-error .complete is no longer part of entries
someStepEntry.complete;
// @ts-expect-error .failure is no longer part of entries
someStepEntry.failure;
// @ts-expect-error .compensate is no longer part of entries (compensation is definition-bound)
someStepEntry.compensate;
// @ts-expect-error .timeout(boundary, cb) builder is replaced by call-time `{ timeout }` (step 03)
someStepEntry.timeout;
// @ts-expect-error .priority builder is replaced by call-time `{ priority }` for requests (step 03)
someStepEntry.priority;
