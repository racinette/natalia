import { z } from "zod";
import { defineBranch, defineWorkflow } from "../workflow";
import type { BranchInstanceStatus, MatchEvent } from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const quoteBranch = defineBranch({
  name: "quoteBranch",
  args: z.object({ provider: z.string() }),
  result: z.object({ provider: z.string(), price: z.number() }),
  async execute(_ctx, args) {
    return { provider: args.provider, price: 100 };
  },
});

const fraudBranch = defineBranch({
  name: "fraudBranch",
  args: z.object({ orderId: z.string() }),
  result: z.object({ score: z.number() }),
  errors: { FraudServiceDown: z.object({ orderId: z.string() }) },
  async execute(_ctx, args) {
    return { score: args.orderId.length };
  },
});

export const branchesAndScopesAcceptanceWorkflow = defineWorkflow({
  name: "branchesAndScopesAcceptance",
  args: z.object({ orderId: z.string() }),
  branches: {
    quote: quoteBranch,
    fraud: fraudBranch,
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx, args) {
    const quote = ctx.branches.quote({ provider: "alpha" });
    type _BranchNoAny = Assert<IsAny<typeof quote> extends false ? true : false>;

    // @ts-expect-error branch args are schema-checked
    ctx.branches.quote({ provider: 123 });
    // @ts-expect-error inline branch closures are no longer scope entries
    await ctx.scope("InlineRejected", { bad: async () => ({ ok: true }) }, async () => undefined);

    const scopedObject = await ctx.scope(
      "ObjectScope",
      {
        quote: ctx.branches.quote({ provider: "alpha" }),
        fraud: ctx.branches.fraud({ orderId: args.orderId }),
      },
      async (scopeCtx, branches) => {
        const quoteResult = await scopeCtx.join(branches.quote);
        type _QuoteJoin = Assert<
          IsEqual<
            typeof quoteResult,
            | { ok: true; result: { provider: string; price: number } }
            | { ok: false; status: "failed"; error: unknown }
          >
        >;

        const timedFraud = await scopeCtx.join(branches.fraud, { timeout: 5 });
        type _TimedJoinAddsTimeout = Assert<
          IsEqual<
            typeof timedFraud,
            | { ok: true; result: { score: number } }
            | { ok: false; status: "failed"; error: unknown }
            | { ok: false; status: "timeout" }
          >
        >;

        for await (const event of scopeCtx.match(branches)) {
          type _MatchEvent = Assert<
            IsEqual<
              typeof event,
              | MatchEvent<"quote", { provider: string; price: number }>
              | MatchEvent<"fraud", { score: number }>
            >
          >;
          break;
        }

        // @ts-expect-error match no longer accepts handler overloads
        scopeCtx.match(branches, { quote: (value: unknown) => value });

        return quoteResult.ok;
      },
    );

    // @ts-expect-error scope inputs must keep a top-level object shape
    await ctx.scope("TopLevelTupleRejected", [ctx.branches.quote({ provider: "tuple" })], async () => true);

    const mapEntries = new Map([
      ["a", ctx.branches.quote({ provider: "map-a" })],
      ["b", ctx.branches.quote({ provider: "map-b" })],
    ] as const);
    // @ts-expect-error scope inputs must keep a top-level object shape
    await ctx.scope("TopLevelMapRejected", mapEntries, async () => true);

    const scopedTuple = await ctx.scope(
      "TupleScope",
      {
        quotes: [
          ctx.branches.quote({ provider: "tuple-a" }),
          ctx.branches.quote({ provider: "tuple-b" }),
        ] as const,
      },
      async (scopeCtx, branches) => {
        await scopeCtx.join(branches.quotes[0]);

        for await (const event of scopeCtx.match(branches)) {
          type _TupleEvent = Assert<
            IsEqual<
              typeof event,
              MatchEvent<"quotes", { provider: string; price: number }> & { index: 0 | 1 }
            >
          >;
          break;
        }
        return true;
      },
    );

    const scopedMap = await ctx.scope(
      "MapScope",
      { quotesByProvider: mapEntries },
      async (scopeCtx, branches) => {
        const quoteA = branches.quotesByProvider.get("a");
        if (quoteA) {
          await scopeCtx.join(quoteA);
        }

        for await (const event of scopeCtx.match(branches)) {
          type _MapEvent = Assert<
            IsEqual<
              typeof event,
              MatchEvent<"quotesByProvider", { provider: string; price: number }> & {
                mapKey: "a" | "b";
              }
            >
          >;
          break;
        }
        return true;
      },
    );

    const all = await ctx.all({
      quote: ctx.branches.quote({ provider: "all" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    type _AllResult = Assert<
      IsEqual<
        typeof all,
        {
          quote: { provider: string; price: number };
          fraud: { score: number };
        }
      >
    >;

    const first = await ctx.first({
      quote: ctx.branches.quote({ provider: "first" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    type _FirstResult = Assert<
      IsEqual<
        typeof first,
        | { key: "quote"; result: { provider: string; price: number } }
        | { key: "fraud"; result: { score: number } }
      >
    >;

    await ctx.atLeast(1, {
      quote: ctx.branches.quote({ provider: "atLeast" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    await ctx.atMost(1, {
      quote: ctx.branches.quote({ provider: "atMost" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });
    await ctx.best({
      quote: ctx.branches.quote({ provider: "best" }),
      fraud: ctx.branches.fraud({ orderId: args.orderId }),
    });

    return { ok: scopedObject && scopedTuple && scopedMap };
  },
});

type _BranchStatus = Assert<
  IsEqual<
    BranchInstanceStatus,
    "pending" | "running" | "complete" | "failed" | "halted" | "skipped"
  >
>;
