import { z } from "zod";
import { defineStep, defineWorkflow } from "../workflow";
import { MAIN_BRANCH } from "../types";
import type {
  AwaitableEntry,
  BranchPathItem,
  BranchEntry,
  StepEntry,
  WorkflowEntry,
} from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type AwaitedEntry<T> = T extends PromiseLike<infer U> ? U : never;

type _MainBranchExported = Assert<typeof MAIN_BRANCH extends symbol ? true : false>;
type _MainBranchIsNotString = Assert<
  IsEqual<typeof MAIN_BRANCH, "MAIN_BRANCH"> extends false ? true : false
>;
const _mainBranchPath = [
  { scope: "EntryScope", branch: MAIN_BRANCH },
] satisfies readonly BranchPathItem[];
void _mainBranchPath;

const EntryStepArgs = z.object({ value: z.string() });
const EntryStepResult = z.object({ normalized: z.string() });

const normalizeEntryStep = defineStep({
  name: "normalizeEntryStep",
  args: EntryStepArgs,
  result: EntryStepResult,
  async execute(_ctx, args) {
    return { normalized: args.value.trim() };
  },
});

export const virtualEventLoopEntriesAcceptanceWorkflow = defineWorkflow({
  name: "virtualEventLoopEntriesAcceptance",
  steps: { normalizeEntryStep },
  result: z.object({ normalized: z.string() }),
  async execute(ctx) {
    const entry = ctx.steps.normalizeEntryStep({ value: " hello " });

    type _StepEntryNoAny = Assert<IsAny<typeof entry> extends false ? true : false>;
    type _StepEntryShape = Assert<typeof entry extends StepEntry<any> ? true : false>;
    type _StepEntryIsAwaitable = Assert<
      typeof entry extends AwaitableEntry<{ normalized: string }> ? true : false
    >;
    type _StepAwaited = Assert<
      IsEqual<AwaitedEntry<typeof entry>, { normalized: string }>
    >;

    // @ts-expect-error public entries are not resolved with a context anymore
    entry.resolve(ctx);
    // @ts-expect-error old builder chain is removed
    entry.retry({ intervalSeconds: 1 });
    // @ts-expect-error old completion builder is removed
    entry.complete((value: { normalized: string }) => value.normalized);
    // @ts-expect-error old failure builder is removed
    entry.failure(() => ({ normalized: "fallback" }));
    // @ts-expect-error compensation belongs to definitions, not call sites
    entry.compensate(async () => undefined);

    const result = await entry;

    const scoped = await ctx.scope(
      "EntryScope",
      {
        one: ctx.steps.normalizeEntryStep({ value: "one" }),
        two: async () => ctx.steps.normalizeEntryStep({ value: "two" }),
      },
      async (scopeCtx, branches) => {
        type _BranchNoAny = Assert<
          IsAny<typeof branches.one> extends false ? true : false
        >;
        type _BranchEntryShape = Assert<
          typeof branches.one extends BranchEntry<any, any> ? true : false
        >;
        const joined = await scopeCtx.join(branches.one);
        return joined.normalized;
      },
    );

    type _ScopeResult = Assert<IsEqual<typeof scoped, string>>;

    const allResults = await ctx.all({
      direct: ctx.steps.normalizeEntryStep({ value: "direct" }),
      closure: async () => ctx.steps.normalizeEntryStep({ value: "closure" }),
    });
    type _AllDirectResult = Assert<
      IsEqual<typeof allResults.direct, { normalized: string }>
    >;

    const firstResult = await ctx.first({
      direct: ctx.steps.normalizeEntryStep({ value: "direct" }),
      closure: async () => ctx.steps.normalizeEntryStep({ value: "closure" }),
    });
    type _FirstResult = Assert<
      IsEqual<
        typeof firstResult,
        | { key: "direct"; result: { normalized: string } }
        | { key: "closure"; result: { normalized: string } }
      >
    >;

    type _EntryIsNotNativePromise = Assert<
      typeof entry extends Promise<{ normalized: string }> ? false : true
    >;

    return { normalized: `${result.normalized}:${scoped}` };
  },
});

type _WorkflowEntryExport = Assert<WorkflowEntry<any> extends AwaitableEntry<any> ? true : false>;

// Removed public exports should stay unavailable.
// @ts-expect-error DurableHandle is not part of the active type surface
type _NoDurableHandle = import("../types").DurableHandle<any>;
// @ts-expect-error AtomicResult is not part of the active type surface
type _NoAtomicResult = import("../types").AtomicResult<any>;
// @ts-expect-error StepCall is not part of the active type surface
type _NoStepCall = import("../types").StepCall<any>;
// @ts-expect-error WorkflowCall is not part of the active type surface
type _NoWorkflowCall = import("../types").WorkflowCall<any>;
// @ts-expect-error ScopeCall is not part of the active type surface
type _NoScopeCall = import("../types").ScopeCall<any>;
// @ts-expect-error FirstCall is not part of the active type surface
type _NoFirstCall = import("../types").FirstCall<any>;
