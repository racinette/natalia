import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { getQuote, cancelQuote } from "./shared";

const QuoteAggregationArgs = z.object({
  destination: z.string(),
  providers: z.array(z.string()),
});

/**
 * Showcases:
 * - dynamic provider fan-out using closure entries
 * - ctx.all() for aggregating results
 * - explicit result collection with per-provider failure handling
 */
export const quoteAggregationWorkflow = defineWorkflow({
  name: "quoteAggregation",
  args: QuoteAggregationArgs,
  steps: { getQuote, cancelQuote },
  result: z.object({
    bestProvider: z.string().nullable(),
    lowestPrice: z.number().nullable(),
    allPrices: z.record(z.string(), z.number()),
  }),

  async execute(ctx, args) {
    const quoteResults = await ctx.execute(
      ctx.all(
        Object.fromEntries(
          args.providers.map((provider) => [
            provider,
            async (ctx) => {
              const result = await ctx.execute(
                ctx.steps
                  .getQuote(provider, args.destination)
                  .compensate(async (ctx) => {
                    await ctx.execute(ctx.steps.cancelQuote(provider));
                  })
                  .failure(async (failure) => {
                    ctx.logger.warn("Quote failed", {
                      provider,
                      reason: failure.reason,
                    });
                    return null;
                  }),
              );
              return result;
            },
          ]),
        ),
      ),
    );

    let bestProvider: string | null = null;
    let lowestPrice: number | null = null;
    const allPrices: Record<string, number> = {};

    for (const [provider, result] of Object.entries(quoteResults)) {
      if (result == null) continue;
      ctx.logger.info("Quote received", { provider, price: result.price });
      allPrices[provider] = result.price;
      if (lowestPrice == null || result.price < lowestPrice) {
        lowestPrice = result.price;
        bestProvider = provider;
      }
    }

    return { bestProvider, lowestPrice, allPrices };
  },
});
