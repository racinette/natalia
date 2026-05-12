import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type {
  AwaitableEntry,
  ForeignWorkflowHandle,
  RetryPolicyOptions,
  StepBoundary,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";

type IsAny<T> = 0 extends 1 & T ? true : false;

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

const externalHeader = defineWorkflowHeader({
  name: "callTimeOptionsExternal",
  channels: {
    ping: z.object({ at: z.string() }),
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
  children: { attached: { child: childHeader }, detached: { child: childHeader } },
  external: { ops: externalHeader },
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

    const _directStep = await ctx.steps.timedStep({ id: "s-1" });
    type _DirectStepNoAny = Assert<IsAny<typeof _directStep> extends false ? true : false>;
    type _DirectStepResult = Assert<IsEqual<typeof _directStep, { value: string }>>;

    const _retryOnlyStep = await ctx.steps.timedStep(
      { id: "s-1r" },
      { retry: { intervalSeconds: 1, backoffRate: 2 } },
    );
    type _RetryOnlyStepResult = Assert<IsEqual<typeof _retryOnlyStep, { value: string }>>;

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
    // AttachedChildWorkflowEntry: awaitable for the success/failure union only
    // (no `channels.*.send` on the direct entry; no `idempotencyKey` on start opts).
    // -------------------------------------------------------------------------

    const childEntry = ctx.children.attached.child({
      args: { id: "c-1" },
    });

    type _ChildEntryAwaitable = Assert<
      typeof childEntry extends AwaitableEntry<infer _> ? true : false
    >;
    type _ChildEntryNoChannelsKey = Assert<
      "channels" extends keyof typeof childEntry ? false : true
    >;

    ctx.children.attached.child({
      // @ts-expect-error attached start options omit idempotencyKey
      idempotencyKey: "child-1",
      args: { id: "c-1-bad" },
    });

    // The entry is awaitable for the success/failure union:
    const _child = await childEntry;
    type _ChildHasSuccessBranch = Assert<
      Extract<typeof _child, { ok: true; result: { childValue: string } }> extends never
        ? false
        : true
    >;
    type _ChildHasFailedBranch = Assert<
      Extract<typeof _child, { ok: false; status: "failed" }> extends never
        ? false
        : true
    >;
    type _ChildHasNoTimeoutBranch = Assert<
      Extract<typeof _child, { ok: false; status: "timeout" }> extends never
        ? true
        : false
    >;

    await ctx.scope(
      "callTimeChildChannels",
      { c: ctx.children.attached.child({ args: { id: "c-1b" } }) },
      async (sctx, { c }) => {
        const sendReturn: void = c.channels.cancel.send({ reason: "user" });
        void sendReturn;
        c.channels.nudge.send({ at: "2027-01-01T00:00:00.000Z" });
        await sctx.join(c);
        return undefined;
      },
    );

    // Timeout overload adds `{ ok: false; status: "timeout" }`.
    const _timedChild = await ctx.children.attached.child({ args: { id: "c-2" } }, { timeout: 60 });
    type _TimedChildHasTimeout = Assert<
      Extract<typeof _timedChild, { ok: false; status: "timeout" }> extends never
        ? false
        : true
    >;

    // No retry-only overload on child workflows: passing `retry` without
    // `timeout` is rejected because the only options-bag overload requires
    // `timeout`.
    ctx.children.attached.child(
      { args: { id: "c-3" } },
      // @ts-expect-error child workflows require `timeout` when an options bag is supplied
      { retry: { intervalSeconds: 1 } },
    );

    // -------------------------------------------------------------------------
    // DETACHED CHILD WORKFLOW STARTS
    //
    // Buffered, synchronous; returns ForeignWorkflowHandle<W>. Send-capable
    // and carries idempotencyKey. Not awaitable.
    // -------------------------------------------------------------------------

    const detached = ctx.children.detached.child({
      idempotencyKey: "child-detached-1",
      args: { id: "d-1" },
    });
    type _DetachedIsForeignHandle = Assert<
      typeof detached extends ForeignWorkflowHandle<infer _> ? true : false
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
    // @ts-expect-error detached starts are exposed on ctx.children.detached only
    void ctx.children.attached.child.startDetached;

    // -------------------------------------------------------------------------
    // EXTERNAL WORKFLOW ACCESSORS
    // -------------------------------------------------------------------------
    const externalHandle = ctx.external.ops.get("external-1");
    type _ExternalHandle = Assert<
      typeof externalHandle extends ForeignWorkflowHandle<infer _> ? true : false
    >;
    externalHandle.channels.ping.send({ at: "2027-01-01T00:00:00.000Z" });

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

    const _request = await ctx.requests.humanReview({ documentId: "d-1" });
    type _RequestDirect = Assert<IsEqual<typeof _request, { approved: boolean }>>;

    const _timedRequest = await ctx.requests.humanReview(
      { documentId: "d-2" },
      { priority: 1, timeout: new Date("2027-01-01T00:00:00.000Z") },
    );
    type _TimedRequest = Assert<
      IsEqual<
        typeof _timedRequest,
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
    void stepEntry.retry({ intervalSeconds: 1 });
    // @ts-expect-error timeout is a call option, not a builder
    void stepEntry.timeout(30);
    // @ts-expect-error priority does not apply to steps
    void ctx.steps.timedStep({ id: "s-4" }, { priority: 1 });
    // @ts-expect-error request priority is a call option, not a builder
    void ctx.requests.humanReview({ documentId: "d-3" }).priority;

    return { ok: true };
  },
});
