import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type { MatchEvent } from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// FIXTURES
// =============================================================================

const normalizeStep = defineStep({
  name: "scopesNormalizeStep",
  args: z.object({ orderId: z.string() }),
  result: z.object({ normalized: z.string() }),
  async execute(_ctx, args) {
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
          idempotencyKey: "f-1",
          args: { orderId: args.orderId },
        }),
      },
      async (scopeCtx, handles) => {
        // -----------------------------------------------------------------
        // ctx.join — observe a single handle.
        //
        // For a step entry without timeout, the result is the success type
        // directly. For a child workflow, it is the success-or-failure
        // union. With `{ timeout }`, an additional join_timeout variant is
        // introduced.
        // -----------------------------------------------------------------

        const stepResult = await scopeCtx.join(handles.normalize);
        type _StepJoin = Assert<
          IsEqual<typeof stepResult, { normalized: string }>
        >;

        const requestResult = await scopeCtx.join(handles.approval);
        type _RequestJoin = Assert<
          IsEqual<typeof requestResult, { approved: boolean }>
        >;

        const childResult = await scopeCtx.join(handles.followUp);
        type _ChildJoinHasOkBranch = Assert<
          Extract<typeof childResult, { ok: true; result: { ok: boolean } }> extends never
            ? false
            : true
        >;
        type _ChildJoinHasFailedBranch = Assert<
          Extract<typeof childResult, { ok: false; status: "failed" }> extends never
            ? false
            : true
        >;
        // No "halted" or "skipped" variants observed by workflow code.
        type _ChildJoinHasNoHalted = Assert<
          Extract<typeof childResult, { status: "halted" }> extends never
            ? true
            : false
        >;
        type _ChildJoinHasNoSkipped = Assert<
          Extract<typeof childResult, { status: "skipped" }> extends never
            ? true
            : false
        >;

        // Observation timeout adds a `join_timeout` failure variant. It does
        // NOT cancel the underlying work; the entry can be joined again later.
        const observedChild = await scopeCtx.join(handles.followUp, {
          timeout: 5,
        });
        type _ObservedChildHasJoinTimeout = Assert<
          Extract<typeof observedChild, { status: "join_timeout" }> extends never
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
    // `startDetached` is a buffered op that returns a `ForeignWorkflowHandle`
    // synchronously; it is not joinable from the parent and not a valid
    // scope entry.
    // -------------------------------------------------------------------------

    const detached = ctx.childWorkflows.followUp.startDetached({
      idempotencyKey: "f-detached-1",
      args: { orderId: args.orderId },
    });
    // @ts-expect-error detached child handles are not scope entries
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
        const first = await scopeCtx.join(handles.quotes[0]);
        type _FirstJoin = Assert<
          IsEqual<typeof first, { normalized: string }>
        >;

        // ctx.match yields events keyed by top-level property; tuple
        // properties add `index`.
        for await (const event of scopeCtx.match(handles)) {
          type _TupleMatchEvent = Assert<
            (typeof event)["key"] extends "quotes" ? true : false
          >;
          type _TupleMatchHasIndex = Assert<
            "index" extends keyof typeof event ? true : false
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
          const eastResult = await scopeCtx.join(east);
          type _MapJoin = Assert<IsEqual<typeof eastResult, { normalized: string }>>;
        }

        for await (const event of scopeCtx.match(handles)) {
          type _MapMatchEvent = Assert<
            (typeof event)["key"] extends "regions" ? true : false
          >;
          type _MapMatchHasMapKey = Assert<
            "mapKey" extends keyof typeof event ? true : false
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
            typeof event extends MatchEvent<any, any> ? true : false
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
        scopeCtx.match(handles, { normalize: () => 1 });

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
    const atMostResult = await ctx.atMost("AtMostScope", 2, {
      a: ctx.steps.normalize({ orderId: "a" }),
      b: ctx.steps.normalize({ orderId: "b" }),
      c: ctx.steps.normalize({ orderId: "c" }),
    });
    type _AtMostNoFailure = Assert<
      typeof atMostResult extends readonly unknown[] ? true : false
    >;

    // `some` — return as many successful entries as possible; no failure case.
    const someResult = await ctx.some("SomeScope", {
      a: ctx.steps.normalize({ orderId: "a" }),
      b: ctx.steps.normalize({ orderId: "b" }),
    });
    type _SomeNoFailure = Assert<
      typeof someResult extends readonly unknown[] ? true : false
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
