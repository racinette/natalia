import { z } from "zod";
import { defineStep, defineWorkflow } from "../workflow";
import type {
  CompensationBlockHaltStatus,
  CompensationBlockOperatorActions,
  ErrorFactories,
  HaltRecord,
  SigkillOutcome,
  SigtermOutcome,
  SkipOutcome,
  SkipStrategy,
  WorkflowHaltStatus,
  WorkflowOperatorActions,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";

// =============================================================================
// HALT STATUS UNIONS
//
// Two public type aliases reflect the operator-action discrimination:
//   - workflow halts are not skippable;
//   - compensation block halts are skippable per instance.
//
// At the storage layer there is one unified `halt` table (REFACTOR.MD Part 3
// + Part 8); the two aliases let operator handles type their action surface
// per workflow kind.
// =============================================================================

type _WorkflowHaltStatus = Assert<
  IsEqual<WorkflowHaltStatus, "pending" | "resolved">
>;
type _CompensationBlockHaltStatus = Assert<
  IsEqual<CompensationBlockHaltStatus, "pending" | "resolved" | "skipped">
>;

// =============================================================================
// HALT RECORD — durable row shape
// =============================================================================

declare const _haltRecord: HaltRecord;

type _HaltRecordHasIds = Assert<
  IsEqual<typeof _haltRecord.id, number>
>;
type _HaltRecordWorkflowId = Assert<
  IsEqual<typeof _haltRecord.workflowId, string>
>;
type _HaltRecordAfterStepId = Assert<
  IsEqual<typeof _haltRecord.afterStepId, number | null>
>;
type _HaltRecordStatusUnion = Assert<
  IsEqual<
    typeof _haltRecord.status,
    WorkflowHaltStatus | CompensationBlockHaltStatus
  >
>;
type _HaltRecordTimestamps = Assert<
  IsEqual<typeof _haltRecord.createdAt, Date>
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
  async execute(args, _opts) {
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
    type _Factories = Assert<
      typeof ctx.errors extends ErrorFactories<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ZodObject `Config` slot; matches z.object() default
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

// =============================================================================
// OPERATOR-ACTION VERB SIGNATURES — type-level shape contract
//
// Step 09 owns the *signature shapes* of `sigkill()`, `sigterm()`, and
// `skip(result, opts?)`. Step 12 plugs them onto concrete handles
// (`WorkflowHandleExternal`, `CompensationBlockUniqueHandle`).
// =============================================================================

declare const workflowActions: WorkflowOperatorActions<{ orderId: string }>;
declare const voidWorkflowActions: WorkflowOperatorActions<void>;
declare const compBlockActions: CompensationBlockOperatorActions<{
  kind: "refunded" | "manual";
}>;
declare const voidCompBlockActions: CompensationBlockOperatorActions<void>;

// `sigkill()` returns a SigkillOutcome; takes optional opts.
async function _exerciseSigkill(): Promise<void> {
  const _k1 = await workflowActions.sigkill(session);
  type _K1 = Assert<IsEqual<typeof _k1, SigkillOutcome>>;
  await workflowActions.sigkill(session);
}

// `sigterm()` returns a SigtermOutcome union (`completed` | `failed`).
async function _exerciseSigterm(): Promise<void> {
  const _t1 = await workflowActions.sigterm(session);
  type _T1 = Assert<IsEqual<typeof _t1, SigtermOutcome>>;
}

// `skip(result, opts?)` for non-void result requires the result argument.
async function _exerciseSkipWithResult(): Promise<void> {
  const _s1 = await workflowActions.skip(session, { orderId: "x" });
  type _S1 = Assert<IsEqual<typeof _s1, SkipOutcome>>;

  await workflowActions.skip(
    session,
    { orderId: "x" },
    { strategy: "sigterm" satisfies SkipStrategy },
  );

  await workflowActions.skip(
    session,
    { orderId: "x" },
    { strategy: "sigkill" satisfies SkipStrategy },
  );

  // @ts-expect-error result is required when the workflow's result schema is non-void
  await workflowActions.skip(session);

  // @ts-expect-error result must conform to the workflow's result schema
  await workflowActions.skip(session, { wrongShape: 1 });
}

// `skip(opts?)` for void result skips the result argument.
async function _exerciseSkipVoid(): Promise<void> {
  const _s1 = await voidWorkflowActions.skip(session);
  type _S1 = Assert<IsEqual<typeof _s1, SkipOutcome>>;

  await voidWorkflowActions.skip(session, { strategy: "sigkill" });
}

// Compensation block actions: `skip(result)` only; no strategy choice,
// no sigkill / sigterm.
async function _exerciseCompensationSkip(): Promise<void> {
  const _s1 = await compBlockActions.skip(session, { kind: "refunded" });
  type _S1 = Assert<IsEqual<typeof _s1, SkipOutcome>>;

  await compBlockActions.skip(session, { kind: "manual" });

  // Void compensation result accepts skip() with no args.
  await voidCompBlockActions.skip(session);

  // @ts-expect-error compensation blocks cannot be sigkill-ed
  void compBlockActions.sigkill;
  // @ts-expect-error compensation blocks cannot be sigterm-ed
  void compBlockActions.sigterm;
  // @ts-expect-error compensation skip has no strategy option
  await compBlockActions.skip(session, { kind: "refunded" }, { strategy: "sigkill" });
}

void _exerciseSigkill;
void _exerciseSigterm;
void _exerciseSkipWithResult;
void _exerciseSkipVoid;
void _exerciseCompensationSkip;
