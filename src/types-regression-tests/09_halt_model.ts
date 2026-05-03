import { z } from "zod";
import { defineStep, defineWorkflow } from "../workflow";
import type {
  CompensationBlockHaltStatus,
  ErrorFactories,
  WorkflowHaltStatus,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// HALT STATUS UNIONS
//
// The unified halt model collapses to a single status enum across workflow
// kinds, but the public type surface keeps two aliases so that operator-facing
// API can discriminate the per-kind action surface (workflow halts: not
// skippable; compensation block halts: skippable per instance).
// =============================================================================

type _WorkflowHaltStatus = Assert<
  IsEqual<WorkflowHaltStatus, "pending" | "resolved">
>;
type _CompensationBlockHaltStatus = Assert<
  IsEqual<CompensationBlockHaltStatus, "pending" | "resolved" | "skipped">
>;

// =============================================================================
// PER-CONTEXT THROW RULES
//
// - Workflow body: `ctx.errors` exposes the workflow's declared errors;
//   throwing a recognised explicit error fails the workflow with a typed
//   `ErrorValue`. Anything else halts the workflow (execution halt).
// - Compensation `undo`: there is no `ctx.errors`. Outcomes are reported
//   through the optional `result` schema. Anything thrown halts the block.
// =============================================================================

const auditStep = defineStep({
  name: "haltModelAuditStep",
  args: z.object({ id: z.string() }),
  result: z.void(),
  async execute() {},
});

const compensableStep = defineStep({
  name: "haltModelCompensableStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ack: z.boolean() }),
  compensation: {
    steps: { auditStep },
    async undo(ctx, _args, _info) {
      // Compensation undo has no `errors` field on the context — throws halt
      // the compensation block instance instead of failing it with a typed
      // business error.
      type _NoErrorsOnCompensationContext = Assert<
        "errors" extends keyof typeof ctx ? false : true
      >;

      await ctx.steps.auditStep({ id: "any" });
    },
  },
  async execute(_ctx, args) {
    return { ack: args.id.length > 0 };
  },
});

export const haltModelAcceptanceWorkflow = defineWorkflow({
  name: "haltModelAcceptance",
  args: z.object({ id: z.string() }),
  errors: {
    WorkflowError: z.object({ id: z.string() }),
  },
  steps: { compensableStep },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    // Workflow body — `ctx.errors` exposes the workflow's declared errors.
    type _Factories = Assert<
      typeof ctx.errors extends ErrorFactories<{
        WorkflowError: z.ZodObject<{ id: z.ZodString }, any>;
      }>
        ? true
        : false
    >;

    const declared = ctx.errors.WorkflowError("declared", { id: args.id });
    void declared;

    // @ts-expect-error workflow body cannot reference an unknown error code
    ctx.errors.UnknownError("not declared", { id: args.id });

    return { ok: true };
  },
});

void compensableStep;
