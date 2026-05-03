import { z } from "zod";
import { defineStep, defineWorkflow, defineWorkflowHeader } from "../workflow";
import type { ErrorValue, ExplicitError, Failure, FailureInfo } from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// FIXTURES
// =============================================================================

const PaymentDeclinedDetails = z.object({
  reason: z.enum(["card_declined", "fraud_check"]),
  amount: z.number(),
});

const childHeader = defineWorkflowHeader({
  name: "errorModelChild",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  errors: {
    ChildFailed: z.object({ reason: z.string() }),
  },
});

const noopStep = defineStep({
  name: "errorModelNoopStep",
  args: z.object({ id: z.string() }),
  result: z.void(),
  async execute() {},
});

// =============================================================================
// WORKFLOW BODY — `ctx.errors` exposes the workflow's declared errors only.
// =============================================================================

export const errorModelAcceptanceWorkflow = defineWorkflow({
  name: "errorModelAcceptance",
  args: z.object({ amount: z.number() }),
  errors: {
    PaymentDeclined: PaymentDeclinedDetails,
    MissingApproval: true,
  },
  steps: { noopStep },
  childWorkflows: { child: childHeader },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    // Factory produces a typed throwable.
    const declined = ctx.errors.PaymentDeclined("Payment declined", {
      reason: "card_declined",
      amount: args.amount,
    });

    type _DeclinedNoAny = Assert<IsAny<typeof declined> extends false ? true : false>;
    type _DeclinedShape = Assert<
      typeof declined extends ExplicitError<
        "PaymentDeclined",
        { reason: "card_declined" | "fraud_check"; amount: number }
      >
        ? true
        : false
    >;

    // `true`-valued errors take only `message`; details inferred as `undefined`.
    const missing = ctx.errors.MissingApproval("Approval was not recorded");
    type _TrueErrorHasUndefinedDetails = Assert<
      typeof missing extends ExplicitError<"MissingApproval", undefined>
        ? true
        : false
    >;

    // ----------------------------------------------------------------------
    // REJECTED PATTERNS
    // ----------------------------------------------------------------------

    // @ts-expect-error unknown error code is rejected
    ctx.errors.UnknownCode("not declared", { foo: 1 });

    // @ts-expect-error details must match the declared schema input
    ctx.errors.PaymentDeclined("bad details", { reason: "unknown", amount: 1 });

    // @ts-expect-error true-valued error definitions do not accept details
    ctx.errors.MissingApproval("no details", { unexpected: true });

    // ----------------------------------------------------------------------
    // SCOPE BODY — `ctx.errors` is the SAME factory map as the workflow body.
    // There is no scope-local error namespace.
    // ----------------------------------------------------------------------

    await ctx.scope(
      "validate",
      { audit: ctx.steps.noopStep({ id: "audit-1" }) },
      async (scopeCtx) => {
        // The workflow's errors are reachable from the scope body.
        const fromScope = scopeCtx.errors.PaymentDeclined("From scope", {
          reason: "fraud_check",
          amount: 0,
        });
        type _ScopeFactorySameAsWorkflow = Assert<
          IsEqual<typeof fromScope, typeof declined>
        >;

        // @ts-expect-error scope body cannot reference an unknown error code
        scopeCtx.errors.UnknownCode("not declared");

        return undefined;
      },
    );

    // ----------------------------------------------------------------------
    // CHILD WORKFLOW FAILURE — observed as a returned union value, not thrown.
    // The `error` field is `ErrorValue<TChildErrors>` with `type: "ExplicitError"`.
    // ----------------------------------------------------------------------

    const child = await ctx.childWorkflows.child({
      idempotencyKey: "child-1",
      args: { id: "c-1" },
    });
    if (!child.ok) {
      if (child.status === "failed") {
        // Discriminate on `code` directly — Part 4 line 720.
        type _ChildErrorTaggedAsExplicit = Assert<
          IsEqual<typeof child.error.type, "ExplicitError">
        >;
        type _ChildErrorCode = Assert<
          IsEqual<typeof child.error.code, "ChildFailed">
        >;
        type _ChildErrorDetails = Assert<
          IsEqual<typeof child.error.details, { reason: string }>
        >;
      }
    }

    // The body decides whether to translate a child failure into a
    // workflow-level failure via `throw ctx.errors.X(...)`.
    if (!child.ok && child.status === "failed") {
      throw ctx.errors.PaymentDeclined("Child failed", {
        reason: "fraud_check",
        amount: 0,
      });
    }

    return { ok: true };
  },
});

// =============================================================================
// EXTERNAL CALLER VIEW — `ErrorValue<TErrors>` carries the discriminator.
// =============================================================================

type _ErrorValueShape = Assert<
  ErrorValue<{ PaymentDeclined: typeof PaymentDeclinedDetails }> extends {
    readonly type: "ExplicitError";
    readonly code: "PaymentDeclined";
    readonly message: string;
    readonly details: { reason: "card_declined" | "fraud_check"; amount: number };
  }
    ? true
    : false
>;

type _TrueErrorValueShape = Assert<
  ErrorValue<{ MissingApproval: true }> extends {
    readonly type: "ExplicitError";
    readonly code: "MissingApproval";
    readonly message: string;
    readonly details: undefined;
  }
    ? true
    : false
>;

// Discriminate on `code` directly — there is no outer category discriminant.
type WorkflowErrorMap = {
  PaymentDeclined: typeof PaymentDeclinedDetails;
  MissingApproval: true;
};
type _UnionDiscriminatesByCode = Assert<
  IsEqual<
    keyof Extract<ErrorValue<WorkflowErrorMap>, { code: "PaymentDeclined" }>,
    "type" | "code" | "message" | "details"
  >
>;

// `FailureInfo<TErrors>` is `ErrorValue<TErrors>`.
type _FailureInfoIsErrorValue = Assert<
  IsEqual<FailureInfo<WorkflowErrorMap>, ErrorValue<WorkflowErrorMap>>
>;

// =============================================================================
// `Failure` BASE RECORD — captured single throw on retry attempts.
// Has no `attempt` field; `Attempt extends Failure` adds it (step 05).
// =============================================================================

const _failure: Failure = {
  startedAt: new Date(),
  failedAt: new Date(),
  message: null,
  type: null,
  details: undefined,
};
void _failure;

type _FailureDoesNotRequireAttempt = Assert<
  "attempt" extends keyof Failure ? false : true
>;

// =============================================================================
// COMPENSATION `undo` HAS NO `ctx.errors`.
//
// Verified in detail in 09_halt_model.ts and compensation_model.ts; included
// here as a structural reminder.
// =============================================================================

defineStep({
  name: "errorModelCompensableStep",
  args: z.object({ id: z.string() }),
  result: z.void(),
  compensation: {
    async undo(ctx, _args, _info) {
      // @ts-expect-error compensation undo has no ctx.errors
      ctx.errors;
    },
  },
  async execute() {},
});
