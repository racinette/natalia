import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
  registerRequestCompensationHandler,
} from "../workflow";
import type {
  CompensationId,
  CompensationInfo,
  RequestCompensationInfo,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// FIXTURES — non-compensable dependencies usable inside a compensation block.
// =============================================================================

const refundStep = defineStep({
  name: "compRefundStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ refundId: z.string() }),
  async execute(args, _opts) {
    return { refundId: `refund:${args.chargeId}` };
  },
});

const reconcileRequest = defineRequest({
  name: "compReconcileRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const undoChildHeader = defineWorkflowHeader({
  name: "compUndoChild",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ ok: z.boolean() }),
});

// =============================================================================
// STEP COMPENSATION DEFINITION — full Part 2 surface.
//
// Declares per-instance primitives (channels/streams/events/attributes),
// dependency keys (steps/requests/queues/topics/childWorkflows), and an
// optional `result` schema. The `undo` callback receives the original
// step args (decoded) and the forward outcome `info`.
// =============================================================================

const chargeStep = defineStep({
  name: "compChargeStep",
  args: z.object({ customerId: z.string(), amount: z.number() }),
  result: z.object({ chargeId: z.string(), amount: z.number() }),
  compensation: {
    // Per-instance primitives (declaration slots; full accessor surface lands
    // in steps 13/15/16).
    channels: { undoNotification: z.object({ note: z.string() }) },
    streams: { undoAudit: z.object({ entry: z.string() }) },
    events: { undoSettled: true },
    attributes: { undoProgress: z.object({ percent: z.number() }) },

    // Dependencies.
    steps: { refundStep },
    requests: { reconcileRequest },
    childWorkflows: { undoChild: undoChildHeader },

    // Outcome schema.
    result: z.object({
      status: z.enum(["refunded", "manual_review"]),
      refundId: z.string().optional(),
    }),

    async undo(ctx, args, info) {
      // ---------------------------------------------------------------------
      // Original step args are typed as `InferOutput<TArgs>`.
      // ---------------------------------------------------------------------
      type _Args = Assert<
        IsEqual<typeof args, { customerId: string; amount: number }>
      >;

      // ---------------------------------------------------------------------
      // Forward outcome info — discriminated on `status`.
      // ---------------------------------------------------------------------
      type _Info = Assert<
        typeof info extends CompensationInfo<{
          chargeId: string;
          amount: number;
        }>
          ? true
          : false
      >;

      if (info.status === "completed") {
        const refund = await ctx.steps.refundStep({
          chargeId: info.result.chargeId,
        });
        return { status: "refunded" as const, refundId: refund.refundId };
      }

      if (info.status === "timed_out") {
        type _Reason = Assert<
          IsEqual<typeof info.reason, "attempts_exhausted" | "deadline">
        >;
        // Timed-out forward outcomes do not expose a `result`.
        // @ts-expect-error timed-out forward outcomes do not expose a result
        void info.result;

        // `attempts` is still available — Part 2 says compensation must
        // inspect attempts when the engine never observed completion.
        await info.attempts.count();
      }

      if (info.status === "terminated") {
        // @ts-expect-error terminated forward outcomes do not expose a result
        void info.result;
        await info.attempts.last();
      }

      // ---------------------------------------------------------------------
      // Compensation context only sees its declared dependencies.
      // ---------------------------------------------------------------------

      // @ts-expect-error compensation undo has no `ctx.errors`
      void ctx.errors;

      // @ts-expect-error compensation undo cannot see workflow-only steps
      void ctx.steps.workflowOnlyStep;

      // @ts-expect-error compensation undo cannot see workflow-only requests
      void ctx.requests.workflowOnlyRequest;

      return { status: "manual_review" as const };
    },
  },
  async execute(args, _opts) {
    return { chargeId: `charge:${args.customerId}`, amount: args.amount };
  },
});

// =============================================================================
// COMPENSATION-ID BRAND — distinct per compensable step at the type level.
// =============================================================================

declare const _chargeCompensationId: CompensationId<typeof chargeStep>;

type _CompensationIdIsString = Assert<
  typeof _chargeCompensationId extends string ? true : false
>;

// Branded ids from different compensable steps are not interchangeable.
declare const _otherCompensableStep: typeof refundStep;
declare const _otherId: CompensationId<typeof _otherCompensableStep>;
type _BrandSeparation = Assert<
  IsEqual<typeof _chargeCompensationId, typeof _otherId> extends false
    ? true
    : false
>;

// =============================================================================
// DEPENDENCY FILTERING — compensation deps cannot themselves be compensable.
// =============================================================================

// @ts-expect-error compensation steps cannot themselves be compensable
defineStep({
  name: "compRecursiveCompensableStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    steps: { chargeStep },
    async undo() {},
  },
  async execute() {
    return { ok: true };
  },
});

// =============================================================================
// REQUEST COMPENSATION
//
// Declared on the request via `compensation: true | { result }`. The handler
// is registered separately via `registerRequestCompensationHandler` — there
// is no inline `undo` on `defineRequest`.
// =============================================================================

const approvalRequest = defineRequest({
  name: "compApprovalRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ approved: z.boolean() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
  },
});

const unregisterApprovalCompensation = registerRequestCompensationHandler(
  approvalRequest,
  async (payload, info, _opts) => {
    type _Payload = Assert<IsEqual<typeof payload, { chargeId: string }>>;
    type _Info = Assert<
      typeof info extends RequestCompensationInfo<{ approved: boolean }>
        ? true
        : false
    >;
    return { cancelled: info.status !== "completed" };
  },
  { retryPolicy: { timeoutSeconds: 30 } },
);
void unregisterApprovalCompensation;

// `compensation: true` — no result schema; handler returns void or throws
// `ctx.errors.X(...)` to enter manual mode.
const manualReviewRequest = defineRequest({
  name: "compManualReviewRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ accepted: z.boolean() }),
  compensation: {
    errors: {
      NeedsOperator: true,
    },
  },
});

const unregisterManualReviewCompensation = registerRequestCompensationHandler(
  manualReviewRequest,
  async (payload, info, ctx) => {
    type _Payload = Assert<IsEqual<typeof payload, { chargeId: string }>>;

    if (info.status === "completed") {
      type _Response = Assert<IsEqual<typeof info.response, { accepted: boolean }>>;
      return;
    }

    if (info.status === "timed_out") {
      type _Reason = Assert<
        IsEqual<typeof info.reason, "attempts_exhausted" | "deadline">
      >;
      // @ts-expect-error timed-out request outcomes do not expose a response
      void info.response;
    }

    throw ctx.errors.NeedsOperator("Operator must review compensation");
  },
  {
    retryPolicy: { timeoutSeconds: 30, totalTimeoutSeconds: 120 },
    onExhausted: {
      async callback(_payload, _info, ctx) {
        throw ctx.errors.NeedsOperator("Exhausted waiting for operator");
      },
    },
  },
);
void unregisterManualReviewCompensation;

// Inline `undo` on the request definition is rejected — handlers are
// registered separately.
defineRequest({
  name: "compInlineUndoRejected",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ ok: z.boolean() }),
  // @ts-expect-error compensation blocks do not accept inline undo callbacks
  compensation: {
    result: z.object({ undone: z.boolean() }),
    async undo() {
      return { undone: true };
    },
  },
});

// Non-compensable requests cannot have a compensation handler registered.
const nonCompensableRequest = defineRequest({
  name: "compNonCompensableRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

registerRequestCompensationHandler(
  // @ts-expect-error non-compensable requests cannot have compensation handlers
  nonCompensableRequest,
  async () => undefined,
  { retryPolicy: { timeoutSeconds: 30 } },
);

// Compensable requests cannot themselves be compensation dependencies.
// @ts-expect-error compensation requests cannot themselves be compensable
defineStep({
  name: "compRequestRecursiveCompensableStep",
  args: z.object({ chargeId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    requests: { approvalRequest },
    async undo() {},
  },
  async execute() {
    return { ok: true };
  },
});

// =============================================================================
// VOID-RESULT COMPENSATION
//
// When the compensation declares no `result` schema, the `undo` callback
// returns `void` and the compensation block instance's outcome is `void`.
// =============================================================================

const voidResultStep = defineStep({
  name: "compVoidResultStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    async undo(_ctx, _args, _info) {
      // No return value required.
    },
  },
  async execute() {
    return { ok: true };
  },
});
void voidResultStep;

// =============================================================================
// REMOVED WORKFLOW-LEVEL COMPENSATION SURFACES
// =============================================================================

const childWorkflow = defineWorkflow({
  name: "compChild",
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

export const compensationModelAcceptanceWorkflow = defineWorkflow({
  name: "compensationModelAcceptance",
  steps: { chargeStep },
  requests: { approvalRequest },
  childWorkflows: { childWorkflow },
  result: z.object({ ok: z.boolean() }),
  // @ts-expect-error workflow-level compensation hooks are removed
  async beforeCompensate() {},
  async execute(ctx) {
    const charge = await ctx.steps.chargeStep({
      customerId: "cust-1",
      amount: 10,
    });

    await ctx.requests.approvalRequest({ chargeId: charge.chargeId });

    const entry = ctx.steps.chargeStep({ customerId: "cust-2", amount: 20 });
    // @ts-expect-error compensation is definition-bound, not call-site-bound
    void entry.compensate(async () => undefined);
    // @ts-expect-error general ad hoc compensation registration is removed
    void ctx.addCompensation(async () => undefined);

    const child = ctx.childWorkflows.childWorkflow();
    // @ts-expect-error child compensation is no longer call-site-bound
    void child.compensate(async () => undefined);

    return { ok: true };
  },
});

// Introspection over compensation block instances (status, result, args,
// skip, findUnique by query, findMany, etc.) is verified in step 12.
