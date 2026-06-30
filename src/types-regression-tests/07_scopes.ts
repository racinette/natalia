import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type { MatchEvent } from "../types";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// FIXTURES
// =============================================================================

const normalizeStep = defineStep({
  name: "scopesNormalizeStep",
  args: z.object({ orderId: z.string() }),
  result: z.object({ normalized: z.string() }),
  async execute(args, _opts) {
    return { normalized: args.orderId.toUpperCase() };
  },
});

const approvalRequest = defineRequest({
  name: "scopesApprovalRequest",
  payload: z.object({ orderId: z.string() }),
  response: z.object({ approved: z.boolean() }),
});

const followUpHeader = defineWorkflowHeader({
  name: "scopesFollowUp",
  args: z.object({ orderId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  channels: { notify: z.object({ msg: z.string() }) },
  errors: { FollowUpFailed: z.object({ orderId: z.string() }) },
});

// =============================================================================
// MAIN ACCEPTANCE WORKFLOW
// =============================================================================

export const scopesAcceptanceWorkflow = defineWorkflow({
  name: "scopesAcceptance",
  args: z.object({ orderId: z.string() }),
  steps: { normalize: normalizeStep },
  requests: { approval: approvalRequest },
  childWorkflows: { followUp: followUpHeader },
  externalWorkflows: { followUp: followUpHeader },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    // -------------------------------------------------------------------------
    // SCOPE INPUT IS A TOP-LEVEL OBJECT
    //
    // Properties may be a single entry, an array/tuple of entries, or a map
    // of entries. The body callback receives a typed mirror of that object
    // where each entry has been replaced with a handle.
    // -------------------------------------------------------------------------

    await ctx.scope(
      "FanOut",
      {
        normalize: ctx.steps.normalize({ orderId: args.orderId }),
        approval: ctx.requests.approval({ orderId: args.orderId }),
        followUp: ctx.childWorkflows.followUp({
          orderId: args.orderId,
        }),
      },
      async (scopeCtx, handles) => {
        handles.followUp.channels.notify.send({ msg: "from-scope" });
        // -----------------------------------------------------------------
        // ctx.join — observe a single handle.
        //
        // For a step entry without timeout, the result is the success type
        // directly. For a child workflow, it is the success-or-failure
        // union. With `{ timeout }`, an additional join_timeout variant is
        // introduced.
        // -----------------------------------------------------------------

        const _stepResult = await scopeCtx.join(handles.normalize);
        type _StepJoin = Assert<
          IsEqual<typeof _stepResult, { normalized: string }>
        >;

        const _requestResult = await scopeCtx.join(handles.approval);
        type _RequestJoin = Assert<
          IsEqual<typeof _requestResult, { approved: boolean }>
        >;

        const _childResult = await scopeCtx.join(handles.followUp);
        type _ChildJoinHasOkBranch = Assert<
          Extract<typeof _childResult, { ok: true; result: { ok: boolean } }> extends never
            ? false
            : true
        >;
        type _ChildJoinHasFailedBranch = Assert<
          Extract<typeof _childResult, { ok: false; status: "failed" }> extends never
            ? false
            : true
        >;
        // No "halted" or "skipped" variants observed by workflow code.
        type _ChildJoinHasNoHalted = Assert<
          Extract<typeof _childResult, { status: "halted" }> extends never
            ? true
            : false
        >;
        type _ChildJoinHasNoSkipped = Assert<
          Extract<typeof _childResult, { status: "skipped" }> extends never
            ? true
            : false
        >;

        // Observation timeout adds a `join_timeout` failure variant. It does
        // NOT cancel the underlying work; the entry can be joined again later.
        const _observedChild = await scopeCtx.join(handles.followUp, {
          timeout: 5,
        });
        type _ObservedChildHasJoinTimeout = Assert<
          Extract<typeof _observedChild, { status: "join_timeout" }> extends never
            ? false
            : true
        >;

        return undefined;
      },
    );

    // -------------------------------------------------------------------------
    // INLINE CLOSURES ARE NOT SCOPE ENTRIES
    // -------------------------------------------------------------------------

    // @ts-expect-error inline closures are not scope entries
    await ctx.scope(
      "InlineRejected",
      { bad: async () => ({ ok: true }) },
      async () => undefined,
    );

    // -------------------------------------------------------------------------
    // DETACHED CHILD WORKFLOW STARTS ARE NOT SCOPE ENTRIES
    //
    // Detached child call mode is a buffered op that returns a `ExternalWorkflowHandle`
    // synchronously; it is not joinable from the parent and not a valid
    // scope entry.
    // -------------------------------------------------------------------------

    const detached = ctx.externalWorkflows.followUp.start(
      { orderId: args.orderId },
      { idempotencyKey: "f-detached-1" },
    );
    // @ts-expect-error external workflow handles are not scope entries
    await ctx.scope(
      "DetachedRejected",
      { detached },
      async () => undefined,
    );

    // -------------------------------------------------------------------------
    // ARRAY / TUPLE PROPERTIES — match events carry `index`.
    // -------------------------------------------------------------------------

    await ctx.scope(
      "TupleScope",
      {
        quotes: [
          ctx.steps.normalize({ orderId: "a" }),
          ctx.steps.normalize({ orderId: "b" }),
        ],
      },
      async (scopeCtx, handles) => {
        // The handle for an array property is an array of handles.
        const _first = await scopeCtx.join(handles.quotes[0]);
        type _FirstJoin = Assert<
          IsEqual<typeof _first, { normalized: string }>
        >;

        // ctx.match yields events keyed by top-level property; tuple
        // properties add `index`.
        for await (const _event of scopeCtx.match(handles)) {
          type _TupleMatchEvent = Assert<
            (typeof _event)["key"] extends "quotes" ? true : false
          >;
          type _TupleMatchHasIndex = Assert<
            "index" extends keyof typeof _event ? true : false
          >;
        }

        return undefined;
      },
    );

    // -------------------------------------------------------------------------
    // MAP PROPERTIES — match events carry `mapKey`.
    // -------------------------------------------------------------------------

    const mapEntries = new Map<"east" | "west", ReturnType<typeof ctx.steps.normalize>>([
      ["east", ctx.steps.normalize({ orderId: "east" })],
      ["west", ctx.steps.normalize({ orderId: "west" })],
    ]);

    await ctx.scope(
      "MapScope",
      { regions: mapEntries },
      async (scopeCtx, handles) => {
        // The handle for a map property is a map of handles.
        const east = handles.regions.get("east");
        if (east) {
          const _eastResult = await scopeCtx.join(east);
          type _MapJoin = Assert<IsEqual<typeof _eastResult, { normalized: string }>>;
        }

        for await (const _event of scopeCtx.match(handles)) {
          type _MapMatchEvent = Assert<
            (typeof _event)["key"] extends "regions" ? true : false
          >;
          type _MapMatchHasMapKey = Assert<
            "mapKey" extends keyof typeof _event ? true : false
          >;
        }

        return undefined;
      },
    );

    // -------------------------------------------------------------------------
    // MATCH RETURNS A KEYED { key, result } UNION (NO HANDLER FORMS)
    // -------------------------------------------------------------------------

    await ctx.scope(
      "MatchKeyed",
      {
        normalize: ctx.steps.normalize({ orderId: args.orderId }),
        approval: ctx.requests.approval({ orderId: args.orderId }),
      },
      async (scopeCtx, handles) => {
        for await (const event of scopeCtx.match(handles)) {
          type _MatchEventShape = Assert<
            typeof event extends MatchEvent<infer _K, infer _R> ? true : false
          >;

          if (event.key === "normalize") {
            type _MatchNormalize = Assert<
              IsEqual<typeof event.result, { normalized: string }>
            >;
          }
          if (event.key === "approval") {
            type _MatchApproval = Assert<
              IsEqual<typeof event.result, { approved: boolean }>
            >;
          }
        }

        // Handler-form `match` is removed (Part 7).
        // @ts-expect-error scope match no longer accepts handler maps
        void scopeCtx.match(handles, { normalize: () => 1 });

        return undefined;
      },
    );

    // -------------------------------------------------------------------------
    // CONVENIENCE HELPERS — `all`, `first`, `atLeast`, `atMost`, `some`
    //
    // Each accepts an explicit scope name as its first argument. They are
    // success-oriented and return helper-level `code` errors when failure
    // is structurally possible.
    // -------------------------------------------------------------------------

    // `all` — wait for all entries to succeed; preserve input shape.
    const allResult = await ctx.all("AllScope", {
      normalize: ctx.steps.normalize({ orderId: args.orderId }),
      approval: ctx.requests.approval({ orderId: args.orderId }),
    });
    if (allResult.ok) {
      type _AllResult = Assert<
        IsEqual<
          typeof allResult.result,
          { normalize: { normalized: string }; approval: { approved: boolean } }
        >
      >;
    } else {
      type _AllErrorCode = Assert<
        IsEqual<typeof allResult.error.code, "SomeEntriesFailed">
      >;
    }

    // `first` — return the first entry to complete.
    const firstResult = await ctx.first("FirstScope", {
      a: ctx.steps.normalize({ orderId: "a" }),
      b: ctx.steps.normalize({ orderId: "b" }),
    });
    if (firstResult.ok) {
      type _FirstHasKey = Assert<"key" extends keyof typeof firstResult.result ? true : false>;
    } else {
      type _FirstErrorCode = Assert<
        IsEqual<typeof firstResult.error.code, "NoEntryCompleted">
      >;
    }

    // `atLeast` — wait until at least N entries succeed.
    const atLeastResult = await ctx.atLeast("AtLeastScope", 2, {
      a: ctx.steps.normalize({ orderId: "a" }),
      b: ctx.steps.normalize({ orderId: "b" }),
      c: ctx.steps.normalize({ orderId: "c" }),
    });
    if (atLeastResult.ok) {
      type _AtLeastReturnsArray = Assert<
        typeof atLeastResult.result extends readonly unknown[] ? true : false
      >;
    } else {
      type _AtLeastErrorCode = Assert<
        IsEqual<typeof atLeastResult.error.code, "QuorumNotMet">
      >;
    }

    // `atMost` — return up to N successful entries; no failure case.
    const _atMostResult = await ctx.atMost("AtMostScope", 2, {
      a: ctx.steps.normalize({ orderId: "a" }),
      b: ctx.steps.normalize({ orderId: "b" }),
      c: ctx.steps.normalize({ orderId: "c" }),
    });
    type _AtMostNoFailure = Assert<
      typeof _atMostResult extends readonly unknown[] ? true : false
    >;

    // `some` — return as many successful entries as possible; no failure case.
    const _someResult = await ctx.some("SomeScope", {
      a: ctx.steps.normalize({ orderId: "a" }),
      b: ctx.steps.normalize({ orderId: "b" }),
    });
    type _SomeNoFailure = Assert<
      typeof _someResult extends readonly unknown[] ? true : false
    >;

    return { ok: true };
  },
});

// =============================================================================
// REMOVED PUBLIC NAMES — branch / virtual-event-loop carry-overs.
// =============================================================================

// @ts-expect-error BranchEntry was removed (branches dissolved)
import type { BranchEntry as _RemovedBranchEntry } from "../types";
// @ts-expect-error BranchHandle was removed
import type { BranchHandle as _RemovedBranchHandle } from "../types";
// @ts-expect-error BranchAccessor was removed
import type { BranchAccessor as _RemovedBranchAccessor } from "../types";
// @ts-expect-error MAIN_BRANCH symbol was removed
import { MAIN_BRANCH as _RemovedMainBranch } from "../types";
// @ts-expect-error SomeBranchesFailed renamed to SomeEntriesFailed
import type { SomeBranchesFailed as _RemovedSomeBranchesFailed } from "../types";
// @ts-expect-error NoBranchCompleted renamed to NoEntryCompleted
import type { NoBranchCompleted as _RemovedNoBranchCompleted } from "../types";
