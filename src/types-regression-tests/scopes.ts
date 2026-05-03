import { z } from "zod";
import { defineRequest, defineStep, defineWorkflow } from "../workflow";
import type {
  AwaitableEntry,
  KeyedSuccess,
  NoEntryCompleted,
  RequestEntry,
  SomeEntriesFailed,
  StepEntry,
  WorkflowEntry,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// SCOPE-ENTRY FAMILY
//
// Without branches, scopes orchestrate exactly three entry kinds: steps,
// requests, and (attached) child workflows. Each is structurally an
// `AwaitableEntry<T>` underneath.
// =============================================================================

type _StepEntryIsAwaitable = Assert<
  StepEntry<number> extends AwaitableEntry<number> ? true : false
>;
type _RequestEntryIsAwaitable = Assert<
  RequestEntry<number> extends AwaitableEntry<number> ? true : false
>;
type _WorkflowEntryIsAwaitable = Assert<
  WorkflowEntry<number> extends AwaitableEntry<number> ? true : false
>;

// =============================================================================
// FIXTURES
// =============================================================================

const computeStep = defineStep({
  name: "scopesComputeStep",
  args: z.object({ value: z.number() }),
  result: z.object({ doubled: z.number() }),
  async execute(_ctx, args) {
    return { doubled: args.value * 2 };
  },
});

const reviewRequest = defineRequest({
  name: "scopesReviewRequest",
  payload: z.object({ value: z.number() }),
  response: z.object({ ok: z.boolean() }),
});

const childWorkflow = defineWorkflow({
  name: "scopesChild",
  args: z.object({ value: z.number() }),
  result: z.object({ tripled: z.number() }),
  async execute(_ctx, args) {
    return { tripled: args.value * 3 };
  },
});

// =============================================================================
// SCOPE BODY — receives handles in the same shape as the input entries
// =============================================================================

export const scopesAcceptanceWorkflow = defineWorkflow({
  name: "scopesAcceptance",
  args: z.object({ start: z.number() }),
  steps: { computeStep },
  requests: { reviewRequest },
  childWorkflows: { childWorkflow },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    // Plain step await — returns the success type directly.
    const compute = await ctx.steps.computeStep({ value: args.start });
    type _ComputeResult = Assert<
      IsEqual<typeof compute, { doubled: number }>
    >;

    // Plain request await — returns the response directly.
    const review = await ctx.requests.reviewRequest({ value: args.start });
    type _ReviewResult = Assert<IsEqual<typeof review, { ok: boolean }>>;

    // Scope orchestrates a top-level object of entries.
    await ctx.scope(
      "fanout",
      {
        compute: ctx.steps.computeStep({ value: args.start }),
        review: ctx.requests.reviewRequest({ value: args.start }),
        children: [
          ctx.childWorkflows.childWorkflow({ args: { value: 1 } }),
          ctx.childWorkflows.childWorkflow({ args: { value: 2 } }),
        ],
      },
      async (scopeCtx, handles) => {
        // The handle structure mirrors the entry input structure: the body
        // receives an awaitable for each entry under the same key.
        type _ComputeIsAwaitable = Assert<
          typeof handles.compute extends AwaitableEntry<{ doubled: number }>
            ? true
            : false
        >;
        type _ReviewIsAwaitable = Assert<
          typeof handles.review extends AwaitableEntry<{ ok: boolean }>
            ? true
            : false
        >;
        type _ChildIsAwaitable = Assert<
          (typeof handles.children)[0] extends AwaitableEntry<any>
            ? true
            : false
        >;

        // Each handle remains awaitable inside the body.
        const compute = await scopeCtx.join(handles.compute);
        type _ComputeJoin = Assert<
          IsEqual<typeof compute, { doubled: number }>
        >;

        return compute;
      },
    );

    return { ok: true };
  },
});

// =============================================================================
// CONVENIENCE HELPERS — `all`, `first`, `atLeast`, `atMost`, `some`
// =============================================================================

export const helpersAcceptanceWorkflow = defineWorkflow({
  name: "scopesHelpersAcceptance",
  steps: { computeStep },
  requests: { reviewRequest },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    // `all` succeeds with the input-shaped success values, or returns
    // `SomeEntriesFailed`.
    const all = await ctx.all("all", {
      a: ctx.steps.computeStep({ value: 1 }),
      b: ctx.requests.reviewRequest({ value: 2 }),
    });
    if (!all.ok) {
      type _AllError = Assert<
        typeof all.error extends SomeEntriesFailed<any> ? true : false
      >;
    } else {
      type _AllResult = Assert<
        IsEqual<
          typeof all.result,
          { a: { doubled: number }; b: { ok: boolean } }
        >
      >;
    }

    // `first` returns the first key to complete, or `NoEntryCompleted`.
    const first = await ctx.first("first", {
      a: ctx.steps.computeStep({ value: 3 }),
      b: ctx.steps.computeStep({ value: 4 }),
    });
    if (!first.ok) {
      type _FirstError = Assert<
        typeof first.error extends NoEntryCompleted<any> ? true : false
      >;
    } else {
      type _FirstResult = Assert<
        typeof first.result extends KeyedSuccess<any> ? true : false
      >;
    }

    return { ok: true };
  },
});

void reviewRequest;
void childWorkflow;
