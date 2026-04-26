import { z } from "zod";
import {
  defineBranch,
  defineRequest,
  defineStep,
  defineWorkflow,
} from "../workflow";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const visibleStep = defineStep({
  name: "visibleStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    steps: {
      undoStep: defineStep({
        name: "undoStep",
        args: z.object({ id: z.string() }),
        result: z.object({ undone: z.boolean() }),
        async execute() {
          return { undone: true };
        },
      }),
    },
    result: z.object({ undone: z.boolean() }),
    async undo(ctx, args, info) {
      type _UndoArgs = Assert<IsEqual<typeof args, { id: string }>>;
      type _UndoInfoResult = Assert<
        IsEqual<typeof info.result, { ok: boolean } | undefined>
      >;

      await ctx.steps.undoStep({ id: args.id });
      // @ts-expect-error workflow step is not automatically visible in compensation
      await ctx.steps.visibleStep({ id: args.id });
      // @ts-expect-error workflow request is not automatically visible in compensation
      await ctx.requests.visibleRequest({ id: args.id });
      // @ts-expect-error workflow errors are not automatically visible in compensation
      throw ctx.errors.WorkflowOnly("not visible");
    },
  },
  async execute(_ctx, args) {
    return { ok: Boolean(args.id) };
  },
});

const hiddenStep = defineStep({
  name: "hiddenStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

const visibleRequest = defineRequest({
  name: "visibleRequest",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const isolatedBranch = defineBranch({
  name: "isolatedBranch",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  steps: { visibleStep },
  errors: {
    BranchOnly: z.object({ id: z.string() }),
  },
  async execute(ctx, args) {
    await ctx.steps.visibleStep({ id: args.id });

    // @ts-expect-error undeclared workflow step is not visible in branch
    await ctx.steps.hiddenStep({ id: args.id });
    // @ts-expect-error workflow request is not visible unless declared by branch
    await ctx.requests.visibleRequest({ id: args.id });
    // @ts-expect-error workflow-level error is not visible in branch
    throw ctx.errors.WorkflowOnly("not visible", { id: args.id });

    throw ctx.errors.BranchOnly("branch failed", { id: args.id });
  },
});

export const contextIsolationAcceptanceWorkflow = defineWorkflow({
  name: "contextIsolationAcceptance",
  steps: { visibleStep, hiddenStep },
  requests: { visibleRequest },
  branches: { isolatedBranch },
  errors: {
    WorkflowOnly: z.object({ id: z.string() }),
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    await ctx.steps.visibleStep({ id: "visible" });
    await ctx.steps.hiddenStep({ id: "hidden" });
    await ctx.requests.visibleRequest({ id: "request" });

    // @ts-expect-error branch-only error is not visible in workflow context
    ctx.errors.BranchOnly("not visible", { id: "x" });

    const branch = ctx.branches.isolatedBranch({ id: "branch" });
    const joined = await ctx.join(branch);
    type _BranchJoinHasResult = Assert<
      IsEqual<
        typeof joined,
        | { ok: true; result: { ok: boolean } }
        | { ok: false; status: "failed"; error: unknown }
        | { ok: false; status: "skipped" }
      >
    >;

    // @ts-expect-error removed public mutable workflow state
    ctx.state;

    return { ok: true };
  },
});
