import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type {
  AwaitableEntry,
  ChannelSendSurface,
  ForeignWorkflowHandle,
  RetryPolicyOptions,
  StepBoundary,
} from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// RETRY POLICY OPTIONS — retry behavior only (no workflow-side deadlines).
// =============================================================================

const _retryPolicy: RetryPolicyOptions = {
  intervalSeconds: 1,
  backoffRate: 2,
  maxIntervalSeconds: 60,
  timeoutSeconds: 5, // per-attempt execution timeout
};

// @ts-expect-error retry policy no longer owns total workflow-side deadlines
const _retryPolicyNoDeadlineSeconds: RetryPolicyOptions = { deadlineSeconds: 30 };

// =============================================================================
// STEP BOUNDARY — workflow-side observation boundary.
// =============================================================================

const _relativeBoundary: StepBoundary = 30;
const _dateBoundary: StepBoundary = new Date("2027-01-01T00:00:00.000Z");
const _attemptBoundary: StepBoundary = { maxAttempts: 5 };
const _secondsAndAttemptsBoundary: StepBoundary = { seconds: 30, maxAttempts: 3 };
const _deadlineAndAttemptsBoundary: StepBoundary = {
  deadline: new Date("2027-01-01T00:00:00.000Z"),
  maxAttempts: 3,
};

// @ts-expect-error StepBoundary uses `deadline`, not `deadlineUntil`
const _invalidBoundary: StepBoundary = { deadlineUntil: new Date() };

// =============================================================================
// FIXTURES
// =============================================================================

const TimedStepArgs = z.object({ id: z.string() });
const TimedStepResult = z.object({ value: z.string() });

const timedStep = defineStep({
  name: "timedStep",
  args: TimedStepArgs,
  result: TimedStepResult,
  async execute(_ctx, args) {
    return { value: args.id };
  },
});

const childHeader = defineWorkflowHeader({
  name: "callTimeOptionsChild",
  args: z.object({ id: z.string() }),
  result: z.object({ childValue: z.string() }),
  channels: {
    cancel: z.object({ reason: z.string() }),
    nudge: z.object({ at: z.string() }),
  },
  errors: {
    ChildFailed: z.object({ reason: z.string() }),
  },
});

const humanReviewRequest = defineRequest({
  name: "humanReview",
  payload: z.object({ documentId: z.string() }),
  response: z.object({ approved: z.boolean() }),
});

// =============================================================================
// CALL-TIME OPTIONS — the core acceptance.
// =============================================================================

export const callTimeOptionsAcceptanceWorkflow = defineWorkflow({
  name: "callTimeOptionsAcceptance",
  steps: { timedStep },
  childWorkflows: { child: childHeader },
  requests: { humanReview: humanReviewRequest },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    // -------------------------------------------------------------------------
    // STEPS
    //
    // Three overloads:
    //   - (args)                                 → T directly
    //   - (args, { retry })                      → T directly (retry-only)
    //   - (args, { retry?, timeout })            → timeout union
    // -------------------------------------------------------------------------

    const directStep = await ctx.steps.timedStep({ id: "s-1" });
    type _DirectStepNoAny = Assert<IsAny<typeof directStep> extends false ? true : false>;
    type _DirectStepResult = Assert<IsEqual<typeof directStep, { value: string }>>;

    const retryOnlyStep = await ctx.steps.timedStep(
      { id: "s-1r" },
      { retry: { intervalSeconds: 1, backoffRate: 2 } },
    );
    type _RetryOnlyStepResult = Assert<IsEqual<typeof retryOnlyStep, { value: string }>>;

    const timedStepResult = await ctx.steps.timedStep(
      { id: "s-2" },
      { retry: { intervalSeconds: 1 }, timeout: { maxAttempts: 3 } },
    );
    type _TimedStepResult = Assert<
      IsEqual<
        typeof timedStepResult,
        | { ok: true; result: { value: string } }
        | { ok: false; status: "timeout" }
      >
    >;

    if (!timedStepResult.ok) {
      type _TimedStepStatus = Assert<IsEqual<typeof timedStepResult.status, "timeout">>;
    }

    // -------------------------------------------------------------------------
    // CHILD WORKFLOWS
    //
    // Two overloads:
    //   - (startOpts)                  → success-or-failure union
    //   - (startOpts, { timeout, ... }) → success-or-failure-or-timeout union
    //
    // Children are not retried by the parent; there is no `retry`-only call
    // overload.
    //
    // The returned entry is an AttachedChildWorkflowEntry: awaitable AND
    // exposes the child's declared `channels.X.send` surface. It has NO
    // `idempotencyKey` (attached children are not globally addressable).
    // -------------------------------------------------------------------------

    const childEntry = ctx.childWorkflows.child({
      idempotencyKey: "child-1",
      args: { id: "c-1" },
    });

    type _ChildEntryAwaitable = Assert<
      typeof childEntry extends AwaitableEntry<any> ? true : false
    >;
    type _ChildEntryHasChannelSend = Assert<
      typeof childEntry extends ChannelSendSurface<any> ? true : false
    >;
    // @ts-expect-error attached child entries have NO idempotencyKey
    childEntry.idempotencyKey;

    // The entry is awaitable for the success/failure union:
    const child = await childEntry;
    type _ChildHasSuccessBranch = Assert<
      Extract<typeof child, { ok: true; result: { childValue: string } }> extends never
        ? false
        : true
    >;
    type _ChildHasFailedBranch = Assert<
      Extract<typeof child, { ok: false; status: "failed" }> extends never
        ? false
        : true
    >;
    type _ChildHasNoTimeoutBranch = Assert<
      Extract<typeof child, { ok: false; status: "timeout" }> extends never
        ? true
        : false
    >;

    // The entry can also have messages sent to it while it runs (buffered;
    // returns plain `void` per Part 1.2).
    const sendReturn: void = childEntry.channels.cancel.send({ reason: "user" });
    void sendReturn;
    childEntry.channels.nudge.send({ at: "2027-01-01T00:00:00.000Z" });

    // Timeout overload adds `{ ok: false; status: "timeout" }`.
    const timedChild = await ctx.childWorkflows.child(
      { idempotencyKey: "child-2", args: { id: "c-2" } },
      { timeout: 60 },
    );
    type _TimedChildHasTimeout = Assert<
      Extract<typeof timedChild, { ok: false; status: "timeout" }> extends never
        ? false
        : true
    >;

    // No retry-only overload on child workflows: passing `retry` without
    // `timeout` is rejected because the only options-bag overload requires
    // `timeout`.
    ctx.childWorkflows.child(
      { idempotencyKey: "child-3", args: { id: "c-3" } },
      // @ts-expect-error child workflows require `timeout` when an options bag is supplied
      { retry: { intervalSeconds: 1 } },
    );

    // -------------------------------------------------------------------------
    // DETACHED CHILD WORKFLOW STARTS
    //
    // Buffered, synchronous; returns ForeignWorkflowHandle<W>. Send-capable
    // and carries idempotencyKey. Not awaitable.
    // -------------------------------------------------------------------------

    const detached = ctx.childWorkflows.child.startDetached({
      idempotencyKey: "child-detached-1",
      args: { id: "d-1" },
    });
    type _DetachedIsForeignHandle = Assert<
      typeof detached extends ForeignWorkflowHandle<any> ? true : false
    >;
    type _DetachedHasIdempotencyKey = Assert<
      typeof detached.idempotencyKey extends string ? true : false
    >;
    detached.channels.cancel.send({ reason: "from parent" });
    detached.channels.nudge.send({ at: "2027-01-01T00:00:00.000Z" });
    // Detached handles are NOT awaitable entries — they have no PromiseLike
    // surface.
    type _DetachedNotAwaitable = Assert<
      typeof detached extends PromiseLike<unknown> ? false : true
    >;

    // -------------------------------------------------------------------------
    // REQUESTS
    //
    // Two overloads:
    //   - (payload)                              → response directly
    //   - (payload, { priority?, timeout })      → timeout union (timeout required when opts supplied)
    //
    // Requests delegate resolution; configuration of retries, deadlines,
    // and exhaustion-fallbacks lives on the handler registration, not here.
    // -------------------------------------------------------------------------

    const request = await ctx.requests.humanReview({ documentId: "d-1" });
    type _RequestDirect = Assert<IsEqual<typeof request, { approved: boolean }>>;

    const timedRequest = await ctx.requests.humanReview(
      { documentId: "d-2" },
      { priority: 1, timeout: new Date("2027-01-01T00:00:00.000Z") },
    );
    type _TimedRequest = Assert<
      IsEqual<
        typeof timedRequest,
        | { ok: true; result: { approved: boolean } }
        | { ok: false; status: "timeout" }
      >
    >;

    // priority alone (without timeout) is rejected — no priority-only overload.
    // @ts-expect-error requests require `timeout` when an options bag is supplied
    ctx.requests.humanReview({ documentId: "d-3" }, { priority: 5 });

    // -------------------------------------------------------------------------
    // BUILDER METHODS REMOVED ON ENTRIES
    // -------------------------------------------------------------------------

    const stepEntry = ctx.steps.timedStep({ id: "s-3" });
    // @ts-expect-error retry is a call option, not a builder
    stepEntry.retry({ intervalSeconds: 1 });
    // @ts-expect-error timeout is a call option, not a builder
    stepEntry.timeout(30);
    // @ts-expect-error priority does not apply to steps
    ctx.steps.timedStep({ id: "s-4" }, { priority: 1 });
    // @ts-expect-error request priority is a call option, not a builder
    ctx.requests.humanReview({ documentId: "d-3" }).priority;

    return { ok: true };
  },
});
