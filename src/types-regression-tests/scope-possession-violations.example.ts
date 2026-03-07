import { z } from "zod";
import type { BranchHandle, ScopeDivider, BranchDivider } from "../types";
import { defineWorkflow } from "../workflow";
import { bookFlight, cancelFlight } from "../examples/shared";

const ScopeViolationArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
});

/**
 * Showcase: intentionally wrong scope usage patterns.
 *
 * This file exists to document the ownership guarantees of named scope branding.
 * Every invalid pattern is intentionally forced to compile with explicit ts-ignores.
 *
 * Scope path structure (with new symbol dividers):
 * - After scope "ParentScope": [ScopeDivider, "ParentScope"]
 * - After branch key "childTicket": [ScopeDivider, "ParentScope", BranchDivider, "childTicket"]
 * - After child scope "ChildScope": [ScopeDivider, "ParentScope", BranchDivider, "childTicket", ScopeDivider, "ChildScope"]
 */
export const scopePossessionViolationsWorkflow = defineWorkflow({
  name: "scopePossessionViolations",
  args: ScopeViolationArgs,
  steps: { bookFlight, cancelFlight },
  result: z.object({
    ok: z.boolean(),
  }),

  async execute(ctx, args) {
    // -------------------------------------------------------------------------
    // 1) Child-owned handle leaked to parent scope and then consumed in parent.
    // -------------------------------------------------------------------------
    let childOwnedHandle!: BranchHandle<
      { id: string; price: number },
      [ScopeDivider, "ParentScope", ScopeDivider, "ChildScope"]
    >;

    await ctx.scope(
        "ParentScope",
        {
          parentTicket: async (branchCtx) =>
            branchCtx.steps
                .bookFlight(`${args.destination}-parent`, args.customerId)
                .compensate(async (compCtx) => {
                  await compCtx.steps.cancelFlight(
                      `${args.destination}-parent`,
                      args.customerId,
                    ).resolve(compCtx);
                }).resolve(branchCtx),
        },
        async (ctx, { parentTicket }) => {
          await ctx.scope(
              "ChildScope",
              {
                childTicket: async (branchCtx) =>
                  branchCtx.steps
                      .bookFlight(`${args.destination}-child`, args.customerId)
                      .compensate(async (compCtx) => {
                        await compCtx.steps.cancelFlight(
                            `${args.destination}-child`,
                            args.customerId,
                          ).resolve(compCtx);
                      }).resolve(branchCtx),
              },
              async (ctx, { childTicket }) => {
                childOwnedHandle = childTicket;
                await ctx.join(childTicket);
              },
            ).resolve(ctx);

          // Wrong: descendant-owned handle used from parent scope context.
          const illegalSelection = ctx.select({
            parentTicket,
            // @ts-ignore Intentional misuse for docs: child handle leaked into parent select.
            childOwnedHandle,
          });
          for await (const _event of ctx.match(illegalSelection)) {
            break;
          }
        },
      ).resolve(ctx);

    // -------------------------------------------------------------------------
    // 2) Handle leaked from one sibling scope into another sibling scope.
    // -------------------------------------------------------------------------
    let siblingAHandle!: BranchHandle<
      { id: string; price: number },
      [ScopeDivider, "SiblingScopeA"]
    >;

    await ctx.scope(
        "SiblingScopeA",
        {
          a: async (branchCtx) =>
            branchCtx.steps.bookFlight(`${args.destination}-a`, args.customerId).resolve(branchCtx),
        },
        async (ctx, { a }) => {
          siblingAHandle = a;
          await ctx.join(a);
        },
      ).resolve(ctx);

    await ctx.scope(
        "SiblingScopeB",
        {
          b: async (branchCtx) =>
            branchCtx.steps.bookFlight(`${args.destination}-b`, args.customerId).resolve(branchCtx),
        },
        async (ctx, { b }) => {
          // Wrong: handle from sibling scope A consumed inside sibling scope B.
          // @ts-ignore Intentional misuse for docs: sibling handle leaked across scopes.
          await ctx.join(siblingAHandle);
        },
      ).resolve(ctx);

    // -------------------------------------------------------------------------
    // 3) Child scope reuses an ancestor scope name.
    // -------------------------------------------------------------------------
    await ctx.scope(
        "CollisionParent",
        {
          parentTimer: async (_branchCtx) => {
            await ctx.sleep(0);
            return "done" as const;
          },
        },
        async (ctx, { parentTimer }) => {
          // Wrong: child scope name collides with an ancestor name.
          // @ts-ignore Intentional misuse for docs: descendant scope name collision.
          await ctx.scope(
              // @ts-ignore Intentional misuse for docs: colliding scope name.
              "CollisionParent",
              {
                childTimer: async (_branchCtx) => {
                  await ctx.sleep(0);
                  return "done" as const;
                },
              },
              async (ctx, { childTimer }) => {
                await ctx.join(childTimer);
              },
            ).resolve(ctx);

          await ctx.join(parentTimer);
        },
      ).resolve(ctx);

    return { ok: true };
  },
});
