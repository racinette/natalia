import { z } from "zod";
import { defineWorkflow } from "../workflow";
import { getQuote, cancelQuote } from "./shared";

const QuoteAggregationArgs = z.object({
  destination: z.string(),
  providers: z.array(z.string()),
});

/**
 * Showcases:
 * - Array fan-out + Map fan-out
 * - map innerKey handling
 * - map output structure mirroring
 */
export const quoteAggregationWorkflow = defineWorkflow({
  name: "quoteAggregation",
  args: QuoteAggregationArgs,
  steps: { getQuote, cancelQuote },
  result: z.object({
    bestProvider: z.string().nullable(),
    lowestPrice: z.number().nullable(),
    allPrices: z.map(z.string(), z.number()),
  }),

  async execute(ctx, args) {
    const arrayBranches = args.providers.map((p) =>
      ctx.steps.getQuote(p, args.destination).compensate(async (compCtx) => {
        await compCtx.steps.cancelQuote(p);
      }),
    );

    const arrayMapped = await ctx.scope(
      { quotes: arrayBranches },
      async ({ quotes }) =>
        ctx.map(
          { quotes },
          {
            quotes: {
              complete: (data, innerKey) => {
                ctx.logger.info("Array quote received", {
                  idx: innerKey,
                  provider: data.provider,
                  price: data.price,
                });
                return data.price;
              },
              failure: (_failure, innerKey) => {
                ctx.logger.warn("Array quote failed", { idx: innerKey });
                return null;
              },
            },
          },
        ),
    );

    const mapBranches = new Map(
      args.providers.map((p) => [
        p,
        ctx.steps.getQuote(p, args.destination).compensate(async (compCtx) => {
          await compCtx.steps.cancelQuote(p);
        }),
      ]),
    );

    const mapped = await ctx.scope(
      { quotes: mapBranches },
      async ({ quotes }) =>
        ctx.map(
          { quotes },
          {
            quotes: {
              complete: (data, innerKey) => ({
                price: data.price,
                provider: innerKey,
              }),
              failure: (_failure, innerKey) => {
                ctx.logger.warn("Map quote failed", { provider: innerKey });
                return null;
              },
            },
          },
        ),
    );

    let bestProvider: string | null = null;
    let lowestPrice: number | null = null;
    const allPrices = new Map<string, number>();
    const arrayPrices = arrayMapped.quotes.filter((price) => price != null);
    ctx.logger.info("Array quote fan-out complete", {
      requested: args.providers.length,
      received: arrayPrices.length,
    });

    for (const [provider, entry] of mapped.quotes ?? []) {
      if (entry == null) continue;
      allPrices.set(provider, entry.price);
      if (lowestPrice == null || entry.price < lowestPrice) {
        lowestPrice = entry.price;
        bestProvider = provider;
      }
    }

    return { bestProvider, lowestPrice, allPrices };
  },
});
