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
    const stepRace = await ctx.scope(
      "StepTimeoutRace",
      {
        flight: ctx.steps
          .bookFlight(args.destination, args.customerId)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelFlight(args.destination, args.customerId);
          }),
        timer: ctx.sleep(30).then(() => "timed_out" as const),
      },
      async (ctx, { flight, timer }) => {
        const sel = ctx.select({ flight, timer });
        for await (const val of sel.match({
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
    );

    const childRace = await ctx.scope(
      "ChildTimeoutRace",
      {
        payment: ctx.childWorkflows.payment({
          id: `payment-${ctx.rng.ids.uuidv4()}`,
          metadata: {
            tenantId: `tenant-${args.customerId}`,
            correlationId: `corr-payment-race-${args.customerId}`,
          },
          seed: `payment-race-${args.customerId}`,
          args: { customerId: args.customerId, amount: args.amount },
        }),
        timer: ctx.sleep(45).then(() => "timed_out" as const),
      },
      async (ctx, { payment, timer }) => {
        const sel = ctx.select({ payment, timer });
        for await (const val of sel.match({
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
    );

    return { stepRace, childRace };
  },
});
