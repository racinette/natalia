import { z } from "zod";
import { defineBranch, defineWorkflow } from "../workflow";
import type { ErrorValue, ExplicitError, Failure } from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const PaymentDeclinedDetails = z.object({
  reason: z.enum(["card_declined", "fraud_check"]),
  amount: z.number(),
});

const BranchOnlyDetails = z.object({ supplier: z.string() });

const supplierBranch = defineBranch({
  name: "supplierBranch",
  args: z.object({ supplier: z.string() }),
  result: z.object({ reservationId: z.string() }),
  errors: {
    SupplierUnavailable: BranchOnlyDetails,
  },
  async execute(ctx, args) {
    const err = ctx.errors.SupplierUnavailable("Supplier failed", {
      supplier: args.supplier,
    });

    type _BranchErrorNoAny = Assert<IsAny<typeof err> extends false ? true : false>;
    type _BranchErrorShape = Assert<
      typeof err extends ExplicitError<
        "SupplierUnavailable",
        { supplier: string }
      >
        ? true
        : false
    >;

    // @ts-expect-error branch-local context cannot see workflow-level errors
    ctx.errors.PaymentDeclined("not visible", {
      reason: "card_declined",
      amount: 1,
    });

    throw err;
  },
});

export const errorModelAcceptanceWorkflow = defineWorkflow({
  name: "errorModelAcceptance",
  args: z.object({ amount: z.number() }),
  errors: {
    PaymentDeclined: PaymentDeclinedDetails,
    MissingApproval: true,
  },
  branches: { supplier: supplierBranch },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    const declined = ctx.errors.PaymentDeclined("Payment declined", {
      reason: "card_declined",
      amount: args.amount,
    });

    type _WorkflowErrorNoAny = Assert<
      IsAny<typeof declined> extends false ? true : false
    >;
    type _WorkflowErrorShape = Assert<
      typeof declined extends ExplicitError<
        "PaymentDeclined",
        { reason: "card_declined" | "fraud_check"; amount: number }
      >
        ? true
        : false
    >;

    const missing = ctx.errors.MissingApproval("Approval was not recorded");
    type _TrueErrorHasUndefinedDetails = Assert<
      typeof missing extends ExplicitError<"MissingApproval", undefined>
        ? true
        : false
    >;

    // @ts-expect-error unknown workflow error code
    ctx.errors.SupplierUnavailable("not visible", { supplier: "x" });
    // @ts-expect-error details must match the declared schema input
    ctx.errors.PaymentDeclined("bad details", { reason: "unknown", amount: 1 });
    // @ts-expect-error true-valued error definitions do not accept details
    ctx.errors.MissingApproval("no details", { unexpected: true });

    const branch = ctx.branches.supplier({ supplier: "supplier-a" });
    const branchResult = await ctx.join(branch);
    if (!branchResult.ok) {
      type _BranchErrorValue = Assert<
        IsEqual<
          typeof branchResult.error,
          ErrorValue<{
            SupplierUnavailable: typeof BranchOnlyDetails;
          }>
        >
      >;
    }

    throw declined;
  },
});

type _ErrorValueShape = Assert<
  ErrorValue<{ PaymentDeclined: typeof PaymentDeclinedDetails }> extends {
    readonly code: "PaymentDeclined";
    readonly message: string;
    readonly details: { reason: "card_declined" | "fraud_check"; amount: number };
  }
    ? true
    : false
>;

const _failure: Failure = {
  startedAt: new Date(),
  failedAt: new Date(),
  message: null,
  type: null,
  details: undefined,
};

type _FailureDoesNotRequireAttempt = Assert<
  "attempt" extends keyof typeof _failure ? false : true
>;
