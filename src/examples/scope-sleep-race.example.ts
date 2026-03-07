import { z } from "zod";
import { defineWorkflow } from "../workflow";
import {
  bookFlight,
  cancelFlight,
  paymentWorkflow,
  campaignWorker,
} from "./shared";

const ScopeSleepRaceArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
  amount: z.number(),
});

/**
 * Showcases:
 * - time-bounded workflow logic via `scope + sleep` races
 * - step race pattern (step vs sleep)
 * - child workflow race pattern (child workflow vs sleep)
 */
export const scopeSleepRaceWorkflow = defineWorkflow({
  name: "scopeSleepRace",
  args: ScopeSleepRaceArgs,
  steps: { bookFlight, cancelFlight },
  childWorkflows: { payment: paymentWorkflow, campaignWorker },
  result: z.object({
    stepRace: z.enum(["booked", "timed_out"]),
    childRace: z.enum(["completed", "timed_out"]),
  }),
  rng: { ids: true },

  async execute(ctx, args) {
    const stepRace = await ctx
      .scope(
        "StepTimeoutRace",
        {
          flight: async (ctx) =>
            ctx.steps
              .bookFlight(args.destination, args.customerId)
              .compensate(async (ctx) => {
                await ctx.steps
                  .cancelFlight(args.destination, args.customerId)
                  .resolve(ctx);
              })
              .resolve(ctx),
          timer: async (ctx) => {
            await ctx.sleep(30);
            return "timed_out" as const;
          },
        },
        async (ctx, { flight, timer }) => {
          const sel = ctx.select({ flight, timer });
          for await (const val of ctx.match(sel, {
            flight: {
              complete: () => "booked" as const,
              failure: async () => "timed_out" as const,
            },
            timer: () => "timed_out" as const,
          })) {
            return val;
          }
          return "timed_out" as const;
        },
      )
      .resolve(ctx);

    const childRace = await ctx
      .scope(
        "ChildTimeoutRace",
        {
          payment: async (ctx) =>
            ctx.childWorkflows
              .payment({
                idempotencyKey: `payment-${ctx.rng.ids.uuidv4()}`,
                metadata: {
                  tenantId: `tenant-${args.customerId}`,
                  correlationId: `corr-payment-race-${args.customerId}`,
                },
                seed: `payment-race-${args.customerId}`,
                args: { customerId: args.customerId, amount: args.amount },
              })
              .resolve(ctx),
          timer: async (ctx) => {
            await ctx.sleep(45);
            return "timed_out" as const;
          },
        },
        async (ctx, { payment, timer }) => {
          const sel = ctx.select({ payment, timer });
          for await (const val of ctx.match(sel, {
            payment: {
              complete: () => "completed" as const,
              failure: async () => "timed_out" as const,
            },
            timer: () => "timed_out" as const,
          })) {
            return val;
          }
          return "timed_out" as const;
        },
      )
      .resolve(ctx);

    return { stepRace, childRace };
  },
});
