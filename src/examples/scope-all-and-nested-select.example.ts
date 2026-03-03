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
        ctx.steps
          .getQuote(provider, args.destination)
          .compensate(async (ctx) => {
            await ctx.join(ctx.steps.cancelQuote(provider));
          }),
      ]),
    );

    const allResult = await ctx.join(
      ctx.all({
        flight: ctx.steps
          .bookFlight(args.destination, args.customerId)
          .compensate(async (ctx) => {
            await ctx.join(
              ctx.steps.cancelFlight(args.destination, args.customerId),
            );
          }),
        quotes: quoteBranches,
      }),
    );

    const winner = await ctx.join(
      ctx.scope(
        "NestedScopeSelection",
        {
          parentTimer: async () => {
            await ctx.sleep(5);
            return "parent_timeout" as const;
          },
        },
        async (ctx, { parentTimer }) => {
          const childScope = ctx.scope(
            "ChildScope",
            {
              childTimer: async () => {
                await ctx.sleep(1);
                return "child_done" as const;
              },
            },
            async (ctx, { childTimer }) => await ctx.join(childTimer),
          );

          const sel = ctx.select({ parentTimer, childScope });
          for await (const val of sel) {
            return val;
          }
          return "parent_timeout" as const;
        },
      ),
    );

    return {
      flightId: allResult.flight.id,
      quoteCount: allResult.quotes.size,
      winner,
    };
  },
});
