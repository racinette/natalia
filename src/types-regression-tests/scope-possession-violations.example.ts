import { z } from "zod";
import type { BranchHandle } from "../types";
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
      ["ParentScope", "ChildScope"]
    >;

    await ctx.join(
      ctx.scope(
        "ParentScope",
        {
          parentTicket: ctx.steps
            .bookFlight(`${args.destination}-parent`, args.customerId)
            .compensate(async (compCtx) => {
              await compCtx.join(
                compCtx.steps.cancelFlight(
                  `${args.destination}-parent`,
                  args.customerId,
                ),
              );
            }),
        },
        async (ctx, { parentTicket }) => {
          await ctx.join(
            ctx.scope(
              "ChildScope",
              {
                childTicket: ctx.steps
                  .bookFlight(`${args.destination}-child`, args.customerId)
                  .compensate(async (compCtx) => {
                    await compCtx.join(
                      compCtx.steps.cancelFlight(
                        `${args.destination}-child`,
                        args.customerId,
                      ),
                    );
                  }),
              },
              async (ctx, { childTicket }) => {
                childOwnedHandle = childTicket;
                await ctx.join(childTicket);
              },
            ),
          );

          // Wrong: descendant-owned handle used from parent scope context.
          const illegalSelection = ctx.select({
            parentTicket,
            // @ts-ignore Intentional misuse for docs: child handle leaked into parent select.
            childOwnedHandle,
          });
          for await (const _v of illegalSelection) {
            break;
          }
        },
      ),
    );

    // -------------------------------------------------------------------------
    // 2) Handle leaked from one sibling scope into another sibling scope.
    // -------------------------------------------------------------------------
    let siblingAHandle!: BranchHandle<
      { id: string; price: number },
      ["SiblingScopeA"]
    >;

    await ctx.join(
      ctx.scope(
        "SiblingScopeA",
        {
          a: ctx.steps.bookFlight(`${args.destination}-a`, args.customerId),
        },
        async (ctx, { a }) => {
          siblingAHandle = a;
          await ctx.join(a);
        },
      ),
    );

    await ctx.join(
      ctx.scope(
        "SiblingScopeB",
        {
          b: ctx.steps.bookFlight(`${args.destination}-b`, args.customerId),
        },
        async (ctx, { b }) => {
          // Wrong: handle from sibling scope A consumed inside sibling scope B.
          await ctx.join(
            ctx.map({
              b,
              // @ts-ignore Intentional misuse for docs: sibling handle leaked across scopes.
              siblingAHandle,
            }),
          );
        },
      ),
    );

    // -------------------------------------------------------------------------
    // 3) Child scope reuses an ancestor scope name.
    // -------------------------------------------------------------------------
    await ctx.join(
      ctx.scope(
        "CollisionParent",
        {
          parentTimer: async () => {
            await ctx.sleep(0);
            return "done" as const;
          },
        },
        async (ctx, { parentTimer }) => {
          // Wrong: child scope name collides with an ancestor name.
          // @ts-ignore Intentional misuse for docs: descendant scope name collision.
          await ctx.join(
            ctx.scope(
              // @ts-ignore Intentional misuse for docs: colliding scope name.
              "CollisionParent",
              {
                childTimer: async () => {
                  await ctx.sleep(0);
                  return "done" as const;
                },
              },
              async (ctx, { childTimer }) => {
                await ctx.join(childTimer);
              },
            ),
          );

          await ctx.join(parentTimer);
        },
      ),
    );

    return { ok: true };
  },
});
