/**
 * Example workflows demonstrating the thenable + closure-based API.
 *
 * All examples use the new pattern:
 * - Steps are called directly: `ctx.steps.bookFlight(arg1, arg2)`
 * - Builders chain before await: `.compensate(cb)`, `.retry(policy)`, `.failure(cb)`, `.complete(cb)`
 * - Scope entries are closures: `{ flight: async () => ... }`
 * - Collections enable dynamic fan-out: `Map<string, ScopeBranch<T>>`
 * - Child workflows: `ctx.childWorkflows.payment({ workflowId, args })`
 * - Foreign handles: `ctx.foreignWorkflows.emailCampaign.get(id)`
 */

import { z } from "zod";
import { defineStep, defineWorkflow } from "./workflow";

// =============================================================================
// STEP DEFINITIONS (§2a — unchanged from old API)
// =============================================================================

const FlightResult = z.object({ id: z.string(), price: z.number() });
const HotelResult = z.object({ id: z.string(), price: z.number() });
const CarResult = z.object({ id: z.string() });
const QuoteResult = z.object({ price: z.number(), provider: z.string() });
const EmailResult = z.object({ sent: z.boolean() });
const CancelResult = z.object({ ok: z.boolean() });
const PaymentResult = z.object({ receiptId: z.string(), amount: z.number() });
const FraudCheckResult = z.object({ approved: z.boolean() });

const bookFlight = defineStep({
  name: "bookFlight",
  execute: async ({ signal }, destination: string, customerId: string) => {
    const res = await fetch("https://api.flights.com/book", {
      method: "POST",
      body: JSON.stringify({ destination, customerId }),
      signal,
    });
    return res.json() as Promise<{ id: string; price: number }>;
  },
  schema: FlightResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

const cancelFlight = defineStep({
  name: "cancelFlight",
  execute: async ({ signal }, destination: string, customerId: string) => {
    await fetch("https://api.flights.com/cancel-by-route", {
      method: "POST",
      body: JSON.stringify({ destination, customerId }),
      signal,
    });
    return { ok: true };
  },
  schema: CancelResult,
  retryPolicy: { maxAttempts: 20, intervalSeconds: 5 },
});

const bookHotel = defineStep({
  name: "bookHotel",
  execute: async (
    { signal },
    destination: string,
    checkIn: string,
    checkOut: string,
  ) => {
    const res = await fetch("https://api.hotels.com/book", {
      method: "POST",
      body: JSON.stringify({ destination, checkIn, checkOut }),
      signal,
    });
    return res.json() as Promise<{ id: string; price: number }>;
  },
  schema: HotelResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

const cancelHotel = defineStep({
  name: "cancelHotel",
  execute: async (
    { signal },
    destination: string,
    checkIn: string,
    checkOut: string,
  ) => {
    await fetch("https://api.hotels.com/cancel", {
      method: "POST",
      body: JSON.stringify({ destination, checkIn, checkOut }),
      signal,
    });
    return { ok: true };
  },
  schema: CancelResult,
  retryPolicy: { maxAttempts: 10, intervalSeconds: 5 },
});

const reserveCar = defineStep({
  name: "reserveCar",
  execute: async ({ signal }, destination: string, dateRange: string) => {
    const res = await fetch("https://api.cars.com/reserve", {
      method: "POST",
      body: JSON.stringify({ destination, dateRange }),
      signal,
    });
    return res.json() as Promise<{ id: string }>;
  },
  schema: CarResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

const cancelCar = defineStep({
  name: "cancelCar",
  execute: async ({ signal }, destination: string, dateRange: string) => {
    await fetch("https://api.cars.com/cancel", {
      method: "POST",
      body: JSON.stringify({ destination, dateRange }),
      signal,
    });
    return { ok: true };
  },
  schema: CancelResult,
  retryPolicy: { maxAttempts: 10, intervalSeconds: 5 },
});

const sendEmail = defineStep({
  name: "sendEmail",
  execute: async ({ signal }, to: string, subject: string, body: string) => {
    await fetch("https://api.email.com/send", {
      method: "POST",
      body: JSON.stringify({ to, subject, body }),
      signal,
    });
    return { sent: true };
  },
  schema: EmailResult,
  retryPolicy: { maxAttempts: 5, intervalSeconds: 10 },
});

const getQuote = defineStep({
  name: "getQuote",
  execute: async ({ signal }, provider: string, destination: string) => {
    const res = await fetch(`https://api.${provider}.com/quote`, {
      method: "POST",
      body: JSON.stringify({ destination }),
      signal,
    });
    return res.json() as Promise<{ price: number; provider: string }>;
  },
  schema: QuoteResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 1 },
});

const cancelQuote = defineStep({
  name: "cancelQuote",
  execute: async ({ signal }, provider: string) => {
    await fetch(`https://api.${provider}.com/quote/cancel`, {
      method: "POST",
      signal,
    });
    return { ok: true };
  },
  schema: CancelResult,
  retryPolicy: { maxAttempts: 5, intervalSeconds: 2 },
});

const fraudCheck = defineStep({
  name: "fraudCheck",
  execute: async ({ signal }, flightId: string) => {
    const res = await fetch("https://api.fraud.com/check", {
      method: "POST",
      body: JSON.stringify({ flightId }),
      signal,
    });
    return res.json() as Promise<{ approved: boolean }>;
  },
  schema: FraudCheckResult,
  retryPolicy: { maxAttempts: 2, intervalSeconds: 1 },
});

// =============================================================================
// PAYMENT WORKFLOW DEFINITION (used as child workflow)
// =============================================================================

const PaymentArgs = z.object({
  amount: z.number(),
  customerId: z.string(),
});

const PaymentResult2 = z.object({ receiptId: z.string() });

const AbortCommand = z.object({ type: z.literal("abort") });

const paymentWorkflow = defineWorkflow({
  name: "payment",
  args: PaymentArgs,
  result: PaymentResult2,
  channels: { abort: AbortCommand },
  execute: async (ctx, args) => {
    ctx.logger.info("Processing payment", { amount: args.amount });
    return { receiptId: `receipt-${args.customerId}-${args.amount}` };
  },
});

// =============================================================================
// EMAIL CAMPAIGN WORKFLOW (used as detached/foreign child)
// =============================================================================

const CampaignArgs = z.object({ customerId: z.string() });
const NudgeCommand = z.object({ type: z.literal("nudge") });

const emailCampaignWorkflow = defineWorkflow({
  name: "emailCampaign",
  args: CampaignArgs,
  channels: { commands: NudgeCommand },
  execute: async (ctx, args) => {
    ctx.logger.info("Running campaign", { customerId: args.customerId });
  },
});

// =============================================================================
// §2b — Sequential workflow (travelBookingWorkflow)
// =============================================================================

const TravelArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
});

export const travelBookingWorkflow = defineWorkflow({
  name: "travelBooking",
  args: TravelArgs,
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel },
  result: z.object({ flightId: z.string(), hotelId: z.string() }),

  async execute(ctx, args) {
    const flight = await ctx.steps
      .bookFlight(args.destination, args.customerId)
      .compensate(async (compCtx, result) => {
        if (result.status === "complete") {
          await compCtx.steps.cancelFlight(args.destination, args.customerId);
        }
      });

    const hotel = await ctx.steps
      .bookHotel(args.destination, args.checkIn, args.checkOut)
      .compensate(async (compCtx, result) => {
        if (result.status === "complete") {
          await compCtx.steps.cancelHotel(
            args.destination,
            args.checkIn,
            args.checkOut,
          );
        }
      });

    return { flightId: flight.id, hotelId: hotel.id };
  },
});

// =============================================================================
// §2c — Race pattern (raceWorkflow)
// =============================================================================

const RaceArgs = z.object({ customerId: z.string() });

export const raceWorkflow = defineWorkflow({
  name: "race",
  args: RaceArgs,
  steps: { bookFlight, cancelFlight },
  result: FlightResult,

  async execute(ctx, args) {
    const winner = await ctx.scope(
      {
        provider1: async () => {
          return await ctx.steps
            .bookFlight("Paris", args.customerId)
            .compensate(async (compCtx, result) => {
              if (result.status === "complete") {
                await compCtx.steps.cancelFlight("Paris", args.customerId);
              }
            });
        },
        provider2: async () => {
          return await ctx.steps
            .bookFlight("Paris", args.customerId)
            .compensate(async (compCtx, result) => {
              if (result.status === "complete") {
                await compCtx.steps.cancelFlight("Paris", args.customerId);
              }
            })
            .retry({ maxAttempts: 5 });
        },
      },
      async ({ provider1, provider2 }) => {
        const sel = ctx.select({ provider1, provider2 });
        const first = await sel.next();
        if (first.key === null) throw new Error("All providers failed");
        return first.data;
      },
    );

    return winner;
  },
});

// =============================================================================
// §2d — Background task (backgroundWorkflow)
// =============================================================================

const BackgroundArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
  email: z.string(),
});

export const backgroundWorkflow = defineWorkflow({
  name: "background",
  args: BackgroundArgs,
  steps: { bookFlight, cancelFlight, sendEmail },
  result: FlightResult,

  async execute(ctx, args) {
    const result = await ctx.scope(
      {
        flight: async () => {
          return await ctx.steps
            .bookFlight(args.destination, args.customerId)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelFlight(
                args.destination,
                args.customerId,
              );
            });
        },
        email: async () => {
          await ctx.steps.sendEmail(
            args.email,
            "Booking Started",
            `Your booking to ${args.destination} has started.`,
          );
        },
      },
      async ({ flight }) => {
        return await flight;
      },
    );

    return result;
  },
});

// =============================================================================
// §2e — Explicit error handling with .failure()/.complete() builders (tryDemoWorkflow)
// =============================================================================

const TryDemoArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
});

export const tryDemoWorkflow = defineWorkflow({
  name: "tryDemo",
  args: TryDemoArgs,
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, reserveCar, cancelCar },
  result: z.object({
    flightId: z.string() .nullable(),
    hotelId: z.string().nullable(),
    carId: z.string().nullable(),
  }),
  state: () => ({
    results: {} as Record<string, string | null>,
  }),

  async execute(ctx, args) {
    // With .compensate() — failure handler receives compensate()
    const flightId = await ctx.steps
      .bookFlight(args.destination, args.customerId)
      .compensate(async (compCtx, result) => {
        if (result.status === "complete") {
          await compCtx.steps.cancelFlight(args.destination, args.customerId);
        }
      })
      .failure(async (failure) => {
        await failure.compensate();
        return null;
      })
      .complete((data) => data.id);

    // Without .compensate() — failure handler receives plain StepFailureInfo
    const carId = await ctx.steps
      .reserveCar(args.destination, `${args.checkIn}-${args.checkOut}`)
      .failure(() => null)
      .complete((data) => {
        ctx.addCompensation(async (compCtx) => {
          await compCtx.steps.cancelCar(
            args.destination,
            `${args.checkIn}-${args.checkOut}`,
          );
        });
        return data.id;
      });

    // Using .failure() inside a scope branch (replaces tryJoin pattern)
    const hotelId = await ctx.scope(
      {
        hotel: async () => {
          return await ctx.steps
            .bookHotel(args.destination, args.checkIn, args.checkOut)
            .compensate(async (compCtx, result) => {
              if (result.status === "complete") {
                await compCtx.steps.cancelHotel(
                  args.destination,
                  args.checkIn,
                  args.checkOut,
                );
              }
            })
            .failure(async (failure) => {
              await failure.compensate();
              return null;
            })
            .complete((data) => data.id);
        },
      },
      async ({ hotel }) => await hotel,
    );

    return { flightId, hotelId, carId };
  },
});

// =============================================================================
// §2f/2g — forEach and match with { complete, failure } handlers
// =============================================================================

const ForEachDemoArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
});

export const forEachDemoWorkflow = defineWorkflow({
  name: "forEachDemo",
  args: ForEachDemoArgs,
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, reserveCar, cancelCar },
  state: () => ({
    results: {} as Record<string, string>,
  }),

  async execute(ctx, args) {
    await ctx.scope(
      {
        flight: async () =>
          ctx.steps.bookFlight(args.destination, args.customerId).compensate(
            async (compCtx, result) => {
              if (result.status === "complete") {
                await compCtx.steps.cancelFlight(
                  args.destination,
                  args.customerId,
                );
              }
            },
          ),
        hotel: async () =>
          ctx.steps
            .bookHotel(args.destination, args.checkIn, args.checkOut)
            .compensate(async (compCtx, result) => {
              if (result.status === "complete") {
                await compCtx.steps.cancelHotel(
                  args.destination,
                  args.checkIn,
                  args.checkOut,
                );
              }
            }),
        car: async () =>
          ctx.steps.reserveCar(
            args.destination,
            `${args.checkIn}-${args.checkOut}`,
          ),
      },
      async ({ flight, hotel, car }) => {
        // forEach with { complete, failure } handlers and a default
        await ctx.forEach(
          { flight, hotel, car },
          {
            flight: {
              complete: (data) => {
                ctx.state.results["flight"] = data.id;
              },
              failure: async (failure) => {
                await failure.compensate();
              },
            },
          },
          (key, data) => {
            ctx.state.results[key] = (data as { id: string }).id;
          },
        );

        // select.match with { complete, failure } handlers
        const sel = ctx.select({ flight, hotel });
        const firstResult = await sel.match(
          {
            flight: {
              complete: (data) => ({ type: "booking" as const, id: data.id }),
              failure: async (failure) => {
                await failure.compensate();
                return null;
              },
            },
          },
          (event) => ({ type: "other" as const, key: event.key }),
          120,
        );

        ctx.logger.info("first result", { result: firstResult });
      },
    );
  },
});

// =============================================================================
// §2h — Child workflow sequential execution
// =============================================================================

const ChildWorkflowArgs = z.object({
  amount: z.number(),
  customerId: z.string(),
});

export const childWorkflowDemo = defineWorkflow({
  name: "childWorkflowDemo",
  args: ChildWorkflowArgs,
  workflows: { payment: paymentWorkflow },
  result: PaymentResult2,
  rng: { paymentId: true },

  async execute(ctx, args) {
    const paymentResult = await ctx.childWorkflows
      .payment({
        workflowId: `payment-${ctx.rng.paymentId.uuidv4()}`,
        args: { amount: args.amount, customerId: args.customerId },
      })
      .compensate(async (compCtx, result) => {
        if (result.status === "complete") {
          compCtx.logger.info("Compensating payment", {
            receiptId: result.data.receiptId,
          });
        }
      });

    return { receiptId: paymentResult.receiptId };
  },
});

// =============================================================================
// §2i — Child workflow in scope
// =============================================================================

const ChildScopeArgs = z.object({
  amount: z.number(),
  customerId: z.string(),
});

export const childWorkflowScopeDemo = defineWorkflow({
  name: "childWorkflowScopeDemo",
  args: ChildScopeArgs,
  workflows: { payment: paymentWorkflow },
  result: z.object({ receiptId: z.string() }),
  rng: { paymentId: true },

  async execute(ctx, args) {
    const secondReceipt = await ctx.scope(
      {
        secondPayment: async () => {
          const result = await ctx.childWorkflows.payment({
            workflowId: `payment-${ctx.rng.paymentId.uuidv4()}-2`,
            args: { amount: 50, customerId: args.customerId },
          });
          return result.receiptId;
        },
      },
      async ({ secondPayment }) => await secondPayment,
    );

    return { receiptId: secondReceipt };
  },
});

// =============================================================================
// §2j — Detached child workflow and foreign handle
// =============================================================================

const DetachedArgs = z.object({
  customerId: z.string(),
  campaignWorkflowId: z.string(),
});

export const detachedWorkflowDemo = defineWorkflow({
  name: "detachedWorkflowDemo",
  args: DetachedArgs,
  workflows: { emailCampaign: emailCampaignWorkflow },
  rng: { campaignId: true },

  async execute(ctx, args) {
    // Start a new detached child workflow
    const notifier = await ctx.childWorkflows
      .emailCampaign({
        workflowId: `campaign-${ctx.rng.campaignId.uuidv4()}`,
        args: { customerId: args.customerId },
      })
      .detached();

    await notifier.channels.commands.send({ type: "nudge" });

    // Access an already-running workflow via foreign handle
    const existing = ctx.foreignWorkflows.emailCampaign.get(
      args.campaignWorkflowId,
    );
    await existing.channels.commands.send({ type: "nudge" });
  },
});

// =============================================================================
// §2k — Compensation context (compensationDemoWorkflow)
// =============================================================================

export const compensationDemoWorkflow = defineWorkflow({
  name: "compensationDemo",
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel },

  async execute(ctx) {
    await ctx.scope(
      {
        flight: async () => {
          return await ctx.steps.bookFlight("Paris", "cust-1").compensate(
            async (compCtx) => {
              const result = await compCtx.steps.cancelFlight(
                "Paris",
                "cust-1",
              );
              if (!result.ok) {
                compCtx.logger.error("Failed to cancel flight");
              }
            },
          );
        },
        hotel: async () => {
          return await ctx.steps
            .bookHotel("Paris", "2026-06-01", "2026-06-07")
            .compensate(async (compCtx) => {
              const result = await compCtx.steps.cancelHotel(
                "Paris",
                "2026-06-01",
                "2026-06-07",
              );
              if (!result.ok) {
                compCtx.logger.error("Failed to cancel hotel");
              }
            });
        },
      },
      async ({ flight, hotel }) => {
        const flightData = await flight;
        const hotelData = await hotel;
        if (flightData.price + hotelData.price > 1000) {
          throw new Error("Budget exceeded");
        }
        return null;
      },
    );
  },
});

// =============================================================================
// §2l — Compensation scope (compensationScopeWorkflow)
// =============================================================================

export const compensationScopeWorkflow = defineWorkflow({
  name: "compensationScope",
  steps: { bookFlight, cancelFlight, sendEmail },

  async execute(ctx) {
    await ctx.steps.bookFlight("Paris", "cust-1").compensate(
      async (compCtx, result) => {
        if (result.status !== "complete") return;
        await compCtx.scope(
          {
            cancel: async () =>
              compCtx.steps.cancelFlight("Paris", "cust-1"),
            notify: async () =>
              compCtx.steps.sendEmail(
                "customer@example.com",
                "Booking Cancelled",
                "Your Paris flight has been cancelled.",
              ),
          },
          async ({ cancel, notify }) => {
            const cancelResult = await cancel;
            if (!cancelResult.ok) {
              compCtx.logger.error("Failed to cancel flight");
            }
            await notify;
          },
        );
      },
    );
  },
});

// =============================================================================
// §2m — NEW: Dynamic fan-out with collections (Map and Array)
// =============================================================================

const FanOutArgs = z.object({
  providerCodes: z.array(z.string()),
  destination: z.string(),
});

export const dynamicFanOutWorkflow = defineWorkflow({
  name: "dynamicFanOut",
  args: FanOutArgs,
  steps: { bookFlight, cancelFlight, getQuote, cancelQuote },
  result: z.object({
    flightId: z.string().nullable(),
    quotes: z.map(z.string(), z.number()),
  }),

  async execute(ctx, args) {
    // Build a Map of closures for dynamic fan-out
    const providers = new Map<string, () => Promise<z.infer<typeof QuoteResult>>>();
    for (const p of args.providerCodes) {
      providers.set(p, async () => {
        return await ctx.steps
          .getQuote(p, args.destination)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelQuote(p);
          });
      });
    }

    const result = await ctx.scope(
      {
        flight: async () =>
          ctx.steps.bookFlight(args.destination, "cust-dynamic").compensate(
            async (compCtx, r) => {
              if (r.status === "complete") {
                await compCtx.steps.cancelFlight(args.destination, "cust-dynamic");
              }
            },
          ),
        quotes: providers,
      },
      async ({ flight, quotes }) => {
        // flight: BranchHandle<FlightResult>
        // quotes: Map<string, BranchHandle<QuoteResult>>

        // Map over mixed collections — output mirrors input structure
        const mapped = await ctx.map(
          { flight, quotes },
          {
            flight: {
              complete: (d) => d.id,
              failure: () => null,
            },
            quotes: {
              // innerKey receives the Map's key (string)
              complete: (d, innerKey) => {
                ctx.logger.info("Got quote", { provider: innerKey, price: d.price });
                return d.price;
              },
              failure: (_failure, innerKey) => {
                ctx.logger.warn("Quote failed", { provider: innerKey });
                return Infinity;
              },
            },
          },
        );

        // mapped.flight is string | null
        // mapped.quotes is Map<string, number | undefined>
        return mapped;
      },
    );

    return {
      flightId: result.flight ?? null,
      quotes: result.quotes as Map<string, number>,
    };
  },
});

// =============================================================================
// §2n — Minimal workflow (direct step call, no builders)
// =============================================================================

export const minimalWorkflow = defineWorkflow({
  name: "minimal",
  steps: { sendEmail },

  async execute(ctx) {
    await ctx.steps.sendEmail("admin@example.com", "Heartbeat", "System is alive");
  },
});

// =============================================================================
// §2o — Patch demo (patchDemoWorkflow)
// =============================================================================

const PatchDemoArgs = z.object({
  flightId: z.string(),
  customerId: z.string(),
});

export const patchDemoWorkflow = defineWorkflow({
  name: "patchDemo",
  args: PatchDemoArgs,
  steps: { bookFlight, cancelFlight, fraudCheck },
  patches: { antifraud: true },
  result: z.object({ bookingId: z.string(), fraudApproved: z.boolean() }),

  async execute(ctx, args) {
    const fraudResult = await ctx.patches.antifraud(async () => {
      const result = await ctx.steps.bookFlight(args.flightId, args.customerId);
      return result.id;
    }, null);

    const flight = await ctx.steps
      .bookFlight(args.flightId, args.customerId)
      .compensate(async (compCtx, result) => {
        if (result.status === "complete") {
          await compCtx.steps.cancelFlight(args.flightId, args.customerId);
        }
      });

    return {
      bookingId: flight.id,
      fraudApproved: fraudResult !== null,
    };
  },
});
