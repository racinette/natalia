import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { bookFlight, cancelFlight, getQuote, cancelQuote } from "./shared";

const ScopeAllAndNestedSelectArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
  providers: z.array(z.string()),
});

/**
 * Showcases:
 * - `ctx.all(entries)` sugar for "run all and collect"
 * - nested scope handles selectable in parent scope
 */
export const scopeAllAndNestedSelectWorkflow = defineWorkflow({
  name: "scopeAllAndNestedSelect",
  args: ScopeAllAndNestedSelectArgs,
  steps: { bookFlight, cancelFlight, getQuote, cancelQuote },
  result: z.object({
    flightId: z.string(),
    quoteCount: z.number(),
    winner: z.enum(["child_done", "parent_timeout"]),
  }),

  async execute(ctx, args) {
    const quoteBranches = new Map(
      args.providers.map((provider) => [
        provider,
        ctx.steps.getQuote(provider, args.destination).compensate(async (compCtx) => {
          await compCtx.steps.cancelQuote(provider);
        }),
      ]),
    );

    const allResult = await ctx.all({
      flight: ctx.steps
        .bookFlight(args.destination, args.customerId)
        .compensate(async (compCtx) => {
          await compCtx.steps.cancelFlight(args.destination, args.customerId);
        }),
      quotes: quoteBranches,
    });

    const winner = await ctx.scope(
      "NestedScopeSelection",
      {
        parentTimer: ctx.sleep(5).then(() => "parent_timeout" as const),
      },
      async (ctx, { parentTimer }) => {
        const childScope = ctx.scope(
          "ChildScope",
          {
            childTimer: ctx.sleep(1).then(() => "child_done" as const),
          },
          async (_ctx, { childTimer }) => await childTimer,
        );

        const sel = ctx.select({ parentTimer, childScope });
        for await (const val of sel.match({
          parentTimer: (v) => v,
          childScope: (v) => v,
        })) {
          return val;
        }
        return "parent_timeout" as const;
      },
    );

    return {
      flightId: allResult.flight.id,
      quoteCount: allResult.quotes.size,
      winner,
    };
  },
});
