import { z } from "zod";
import type { BranchHandle } from "../types";
import { defineWorkflow } from "../workflow";
import { bookFlight, cancelFlight } from "./shared";

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

    await ctx.scope(
      "ParentScope",
      {
        parentTicket: ctx.steps
          .bookFlight(`${args.destination}-parent`, args.customerId)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelFlight(
              `${args.destination}-parent`,
              args.customerId,
            );
          }),
      },
      async (ctx, { parentTicket }) => {
        await ctx.scope(
          "ChildScope",
          {
            childTicket: ctx.steps
              .bookFlight(`${args.destination}-child`, args.customerId)
              .compensate(async (compCtx) => {
                await compCtx.steps.cancelFlight(
                  `${args.destination}-child`,
                  args.customerId,
                );
              }),
          },
          async (_ctx, { childTicket }) => {
            childOwnedHandle = childTicket;
            await childTicket;
          },
        );

        // Wrong: descendant-owned handle used from parent scope context.
        // @ts-ignore Intentional misuse for docs: child handle leaked into parent select.
        const illegalSelection = ctx.select({ parentTicket, childOwnedHandle });
        for await (const _v of illegalSelection) {
          break;
        }
      },
    );

    // -------------------------------------------------------------------------
    // 2) Handle leaked from one sibling scope into another sibling scope.
    // -------------------------------------------------------------------------
    let siblingAHandle!: BranchHandle<
      { id: string; price: number },
      ["SiblingScopeA"]
    >;

    await ctx.scope(
      "SiblingScopeA",
      {
        a: ctx.steps.bookFlight(`${args.destination}-a`, args.customerId),
      },
      async (_ctx, { a }) => {
        siblingAHandle = a;
        await a;
      },
    );

    await ctx.scope(
      "SiblingScopeB",
      {
        b: ctx.steps.bookFlight(`${args.destination}-b`, args.customerId),
      },
      async (ctx, { b }) => {
        // Wrong: handle from sibling scope A consumed inside sibling scope B.
        // @ts-ignore Intentional misuse for docs: sibling handle leaked across scopes.
        await ctx.map({ b, siblingAHandle });
      },
    );

    // -------------------------------------------------------------------------
    // 3) Child scope reuses an ancestor scope name.
    // -------------------------------------------------------------------------
    await ctx.scope(
      "CollisionParent",
      {
        parentTimer: ctx.sleep(0).then(() => "done" as const),
      },
      async (ctx, { parentTimer }) => {
        // Wrong: child scope name collides with an ancestor name.
        // @ts-ignore Intentional misuse for docs: descendant scope name collision.
        await ctx.scope(
          // @ts-ignore Intentional misuse for docs: colliding scope name.
          "CollisionParent",
          { childTimer: ctx.sleep(0).then(() => "done" as const) },
          async (_ctx, { childTimer }) => {
            await childTimer;
          },
        );

        await parentTimer;
      },
    );

    return { ok: true };
  },
});
