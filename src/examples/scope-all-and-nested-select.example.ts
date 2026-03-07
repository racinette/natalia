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
    const allResult = await ctx.execute(
      ctx.all({
        flight: async (ctx) =>
          ctx.execute(
            ctx.steps
              .bookFlight(args.destination, args.customerId)
              .compensate(async (ctx) => {
                await ctx.execute(
                  ctx.steps.cancelFlight(args.destination, args.customerId),
                );
              }),
          ),
        quotes: async (ctx) =>
          ctx.execute(
            ctx.all(
              Object.fromEntries(
                args.providers.map((provider) => [
                  provider,
                  async (innerCtx: typeof ctx) =>
                    innerCtx.execute(
                      innerCtx.steps
                        .getQuote(provider, args.destination)
                        .compensate(async (ctx) => {
                          await ctx.execute(ctx.steps.cancelQuote(provider));
                        }),
                    ),
                ]),
              ),
            ),
          ),
      }),
    );

    const winner = await ctx.execute(
      ctx.scope(
        "NestedScopeSelection",
        {
          parentTimer: async (ctx) => {
            await ctx.sleep(5);
            return "parent_timeout" as const;
          },
          childScope: async (ctx) =>
            ctx.execute(
              ctx.scope(
                "ChildScope",
                {
                  childTimer: async (ctx) => {
                    await ctx.sleep(1);
                    return "child_done" as const;
                  },
                },
                async (ctx, { childTimer }) => await ctx.join(childTimer),
              ),
            ),
        },
        async (ctx, { parentTimer, childScope }) => {
          const sel = ctx.select({ parentTimer, childScope });
          for await (const { result } of ctx.match(sel)) {
            return result;
          }
          return "parent_timeout" as const;
        },
      ),
    );

    return {
      flightId: allResult.flight.id,
      quoteCount: Object.keys(allResult.quotes).length,
      winner,
    };
  },
});
