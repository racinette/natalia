import { z } from "zod";
import {
  defineBranch,
  defineRequest,
  defineStep,
  defineWorkflow,
} from "../workflow";
import type { BranchInstanceStatus, MatchEvent } from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const quoteBranch = defineBranch({
  name: "quoteBranch",
  args: z.object({ provider: z.string() }),
  result: z.object({ provider: z.string(), price: z.number() }),
  async execute(_ctx, args) {
    return { provider: args.provider, price: 100 };
  },
});

const fraudBranch = defineBranch({
  name: "fraudBranch",
  args: z.object({ orderId: z.string() }),
  result: z.object({ score: z.number() }),
  errors: { FraudServiceDown: z.object({ orderId: z.string() }) },
  async execute(_ctx, args) {
    return { score: args.orderId.length };
  },
});

const normalizeStep = defineStep({
  name: "normalizeStep",
  args: z.object({ orderId: z.string() }),
  result: z.object({ normalized: z.string() }),
  async execute(_ctx, args) {
    return { normalized: args.orderId.toUpperCase() };
  },
});

const approvalRequest = defineRequest({
  name: "approvalRequest",
  payload: z.object({ orderId: z.string() }),
  response: z.object({ approved: z.boolean() }),
});

const followUpWorkflow = defineWorkflow({
  name: "branchesAndScopesFollowUp",
  args: z.object({ orderId: z.string() }),
  errors: { FollowUpFailed: z.object({ orderId: z.string() }) },
  result: z.object({ ok: z.boolean() }),
  async execute(_ctx, _args) {
    return { ok: true };
  },
});

export const branchesAndScopesAcceptanceWorkflow = defineWorkflow({
  name: "branchesAndScopesAcceptance",
  args: z.object({ orderId: z.string() }),
  steps: {
    normalize: normalizeStep,
  },
  requests: {
    approval: approvalRequest,
  },
  childWorkflows: {
    followUp: followUpWorkflow,
  },
  branches: {
    quote: quoteBranch,
    fraud: fraudBranch,
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    const quote = ctx.branches.quote({ provider: "alpha" });
    type _BranchNoAny = Assert<
      IsAny<typeof quote> extends false ? true : false
    >;

    // @ts-expect-error branch args are schema-checked
    ctx.branches.quote({ provider: 123 });
    // @ts-expect-error inline branch closures are no longer scope entries
    await ctx.scope(
      "InlineRejected",
      { bad: async () => ({ ok: true }) },
      async () => undefined,
    );

    const detached = ctx.childWorkflows.followUp.startDetached({
      args: { orderId: args.orderId },
    });
    // @ts-expect-error detached child workflow starts are buffered operations, not scope entries
    await ctx.scope("DetachedRejected", { detached }, async () => undefined);

    const scopedObject = await ctx.scope(
      "ObjectScope",
      {
        quote: ctx.branches.quote({ provider: "alpha" }),
        fraud: ctx.branches.fraud({ orderId: args.orderId }),
      },
      async (scopeCtx, branches) => {
        const quoteResult = await scopeCtx.join(branches.quote);
        type _QuoteJoin = Assert<
          IsEqual<
            typeof quoteResult,
            | { ok: true; result: { provider: string; price: number } }
            | { ok: false; status: "failed"; error: unknown }
          >
        >;

        const timedFraud = await scopeCtx.join(branches.fraud, { timeout: 5 });
        type _TimedJoinAddsTimeout = Assert<
          IsEqual<
            typeof timedFraud,
            | { ok: true; result: { score: number } }
            | { ok: false; status: "failed"; error: unknown }
            | { ok: false; status: "join_timeout" }
          >
        >;

        for await (const event of scopeCtx.match(branches)) {
          type _MatchEvent = Assert<
            IsEqual<
              typeof event,
              | MatchEvent<"quote", { provider: string; price: number }>
              | MatchEvent<"fraud", { score: number }>
            >
          >;
          break;
        }

        // @ts-expect-error match no longer accepts handler overloads
        scopeCtx.match(branches, { quote: (value: unknown) => value });

        return quoteResult.ok;
      },
    );

    // @ts-expect-error scope inputs must keep a top-level object shape
    await ctx.scope(
      "TopLevelTupleRejected",
      [ctx.branches.quote({ provider: "tuple" })],
      async () => true,
    );

    const mapEntries = new Map([
      ["a", ctx.branches.quote({ provider: "map-a" })],
      ["b", ctx.branches.quote({ provider: "map-b" })],
    ] as const);
    // @ts-expect-error scope inputs must keep a top-level object shape
    await ctx.scope("TopLevelMapRejected", mapEntries, async () => true);

    const scopedTuple = await ctx.scope(
      "TupleScope",
      {
        quotes: [
          ctx.branches.quote({ provider: "tuple-a" }),
          ctx.branches.quote({ provider: "tuple-b" }),
        ] as const,
      },
      async (scopeCtx, branches) => {
        await scopeCtx.join(branches.quotes[0]);

        for await (const event of scopeCtx.match(branches)) {
          type _TupleEvent = Assert<
            IsEqual<
              typeof event,
              MatchEvent<"quotes", { provider: string; price: number }> & {
                index: 0 | 1;
              }
            >
          >;
          break;
        }
        return true;
      },
    );

    const scopedMap = await ctx.scope(
      "MapScope",
      { quotesByProvider: mapEntries },
      async (scopeCtx, branches) => {
        const quoteA = branches.quotesByProvider.get("a");
        if (quoteA) {
          await scopeCtx.join(quoteA);
        }

        for await (const event of scopeCtx.match(branches)) {
          type _MapEvent = Assert<
            IsEqual<
              typeof event,
              MatchEvent<
                "quotesByProvider",
                { provider: string; price: number }
              > & {
                mapKey: "a" | "b";
              }
            >
          >;
          break;
        }
        return true;
      },
    );

    type ChildJoinResult =
      | { ok: true; result: { ok: boolean } }
      | {
          ok: false;
          status: "failed";
          error: {
            readonly code: "FollowUpFailed";
            readonly message: string;
            readonly details: { orderId: string };
          };
        };
    type BranchQuoteJoinResult =
      | { ok: true; result: { provider: string; price: number } }
      | { ok: false; status: "failed"; error: unknown };
    type TimeoutFailure = { ok: false; status: "timeout" };
    type JoinTimeoutFailure = { ok: false; status: "join_timeout" };
    type StepTimeoutJoinResult =
      | { ok: true; result: { normalized: string } }
      | TimeoutFailure;
    type RequestTimeoutJoinResult =
      | { ok: true; result: { approved: boolean } }
      | TimeoutFailure;
    type ChildTimedJoinResult = ChildJoinResult | TimeoutFailure;
    type MixedEntryJoinResult =
      | { normalized: string }
      | { approved: boolean }
      | ChildJoinResult
      | BranchQuoteJoinResult;
    type MixedEntrySuccess =
      | { normalized: string }
      | { approved: boolean }
      | { ok: boolean }
      | { provider: string; price: number };
    type ChildFailure = Extract<ChildJoinResult, { ok: false }>;
    type BranchFailure = Extract<BranchQuoteJoinResult, { ok: false }>;
    type EntryFamilyKeyedSuccess =
      | { key: "step"; value: { normalized: string } }
      | { key: "request"; value: { approved: boolean } }
      | { key: "child"; value: { ok: boolean } }
      | { key: "branch"; value: { provider: string; price: number } }
      | { key: "mixedTuple"; index: 0; value: { normalized: string } }
      | { key: "mixedTuple"; index: 1; value: { approved: boolean } }
      | { key: "mixedTuple"; index: 2; value: { ok: boolean } }
      | {
          key: "mixedTuple";
          index: 3;
          value: { provider: string; price: number };
        }
      | {
          key: "mixedMap";
          mapKey: "step" | "request" | "child" | "branch";
          value: MixedEntrySuccess;
        };
    type EntryFamilyKeyedFailure =
      | { key: "child"; error: ChildFailure }
      | { key: "branch"; error: BranchFailure }
      | { key: "mixedTuple"; index: 2; error: ChildFailure }
      | { key: "mixedTuple"; index: 3; error: BranchFailure }
      | {
          key: "mixedMap";
          mapKey: "step" | "request" | "child" | "branch";
          error: ChildFailure;
        }
      | {
          key: "mixedMap";
          mapKey: "step" | "request" | "child" | "branch";
          error: BranchFailure;
        };
    type IndividualEntryKeyedSuccess =
      | { key: "step"; value: { normalized: string } }
      | { key: "timedStep"; value: { normalized: string } }
      | { key: "request"; value: { approved: boolean } }
      | { key: "timedRequest"; value: { approved: boolean } }
      | { key: "child"; value: { ok: boolean } }
      | { key: "timedChild"; value: { ok: boolean } };
    type IndividualEntryKeyedFailure =
      | { key: "timedStep"; error: TimeoutFailure }
      | { key: "timedRequest"; error: TimeoutFailure }
      | { key: "child"; error: ChildFailure }
      | { key: "timedChild"; error: ChildFailure | TimeoutFailure };

    const scopedIndividualEntries = await ctx.scope(
      "IndividualEntryScope",
      {
        step: ctx.steps.normalize({ orderId: args.orderId }),
        timedStep: ctx.steps.normalize(
          { orderId: args.orderId },
          { timeout: 5 },
        ),
        request: ctx.requests.approval({ orderId: args.orderId }),
        timedRequest: ctx.requests.approval(
          { orderId: args.orderId },
          { timeout: 5 },
        ),
        child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
        timedChild: ctx.childWorkflows.followUp(
          { args: { orderId: args.orderId } },
          { timeout: 5 },
        ),
      },
      async (scopeCtx, entries) => {
        const stepResult = await scopeCtx.join(entries.step);
        type _IndividualStepJoin = Assert<
          IsEqual<typeof stepResult, { normalized: string }>
        >;

        const timedStepResult = await scopeCtx.join(entries.timedStep);
        type _IndividualTimedStepJoin = Assert<
          IsEqual<typeof timedStepResult, StepTimeoutJoinResult>
        >;

        const observedTimedStep = await scopeCtx.join(entries.timedStep, {
          timeout: 5,
        });
        type _IndividualTimedStepObservedJoin = Assert<
          IsEqual<
            typeof observedTimedStep,
            StepTimeoutJoinResult | JoinTimeoutFailure
          >
        >;

        const requestResult = await scopeCtx.join(entries.request);
        type _IndividualRequestJoin = Assert<
          IsEqual<typeof requestResult, { approved: boolean }>
        >;

        const timedRequestResult = await scopeCtx.join(entries.timedRequest);
        type _IndividualTimedRequestJoin = Assert<
          IsEqual<typeof timedRequestResult, RequestTimeoutJoinResult>
        >;

        const observedTimedRequest = await scopeCtx.join(entries.timedRequest, {
          timeout: 5,
        });
        type _IndividualTimedRequestObservedJoin = Assert<
          IsEqual<
            typeof observedTimedRequest,
            RequestTimeoutJoinResult | JoinTimeoutFailure
          >
        >;

        const childResult = await scopeCtx.join(entries.child);
        type _IndividualChildJoin = Assert<
          IsEqual<typeof childResult, ChildJoinResult>
        >;

        const timedChildResult = await scopeCtx.join(entries.timedChild);
        type _IndividualTimedChildJoin = Assert<
          IsEqual<typeof timedChildResult, ChildTimedJoinResult>
        >;

        const observedTimedChild = await scopeCtx.join(entries.timedChild, {
          timeout: 5,
        });
        type _IndividualTimedChildObservedJoin = Assert<
          IsEqual<
            typeof observedTimedChild,
            ChildTimedJoinResult | JoinTimeoutFailure
          >
        >;

        for await (const event of scopeCtx.match(entries)) {
          type _IndividualEntryMatch = Assert<
            IsEqual<
              typeof event,
              | MatchEvent<"step", { normalized: string }>
              | MatchEvent<"timedStep", { normalized: string }>
              | MatchEvent<"request", { approved: boolean }>
              | MatchEvent<"timedRequest", { approved: boolean }>
              | MatchEvent<"child", { ok: boolean }>
              | MatchEvent<"timedChild", { ok: boolean }>
            >
          >;
          break;
        }

        return true;
      },
    );

    const individualAll = await ctx.all("IndividualEntryAll", {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      timedStep: ctx.steps.normalize(
        { orderId: args.orderId },
        { timeout: 5 },
      ),
      request: ctx.requests.approval({ orderId: args.orderId }),
      timedRequest: ctx.requests.approval(
        { orderId: args.orderId },
        { timeout: 5 },
      ),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      timedChild: ctx.childWorkflows.followUp(
        { args: { orderId: args.orderId } },
        { timeout: 5 },
      ),
    });
    type IndividualAllSuccess = Extract<typeof individualAll, { ok: true }>["result"];
    type IndividualAllError = Extract<typeof individualAll, { ok: false }>["error"];
    type _IndividualAllSuccess = Assert<
      IsEqual<
        IndividualAllSuccess,
        {
          step: { normalized: string };
          timedStep: { normalized: string };
          request: { approved: boolean };
          timedRequest: { approved: boolean };
          child: { ok: boolean };
          timedChild: { ok: boolean };
        }
      >
    >;
    type _IndividualAllError = Assert<
      IsEqual<
        IndividualAllError,
        {
          readonly code: "SomeBranchesFailed";
          readonly message: string;
          readonly details: {
            readonly failures: IndividualEntryKeyedFailure[];
            readonly completed: IndividualEntryKeyedSuccess[];
          };
        }
      >
    >;

    const individualAtLeast = await ctx.atLeast("IndividualEntryAtLeast", 3, {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      timedStep: ctx.steps.normalize(
        { orderId: args.orderId },
        { timeout: 5 },
      ),
      request: ctx.requests.approval({ orderId: args.orderId }),
      timedRequest: ctx.requests.approval(
        { orderId: args.orderId },
        { timeout: 5 },
      ),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      timedChild: ctx.childWorkflows.followUp(
        { args: { orderId: args.orderId } },
        { timeout: 5 },
      ),
    });
    type _IndividualAtLeastResult = Assert<
      IsEqual<
        typeof individualAtLeast,
        | { ok: true; result: IndividualEntryKeyedSuccess[] }
        | {
            ok: false;
            error: {
              readonly code: "QuorumNotMet";
              readonly message: string;
              readonly details: {
                readonly required: number;
                readonly got: number;
                readonly failures: IndividualEntryKeyedFailure[];
                readonly completed: IndividualEntryKeyedSuccess[];
              };
            };
          }
      >
    >;

    const individualSome = await ctx.some("IndividualEntrySome", {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      timedStep: ctx.steps.normalize(
        { orderId: args.orderId },
        { timeout: 5 },
      ),
      request: ctx.requests.approval({ orderId: args.orderId }),
      timedRequest: ctx.requests.approval(
        { orderId: args.orderId },
        { timeout: 5 },
      ),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      timedChild: ctx.childWorkflows.followUp(
        { args: { orderId: args.orderId } },
        { timeout: 5 },
      ),
    });
    type _IndividualSomeResult = Assert<
      IsEqual<typeof individualSome, IndividualEntryKeyedSuccess[]>
    >;

    const mixedMapStep = ctx.steps.normalize({ orderId: args.orderId });
    const mixedMapRequest = ctx.requests.approval({ orderId: args.orderId });
    const mixedMapChild = ctx.childWorkflows.followUp({
      args: { orderId: args.orderId },
    });
    const mixedMapBranch = ctx.branches.quote({ provider: "mixed-map" });
    const mixedEntryMap = new Map<
      "step" | "request" | "child" | "branch",
      | typeof mixedMapStep
      | typeof mixedMapRequest
      | typeof mixedMapChild
      | typeof mixedMapBranch
    >([
      ["step", mixedMapStep],
      ["request", mixedMapRequest],
      ["child", mixedMapChild],
      ["branch", mixedMapBranch],
    ]);

    const scopedEntryFamily = await ctx.scope(
      "EntryFamilyScope",
      {
        step: ctx.steps.normalize({ orderId: args.orderId }),
        request: ctx.requests.approval({ orderId: args.orderId }),
        child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
        branch: ctx.branches.quote({ provider: "single-branch" }),
        mixedTuple: [
          ctx.steps.normalize({ orderId: args.orderId }),
          ctx.requests.approval({ orderId: args.orderId }),
          ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
          ctx.branches.quote({ provider: "mixed-tuple" }),
        ] as const,
        mixedMap: mixedEntryMap,
      },
      async (scopeCtx, entries) => {
        const stepResult = await scopeCtx.join(entries.step);
        type _StepEntryJoin = Assert<
          IsEqual<typeof stepResult, { normalized: string }>
        >;

        const requestResult = await scopeCtx.join(entries.request);
        type _RequestEntryJoin = Assert<
          IsEqual<typeof requestResult, { approved: boolean }>
        >;

        const childResult = await scopeCtx.join(entries.child);
        type _ChildEntryJoin = Assert<
          IsEqual<typeof childResult, ChildJoinResult>
        >;

        const branchResult = await scopeCtx.join(entries.branch);
        type _BranchEntryJoin = Assert<
          IsEqual<typeof branchResult, BranchQuoteJoinResult>
        >;

        const tupleStep = await scopeCtx.join(entries.mixedTuple[0]);
        type _TupleStepJoin = Assert<
          IsEqual<typeof tupleStep, { normalized: string }>
        >;

        const tupleRequest = await scopeCtx.join(entries.mixedTuple[1]);
        type _TupleRequestJoin = Assert<
          IsEqual<typeof tupleRequest, { approved: boolean }>
        >;

        const tupleChild = await scopeCtx.join(entries.mixedTuple[2]);
        type _TupleChildJoin = Assert<
          IsEqual<typeof tupleChild, ChildJoinResult>
        >;

        const tupleBranch = await scopeCtx.join(entries.mixedTuple[3]);
        type _TupleBranchJoin = Assert<
          IsEqual<typeof tupleBranch, BranchQuoteJoinResult>
        >;

        const mapEntry = entries.mixedMap.get("step");
        if (mapEntry) {
          const mapResult = await scopeCtx.join(mapEntry);
          type _MapEntryJoin = Assert<
            IsEqual<typeof mapResult, MixedEntryJoinResult>
          >;
        }

        for await (const event of scopeCtx.match(entries)) {
          type _EntryFamilyMatch = Assert<
            IsEqual<
              typeof event,
              | MatchEvent<"step", { normalized: string }>
              | MatchEvent<"request", { approved: boolean }>
              | MatchEvent<"child", { ok: boolean }>
              | MatchEvent<"branch", { provider: string; price: number }>
              | (MatchEvent<"mixedTuple", MixedEntrySuccess> & {
                  index: 0 | 1 | 2 | 3;
                })
              | (MatchEvent<"mixedMap", MixedEntrySuccess> & {
                  mapKey: "step" | "request" | "child" | "branch";
                })
            >
          >;
          break;
        }

        return true;
      },
    );

    const entryFamilyAll = await ctx.all("EntryFamilyAll", {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      request: ctx.requests.approval({ orderId: args.orderId }),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      branch: ctx.branches.quote({ provider: "all-entry-family" }),
      mixedTuple: [
        ctx.steps.normalize({ orderId: args.orderId }),
        ctx.requests.approval({ orderId: args.orderId }),
        ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
        ctx.branches.quote({ provider: "all-mixed-tuple" }),
      ] as const,
      mixedMap: mixedEntryMap,
    });
    type EntryFamilyAllSuccess = Extract<
      typeof entryFamilyAll,
      { ok: true }
    >["result"];
    type EntryFamilyAllError = Extract<
      typeof entryFamilyAll,
      { ok: false }
    >["error"];
    type _AllStepEntry = Assert<
      IsEqual<EntryFamilyAllSuccess["step"], { normalized: string }>
    >;
    type _AllRequestEntry = Assert<
      IsEqual<EntryFamilyAllSuccess["request"], { approved: boolean }>
    >;
    type _AllChildEntry = Assert<
      IsEqual<EntryFamilyAllSuccess["child"], { ok: boolean }>
    >;
    type _AllBranchEntry = Assert<
      IsEqual<
        EntryFamilyAllSuccess["branch"],
        { provider: string; price: number }
      >
    >;
    type _AllTupleEntries = Assert<
      IsEqual<
        EntryFamilyAllSuccess["mixedTuple"],
        readonly [
          { normalized: string },
          { approved: boolean },
          { ok: boolean },
          { provider: string; price: number },
        ]
      >
    >;
    type _AllMapEntry = Assert<
      IsEqual<
        NonNullable<ReturnType<EntryFamilyAllSuccess["mixedMap"]["get"]>>,
        MixedEntrySuccess
      >
    >;
    type _AllErrorShape = Assert<
      IsEqual<
        EntryFamilyAllError,
        {
          readonly code: "SomeBranchesFailed";
          readonly message: string;
          readonly details: {
            readonly failures: EntryFamilyKeyedFailure[];
            readonly completed: EntryFamilyKeyedSuccess[];
          };
        }
      >
    >;

    // @ts-expect-error convenience scopes must be named
    await ctx.all({
      quote: ctx.branches.quote({ provider: "unnamed-all" }),
    });

    const all = await ctx.all("AllQuotes", {
      quote: ctx.branches.quote({ provider: "all" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    type _AllResult = Assert<
      IsEqual<
        typeof all,
        | {
            ok: true;
            result: {
              quote: { provider: string; price: number };
              fraud: { score: number };
            };
          }
        | {
            ok: false;
            error: {
              readonly code: "SomeBranchesFailed";
              readonly message: string;
              readonly details: {
                readonly failures: (
                  | { key: "quote"; error: BranchFailure }
                  | { key: "fraud"; error: BranchFailure }
                )[];
                readonly completed: (
                  | { key: "quote"; value: { provider: string; price: number } }
                  | { key: "fraud"; value: { score: number } }
                )[];
              };
            };
          }
      >
    >;

    const first = await ctx.first("FirstQuote", {
      quote: ctx.branches.quote({ provider: "first" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    type _FirstResult = Assert<
      IsEqual<
        typeof first,
        | {
            ok: true;
            result:
              | { key: "quote"; value: { provider: string; price: number } }
              | { key: "fraud"; value: { score: number } };
          }
        | {
            ok: false;
            error: {
              readonly code: "NoBranchCompleted";
              readonly message: string;
              readonly details: {
                readonly failures: (
                  | { key: "quote"; error: BranchFailure }
                  | { key: "fraud"; error: BranchFailure }
                )[];
              };
            };
          }
      >
    >;

    const entryFamilyFirst = await ctx.first("EntryFamilyFirst", {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      request: ctx.requests.approval({ orderId: args.orderId }),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      branch: ctx.branches.quote({ provider: "first-entry-family" }),
      mixedTuple: [
        ctx.steps.normalize({ orderId: args.orderId }),
        ctx.requests.approval({ orderId: args.orderId }),
        ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
        ctx.branches.quote({ provider: "first-mixed-tuple" }),
      ] as const,
      mixedMap: mixedEntryMap,
    });
    type _EntryFamilyFirstShape = Assert<
      IsEqual<
        typeof entryFamilyFirst,
        | { ok: true; result: EntryFamilyKeyedSuccess }
        | {
            ok: false;
            error: {
              readonly code: "NoBranchCompleted";
              readonly message: string;
              readonly details: {
                readonly failures: EntryFamilyKeyedFailure[];
              };
            };
          }
      >
    >;

    const atLeast = await ctx.atLeast("AtLeastQuotes", 1, {
      quote: ctx.branches.quote({ provider: "atLeast" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    type _AtLeastResult = Assert<
      IsEqual<
        typeof atLeast,
        | {
            ok: true;
            result: (
              | { key: "quote"; value: { provider: string; price: number } }
              | { key: "fraud"; value: { score: number } }
            )[];
          }
        | {
            ok: false;
            error: {
              readonly code: "QuorumNotMet";
              readonly message: string;
              readonly details: {
                readonly required: number;
                readonly got: number;
                readonly failures: (
                  | { key: "quote"; error: BranchFailure }
                  | { key: "fraud"; error: BranchFailure }
                )[];
                readonly completed: (
                  | { key: "quote"; value: { provider: string; price: number } }
                  | { key: "fraud"; value: { score: number } }
                )[];
              };
            };
          }
      >
    >;

    const entryFamilyAtLeast = await ctx.atLeast("EntryFamilyAtLeast", 3, {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      request: ctx.requests.approval({ orderId: args.orderId }),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      branch: ctx.branches.quote({ provider: "at-least-entry-family" }),
      mixedTuple: [
        ctx.steps.normalize({ orderId: args.orderId }),
        ctx.requests.approval({ orderId: args.orderId }),
        ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
        ctx.branches.quote({ provider: "at-least-mixed-tuple" }),
      ] as const,
      mixedMap: mixedEntryMap,
    });
    type _EntryFamilyAtLeastShape = Assert<
      IsEqual<
        typeof entryFamilyAtLeast,
        | { ok: true; result: EntryFamilyKeyedSuccess[] }
        | {
            ok: false;
            error: {
              readonly code: "QuorumNotMet";
              readonly message: string;
              readonly details: {
                readonly required: number;
                readonly got: number;
                readonly failures: EntryFamilyKeyedFailure[];
                readonly completed: EntryFamilyKeyedSuccess[];
              };
            };
          }
      >
    >;

    const atMost = await ctx.atMost("AtMostQuotes", 1, {
      quote: ctx.branches.quote({ provider: "atMost" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    type _AtMostResult = Assert<
      IsEqual<
        typeof atMost,
        (
          | { key: "quote"; value: { provider: string; price: number } }
          | { key: "fraud"; value: { score: number } }
        )[]
      >
    >;

    const entryFamilyAtMost = await ctx.atMost("EntryFamilyAtMost", 4, {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      request: ctx.requests.approval({ orderId: args.orderId }),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      branch: ctx.branches.quote({ provider: "at-most-entry-family" }),
      mixedTuple: [
        ctx.steps.normalize({ orderId: args.orderId }),
        ctx.requests.approval({ orderId: args.orderId }),
        ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
        ctx.branches.quote({ provider: "at-most-mixed-tuple" }),
      ] as const,
      mixedMap: mixedEntryMap,
    });
    type _EntryFamilyAtMostShape = Assert<
      IsEqual<typeof entryFamilyAtMost, EntryFamilyKeyedSuccess[]>
    >;

    const some = await ctx.some("SomeQuotes", {
      quote: ctx.branches.quote({ provider: "some" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    type _SomeResult = Assert<
      IsEqual<
        typeof some,
        (
          | { key: "quote"; value: { provider: string; price: number } }
          | { key: "fraud"; value: { score: number } }
        )[]
      >
    >;

    const entryFamilySome = await ctx.some("EntryFamilySome", {
      step: ctx.steps.normalize({ orderId: args.orderId }),
      request: ctx.requests.approval({ orderId: args.orderId }),
      child: ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
      branch: ctx.branches.quote({ provider: "some-entry-family" }),
      mixedTuple: [
        ctx.steps.normalize({ orderId: args.orderId }),
        ctx.requests.approval({ orderId: args.orderId }),
        ctx.childWorkflows.followUp({ args: { orderId: args.orderId } }),
        ctx.branches.quote({ provider: "some-mixed-tuple" }),
      ] as const,
      mixedMap: mixedEntryMap,
    });
    type _EntryFamilySomeShape = Assert<
      IsEqual<typeof entryFamilySome, EntryFamilyKeyedSuccess[]>
    >;

    return {
      ok: scopedObject && scopedTuple && scopedMap && scopedEntryFamily,
    };
  },
});

type _BranchStatus = Assert<
  IsEqual<
    BranchInstanceStatus,
    "pending" | "running" | "complete" | "failed" | "halted" | "skipped"
  >
>;
