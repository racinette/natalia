import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type { RetryPolicyOptions, StepBoundary } from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const _retryPolicy: RetryPolicyOptions = {
  intervalSeconds: 1,
  backoffRate: 2,
  maxIntervalSeconds: 60,
  timeoutSeconds: 5,
};

// @ts-expect-error retry policy no longer owns total workflow-side deadlines
const _retryPolicyNoDeadlineSeconds: RetryPolicyOptions = { deadlineSeconds: 30 };

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
  errors: {
    ChildFailed: z.object({ reason: z.string() }),
  },
});

const humanReviewRequest = defineRequest({
  name: "humanReview",
  payload: z.object({ documentId: z.string() }),
  response: z.object({ approved: z.boolean() }),
});

export const callTimeOptionsAcceptanceWorkflow = defineWorkflow({
  name: "callTimeOptionsAcceptance",
  steps: { timedStep },
  childWorkflows: { child: childHeader },
  requests: { humanReview: humanReviewRequest },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    const directStep = await ctx.steps.timedStep({ id: "s-1" });
    type _DirectStepNoAny = Assert<IsAny<typeof directStep> extends false ? true : false>;
    type _DirectStepResult = Assert<IsEqual<typeof directStep, { value: string }>>;

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

    const child = await ctx.childWorkflows.child({
      idempotencyKey: "child-1",
      args: { id: "c-1" },
    });
    type _ChildResult = Assert<
      IsEqual<
        typeof child,
        | { ok: true; result: { childValue: string } }
        | { ok: false; status: "failed"; error: unknown }
      >
    >;

    const timedChild = await ctx.childWorkflows.child(
      { idempotencyKey: "child-2", args: { id: "c-2" } },
      { timeout: 60 },
    );
    type _TimedChildResult = Assert<
      IsEqual<
        typeof timedChild,
        | { ok: true; result: { childValue: string } }
        | { ok: false; status: "failed"; error: unknown }
        | { ok: false; status: "timeout" }
      >
    >;

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

    const stepEntry = ctx.steps.timedStep({ id: "s-3" });
    // @ts-expect-error retry is a call option, not a builder
    stepEntry.retry({ intervalSeconds: 1 });
    // @ts-expect-error timeout is a call option, not a builder
    stepEntry.timeout(30, () => ({ value: "fallback" }));
    // @ts-expect-error priority only applies to request options
    ctx.steps.timedStep({ id: "s-4" }, { priority: 1 });
    // @ts-expect-error request priority is an option, not a builder
    ctx.requests.humanReview({ documentId: "d-3" }).priority(10);

    return { ok: true };
  },
});
