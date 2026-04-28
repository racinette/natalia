import { z } from "zod";
import { defineBranch, defineStep, defineWorkflow } from "../workflow";
import type {
  BranchHaltStatus,
  BranchJoinResult,
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
// HALT STATUS UNIONS — match the SQL schema constraints from Part 8
// =============================================================================

type _WorkflowHaltStatus = Assert<
  IsEqual<WorkflowHaltStatus, "pending" | "resolved">
>;
type _CompensationBlockHaltStatus = Assert<
  IsEqual<CompensationBlockHaltStatus, "pending" | "resolved" | "skipped">
>;
type _BranchHaltStatus = Assert<
  IsEqual<BranchHaltStatus, "pending" | "resolved" | "skipped">
>;

// =============================================================================
// PER-CONTEXT THROW RULES
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
      // the compensation block instance instead of failing it.
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

const branchNoErrors = defineBranch({
  name: "haltModelBranchNone",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, _args) {
    // errors omitted ≡ "none" — ctx.errors is empty; any thrown value halts
    // the branch.
    type _BranchNoneErrorsEmpty = Assert<
      IsEqual<typeof ctx.errors, ErrorFactories<Record<string, never>>>
    >;
    return { ok: true };
  },
});

const branchAnyErrors = defineBranch({
  name: "haltModelBranchAny",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  errors: "any",
  async execute(ctx, _args) {
    // errors: "any" — ctx.errors is empty; ordinary throws are captured as
    // Failure values at the parent consumption point. Engine-internal throws
    // still halt the branch.
    type _BranchAnyErrorsEmpty = Assert<
      IsEqual<typeof ctx.errors, ErrorFactories<Record<string, never>>>
    >;
    return { ok: true };
  },
});

const branchExplicitErrors = defineBranch({
  name: "haltModelBranchExplicit",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  errors: {
    BranchOnly: z.object({ id: z.string() }),
  },
  async execute(ctx, args) {
    // Explicit map — only declared keys are reachable. Unknown codes and
    // workflow-level codes are unreachable.
    throw ctx.errors.BranchOnly("declared", { id: args.id });
  },
});

export const haltModelAcceptanceWorkflow = defineWorkflow({
  name: "haltModelAcceptance",
  args: z.object({ id: z.string() }),
  errors: {
    WorkflowError: z.object({ id: z.string() }),
  },
  steps: { compensableStep },
  branches: {
    branchNone: branchNoErrors,
    branchAny: branchAnyErrors,
    branchExplicit: branchExplicitErrors,
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    // Workflow body — ctx.errors exposes the workflow's declared errors only.
    const declared = ctx.errors.WorkflowError("declared", { id: args.id });
    void declared;

    // @ts-expect-error workflow body cannot see branch-local error factories
    ctx.errors.BranchOnly("not visible", { id: args.id });

    // join() does not observe halt or skipped — only success and failure.
    const noneEntry = ctx.branches.branchNone({ id: args.id });
    const noneJoin = await ctx.join(noneEntry);
    type _JoinResultShape = Assert<
      IsEqual<typeof noneJoin, BranchJoinResult<{ ok: boolean }>>
    >;
    type _JoinHasNoHalted = Assert<
      Extract<typeof noneJoin, { status: "halted" }> extends never ? true : false
    >;
    type _JoinHasNoSkipped = Assert<
      Extract<typeof noneJoin, { status: "skipped" }> extends never ? true : false
    >;

    const explicitEntry = ctx.branches.branchExplicit({ id: args.id });
    const explicitJoin = await ctx.join(explicitEntry);
    type _ExplicitJoinHasNoHalted = Assert<
      Extract<typeof explicitJoin, { status: "halted" }> extends never
        ? true
        : false
    >;

    return { ok: true };
  },
});

void compensableStep;
