/**
 * Comprehensive examples covering the entire public API surface.
 *
 * 8 workflows, each exercising a distinct slice of the API:
 *
 *   1. heartbeatWorkflow         — minimal step, workflowId, timestamp/date, logger, sleep, streams, events
 *   2. orderWorkflow             — sequential compensation, .failure()/.complete()/.retry(), dontCompensate(),
 *                                  channels.receive(), addCompensation(), state
 *   3. flightBookingWorkflow     — scope, for-await race, nested scope, sel.remaining, .match() loop
 *   4. quoteAggregationWorkflow  — Array/Map fan-out, forEach with innerKey, map collection mirroring
 *   5. paymentOrchestrationWorkflow — childWorkflows (.compensate, .failure, .complete, .detached),
 *                                    foreignWorkflows.get(), addCompensation()
 *   6. channelRaceWorkflow       — channels.receive() standalone, select({branch, channel}) for-await,
 *                                  .match() with default handler
 *   7. campaignWorkflow          — patches (callback + boolean), all rng methods, state factory with rng,
 *                                  retention config
 *   8. compensationHooksWorkflow — beforeCompensate/afterCompensate, compCtx scope/forEach/select for-await,
 *                                  compCtx channels/streams/events, CompensationStepCall.retry(), compCtx.sleep()
 */

import { z } from "zod";
import { defineStep, defineWorkflow } from "./workflow";

// =============================================================================
// SHARED STEP SCHEMAS
// =============================================================================

const FlightResult = z.object({ id: z.string(), price: z.number() });
const HotelResult = z.object({ id: z.string(), price: z.number() });
const QuoteResult = z.object({ price: z.number(), provider: z.string() });
const CancelResult = z.object({ ok: z.boolean() });
const EmailResult = z.object({ sent: z.boolean() });
const PaymentResult = z.object({ receiptId: z.string() });
const ChargeResult = z.object({ chargeId: z.string(), amount: z.number() });
const RefundResult = z.object({ refundId: z.string() });
const NotifyResult = z.object({ notificationId: z.string() });

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

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

const chargeCustomer = defineStep({
  name: "chargeCustomer",
  execute: async ({ signal }, customerId: string, amount: number) => {
    const res = await fetch("https://api.payments.com/charge", {
      method: "POST",
      body: JSON.stringify({ customerId, amount }),
      signal,
    });
    return res.json() as Promise<{ chargeId: string; amount: number }>;
  },
  schema: ChargeResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 5 },
});

const refundCustomer = defineStep({
  name: "refundCustomer",
  execute: async ({ signal }, chargeId: string) => {
    const res = await fetch("https://api.payments.com/refund", {
      method: "POST",
      body: JSON.stringify({ chargeId }),
      signal,
    });
    return res.json() as Promise<{ refundId: string }>;
  },
  schema: RefundResult,
  retryPolicy: { maxAttempts: 10, intervalSeconds: 10 },
});

const sendNotification = defineStep({
  name: "sendNotification",
  execute: async ({ signal }, userId: string, message: string) => {
    const res = await fetch("https://api.notifications.com/send", {
      method: "POST",
      body: JSON.stringify({ userId, message }),
      signal,
    });
    return res.json() as Promise<{ notificationId: string }>;
  },
  schema: NotifyResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

// =============================================================================
// CHILD WORKFLOW DEFINITIONS
// =============================================================================

const PaymentArgs = z.object({
  customerId: z.string(),
  amount: z.number(),
});

const PaymentWorkflowResult = z.object({ receiptId: z.string() });
const AbortCommand = z.object({ type: z.literal("abort") });
const PaymentStatusEvent = z.object({ chargeId: z.string() });

/** Used as a child workflow in paymentOrchestrationWorkflow */
const paymentWorkflow = defineWorkflow({
  name: "payment",
  args: PaymentArgs,
  result: PaymentWorkflowResult,
  channels: { abort: AbortCommand },
  steps: { chargeCustomer, refundCustomer },

  async execute(ctx, args) {
    ctx.logger.info("Processing payment", { amount: args.amount });
    const charge = await ctx.steps
      .chargeCustomer(args.customerId, args.amount)
      .compensate(async (compCtx, _result) => {
        await compCtx.steps.refundCustomer(charge.chargeId);
      });
    return { receiptId: charge.chargeId };
  },
});

const CampaignArgs = z.object({ userId: z.string() });
const NudgeCommand = z.object({ type: z.literal("nudge") });

/** Used as a detached/foreign workflow in paymentOrchestrationWorkflow */
const campaignWorker = defineWorkflow({
  name: "campaignWorker",
  args: CampaignArgs,
  channels: { nudge: NudgeCommand },

  async execute(ctx, args) {
    ctx.logger.info("Campaign started", { userId: args.userId });
    const cmd = await ctx.channels.nudge.receive();
    ctx.logger.info("Campaign nudged", { type: cmd.type });
  },
});

// =============================================================================
// 1. heartbeatWorkflow
//    Covers: bare step, workflowId, timestamp/date, logger, sleep, streams, events
// =============================================================================

export const heartbeatWorkflow = defineWorkflow({
  name: "heartbeat",
  steps: { sendEmail },
  streams: { auditLog: z.object({ msg: z.string(), ts: z.number() }) },
  events: { done: true },

  async execute(ctx) {
    // workflowId, timestamp, date
    ctx.logger.info("Heartbeat started", {
      workflowId: ctx.workflowId,
      ts: ctx.timestamp,
      date: ctx.date.toISOString(),
    });
    ctx.logger.debug("Debug probe");
    ctx.logger.warn("Example warning for demo");
    ctx.logger.error("Example error for demo");

    // Write to stream
    await ctx.streams.auditLog.write({
      msg: "Heartbeat check initiated",
      ts: ctx.timestamp,
    });

    // Durable sleep (1 second)
    await ctx.sleep(1);

    // Run a step — no builders, failure auto-terminates
    await ctx.steps.sendEmail(
      "ops@example.com",
      "Heartbeat",
      `System alive as of ${ctx.date.toISOString()}`,
    );

    // Signal event
    await ctx.events.done.set();

    await ctx.streams.auditLog.write({ msg: "Heartbeat complete", ts: ctx.timestamp });
  },
});

// =============================================================================
// 2. orderWorkflow
//    Covers: sequential compensation (unconditional), .failure()/.complete()/.retry(),
//            dontCompensate(), channels.receive(), addCompensation(), state
// =============================================================================

const OrderArgs = z.object({
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  customerId: z.string(),
  customerEmail: z.string(),
});

const ApprovalMessage = z.object({ approved: z.boolean(), reason: z.string() });

export const orderWorkflow = defineWorkflow({
  name: "order",
  args: OrderArgs,
  channels: { approval: ApprovalMessage },
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },
  result: z.object({
    flightId: z.string().nullable(),
    hotelId: z.string().nullable(),
    approved: z.boolean(),
  }),
  state: () => ({
    phase: "init" as "init" | "flightBooked" | "approved" | "done",
    flightId: null as string | null,
    hotelId: null as string | null,
  }),

  async execute(ctx, args) {
    // General-purpose compensation via addCompensation — sends a failure notification
    ctx.addCompensation(async (compCtx) => {
      compCtx.logger.info("Order failed — notifying customer", {
        workflowId: compCtx.workflowId,
      });
      const result = await compCtx.steps.sendEmail(
        args.customerEmail,
        "Order Failed",
        "We were unable to complete your order. Any charges have been refunded.",
      );
      if (!result.ok) {
        compCtx.logger.error("Failed to send failure notification");
      }
    });

    // Book flight with unconditional compensation, explicit retry override,
    // failure handler (returns null instead of crashing), complete transform
    const flightId = await ctx.steps
      .bookFlight(args.destination, args.customerId)
      .compensate(async (compCtx) => {
        // Compensation always runs if an attempt was made — no status check needed.
        // The step is idempotent: the engine guarantees at-least-once semantics.
        await compCtx.steps.cancelFlight(args.destination, args.customerId);
      })
      .retry({ maxAttempts: 5, intervalSeconds: 2, backoffRate: 1.5 })
      .failure(async (failure) => {
        ctx.logger.warn("Flight booking failed", {
          reason: failure.reason,
          attempts: failure.errors.count,
        });
        // Eagerly discharge the LIFO compensation obligation
        await failure.compensate();
        return null;
      })
      .complete((data) => data.id);

    ctx.state.flightId = flightId;
    ctx.state.phase = "flightBooked";

    // Wait for human approval over a channel (FIFO, blocks until message arrives)
    const approval = await ctx.channels.approval.receive();

    if (!approval.approved) {
      ctx.logger.info("Order rejected", { reason: approval.reason });
      return { flightId: ctx.state.flightId, hotelId: null, approved: false };
    }

    ctx.state.phase = "approved";

    // Book hotel — use scope + map to gain access to BranchFailureInfo,
    // which provides dontCompensate() to explicitly discharge the obligation
    // without running the callback.
    const hotelId = await ctx.scope(
      {
        hotel: async () =>
          ctx.steps
            .bookHotel(args.destination, args.checkIn, args.checkOut)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelHotel(
                args.destination,
                args.checkIn,
                args.checkOut,
              );
            }),
      },
      async ({ hotel }) => {
        const result = await ctx.map(
          { hotel },
          {
            hotel: {
              complete: (data) => data.id as string | null,
              failure: (failure) => {
                // BranchFailureInfo.dontCompensate() — explicitly discharge
                // the LIFO obligation without running the compensation callback.
                // Use when you know the failed operation had no observable
                // side effects (e.g. a third-party timeout before the request
                // ever reached the server).
                failure.dontCompensate();
                ctx.logger.error("Hotel booking failed — no side effects, skipping compensation");
                return null;
              },
            },
          },
        );
        return result.hotel ?? null;
      },
    );

    ctx.state.hotelId = hotelId;
    ctx.state.phase = "done";

    return { flightId: ctx.state.flightId, hotelId: ctx.state.hotelId, approved: true };
  },
});

// =============================================================================
// 3. flightBookingWorkflow
//    Covers: scope closures, for-await race, nested scope, sel.remaining, .match() loop
// =============================================================================

const FlightBookingArgs = z.object({
  destination: z.string(),
  backupDestination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  customerId: z.string(),
  customerEmail: z.string(),
});

export const flightBookingWorkflow = defineWorkflow({
  name: "flightBooking",
  args: FlightBookingArgs,
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },
  result: z.object({ flightId: z.string(), hotelId: z.string() }),

  async execute(ctx, args) {
    // --- Scope 1: Race two flight providers — first successful result wins ---
    const flight = await ctx.scope(
      {
        provider1: async () =>
          ctx.steps
            .bookFlight(`${args.destination}/p1`, args.customerId)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelFlight(
                `${args.destination}/p1`,
                args.customerId,
              );
            }),
        provider2: async () =>
          ctx.steps
            .bookFlight(`${args.destination}/p2`, args.customerId)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelFlight(
                `${args.destination}/p2`,
                args.customerId,
              );
            })
            .retry({ maxAttempts: 5 }),
      },
      async ({ provider1, provider2 }) => {
        const sel = ctx.select({ provider1, provider2 });

        // for await yields the data value from the first successful branch.
        // Any branch failure will auto-terminate the workflow here.
        for await (const data of sel) {
          // First event received — return immediately; scope exit will
          // compensate the still-running branch.
          return data;
        }
        throw new Error("All flight providers exhausted");
      },
    );

    // --- Scope 2: Book a hotel — primary destination, fall back to backup ---
    // Demonstrates: nested scope, sel.remaining, .match() with { complete, failure }
    const hotelId = await ctx.scope(
      {
        primary: async () =>
          ctx.steps
            .bookHotel(args.destination, args.checkIn, args.checkOut)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelHotel(
                args.destination,
                args.checkIn,
                args.checkOut,
              );
            }),
        backup: async () =>
          ctx.steps
            .bookHotel(args.backupDestination, args.checkIn, args.checkOut)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelHotel(
                args.backupDestination,
                args.checkIn,
                args.checkOut,
              );
            }),
      },
      async ({ primary, backup }) => {
        const sel = ctx.select({ primary, backup });

        // Drive a .match() loop — explicit { complete, failure } per key.
        // sel.remaining shrinks as handles resolve.
        while (sel.remaining.size > 0) {
          const result = await sel.match({
            primary: {
              complete: (data) => ({ ok: true as const, id: data.id, dest: args.destination }),
              failure: async (failure) => {
                ctx.logger.warn("Primary hotel failed — falling back");
                await failure.compensate();
                return { ok: false as const, id: null, dest: null };
              },
            },
            backup: {
              complete: (data) => ({ ok: true as const, id: data.id, dest: args.backupDestination }),
              failure: async (failure) => {
                ctx.logger.error("Backup hotel also failed");
                await failure.compensate();
                return { ok: false as const, id: null, dest: null };
              },
            },
          });

          if (result.status === "exhausted") break;
          if (result.data.ok) {
            ctx.logger.info("Hotel booked", { dest: result.data.dest });
            return result.data.id;
          }
        }
        throw new Error("No hotel available at primary or backup destination");
      },
    );

    // Confirmation email — no compensation needed (email is fire-and-forget)
    await ctx.steps.sendEmail(
      args.customerEmail,
      "Booking Confirmed",
      `Flight: ${flight.id}, Hotel: ${hotelId}`,
    );

    return { flightId: flight.id, hotelId };
  },
});

// =============================================================================
// 4. quoteAggregationWorkflow
//    Covers: Array fan-out, Map fan-out, forEach with innerKey, map collection mirroring
// =============================================================================

const QuoteAggregationArgs = z.object({
  destination: z.string(),
  providers: z.array(z.string()),
});

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
    // Array fan-out: BranchHandle<QuoteResult>[] — innerKey is index (number)
    const arrayBranches = args.providers.map(
      (p) => async () =>
        ctx.steps
          .getQuote(p, args.destination)
          .compensate(async (compCtx) => {
            await compCtx.steps.cancelQuote(p);
          }),
    );

    const arrayPrices: number[] = [];

    await ctx.scope(
      { quotes: arrayBranches },
      async ({ quotes }) => {
        // forEach on BranchHandle[] — callback receives (data, innerKey: number)
        await ctx.forEach(
          { quotes },
          {
            quotes: {
              complete: (data, innerKey) => {
                ctx.logger.info("Array quote received", {
                  idx: innerKey,
                  provider: data.provider,
                  price: data.price,
                });
                arrayPrices.push(data.price);
              },
              failure: (_failure, innerKey) => {
                ctx.logger.warn("Array quote failed", { idx: innerKey });
              },
            },
          },
        );
      },
    );

    // Map fan-out: Map<string, BranchHandle<QuoteResult>> — innerKey is provider name
    const mapBranches = new Map(
      args.providers.map((p) => [
        p,
        async () =>
          ctx.steps
            .getQuote(p, args.destination)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelQuote(p);
            }),
      ]),
    );

    // map on Map<string, BranchHandle<T>> — innerKey is the map's key (string)
    const mapped = await ctx.scope(
      { quotes: mapBranches },
      async ({ quotes }) =>
        ctx.map(
          { quotes },
          {
            quotes: {
              complete: (data, innerKey) => ({ price: data.price, provider: innerKey }),
              failure: (_failure, innerKey) => {
                ctx.logger.warn("Map quote failed", { provider: innerKey });
                return null;
              },
            },
          },
        ),
    );

    // mapped.quotes is Map<string, { price: number; provider: string } | null>
    let bestProvider: string | null = null;
    let lowestPrice: number | null = null;
    const allPrices = new Map<string, number>();

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

// =============================================================================
// 5. paymentOrchestrationWorkflow
//    Covers: childWorkflows (.compensate, .failure, .complete, .detached),
//            foreignWorkflows.get(), addCompensation()
// =============================================================================

const PaymentOrchestrationArgs = z.object({
  customerId: z.string(),
  amount: z.number(),
  existingCampaignId: z.string(),
});

export const paymentOrchestrationWorkflow = defineWorkflow({
  name: "paymentOrchestration",
  args: PaymentOrchestrationArgs,
  workflows: { payment: paymentWorkflow, campaignWorker },
  result: z.object({
    receiptId: z.string().nullable(),
    campaignStarted: z.boolean(),
  }),
  rng: { ids: true },

  async execute(ctx, args) {
    // addCompensation for audit logging — runs even if individual steps succeed
    ctx.addCompensation(async (compCtx) => {
      compCtx.logger.info("Payment orchestration compensating", {
        workflowId: compCtx.workflowId,
      });
    });

    // childWorkflows with all result-mode builders: .compensate, .failure, .complete
    const receiptId = await ctx.childWorkflows
      .payment({
        workflowId: `payment-${ctx.rng.ids.uuidv4()}`,
        args: { customerId: args.customerId, amount: args.amount },
      })
      .compensate(async (compCtx, _result) => {
        // Unconditional: the payment child may have charged the customer even
        // if we didn't receive a success response — always attempt refund via
        // the child's own compensation logic.
        compCtx.logger.info("Triggering payment child compensation");
      })
      .failure(async (failure) => {
        if (failure.status === "failed") {
          ctx.logger.error("Payment workflow failed", {
            error: failure.error.message,
          });
        } else {
          ctx.logger.error("Payment workflow terminated");
        }
        await failure.compensate();
        return null;
      })
      .complete((data) => data.receiptId);

    // .detached() — fire-and-forget; mutually exclusive with result builders
    const campaignHandle = await ctx.childWorkflows
      .campaignWorker({
        workflowId: `campaign-${ctx.rng.ids.uuidv4()}`,
        args: { userId: args.customerId },
      })
      .detached();

    // ForeignWorkflowHandle: channels.send() only — no lifecycle coupling
    const foreign = ctx.foreignWorkflows.campaignWorker.get(
      args.existingCampaignId,
    );
    await foreign.channels.nudge.send({ type: "nudge" });

    // Also nudge the freshly started campaign
    await campaignHandle.channels.nudge.send({ type: "nudge" });

    return { receiptId, campaignStarted: true };
  },
});

// =============================================================================
// 6. channelRaceWorkflow
//    Covers: channels.receive() standalone, select({ branch, channel }) for-await,
//            .match() with default handler
// =============================================================================

const ChannelRaceArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
});

const CancelCommand = z.object({ type: z.literal("cancel"), reason: z.string() });

export const channelRaceWorkflow = defineWorkflow({
  name: "channelRace",
  args: ChannelRaceArgs,
  channels: { cancel: CancelCommand },
  steps: { bookFlight, cancelFlight },
  result: z.object({
    outcome: z.enum(["booked", "cancelled"]),
    flightId: z.string().nullable(),
  }),

  async execute(ctx, args) {
    // Race a branch handle against a channel receive using for await
    const outcome = await ctx.scope(
      {
        booking: async () =>
          ctx.steps
            .bookFlight(args.destination, args.customerId)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelFlight(args.destination, args.customerId);
            }),
      },
      async ({ booking }) => {
        const sel = ctx.select({ booking, cancel: ctx.channels.cancel });

        // for await races the booking branch against the cancel channel.
        // Branch failure auto-terminates; channel emits on each message.
        for await (const data of sel) {
          ctx.logger.info("Race event received", { data });

          // On first event (either booking result or cancel message) decide outcome.
          // We distinguish by shape — booking data has `id`, cancel has `type`.
          if ("id" in data) {
            return { outcome: "booked" as const, flightId: (data as { id: string }).id };
          }
          return { outcome: "cancelled" as const, flightId: null };
        }
        throw new Error("Selection exhausted unexpectedly");
      },
    );

    if (outcome.outcome === "cancelled") {
      ctx.logger.info("Booking cancelled by user");
      return { outcome: "cancelled" as const, flightId: null };
    }

    // Also demonstrate: standalone channels.receive() (not in select)
    // Wait for a second cancel message — if it arrives we've already booked,
    // so we just log it.
    const cancelMsg = await ctx.scope(
      {
        booking2: async () =>
          ctx.steps
            .bookFlight(`${args.destination}-2`, args.customerId)
            .compensate(async (compCtx) => {
              await compCtx.steps.cancelFlight(
                `${args.destination}-2`,
                args.customerId,
              );
            }),
      },
      async ({ booking2 }) => {
        const sel2 = ctx.select({ booking2, cancel2: ctx.channels.cancel });

        // .match() with default handler for events not covered by the main map
        const result = await sel2.match(
          {
            booking2: {
              complete: (data) => ({ type: "booked" as const, id: data.id }),
              failure: async (failure) => {
                await failure.compensate();
                return { type: "failed" as const, id: null };
              },
            },
          },
          // Default handler fires for the "cancel2" channel event
          (event) => ({
            type: "unhandled" as const,
            key: event.key,
          }),
        );

        return result;
      },
    );

    ctx.logger.info("Second scope result", { cancelMsg });

    return { outcome: "booked" as const, flightId: outcome.flightId };
  },
});

// =============================================================================
// 7. campaignWorkflow
//    Covers: patches (callback + boolean form), all rng methods, state factory
//            using rng, retention config
// =============================================================================

const CampaignWorkflowArgs = z.object({
  userId: z.string(),
  candidates: z.array(z.string()),
});

export const campaignWorkflow = defineWorkflow({
  name: "campaign",
  args: CampaignWorkflowArgs,
  steps: { sendNotification },
  streams: { events: z.object({ type: z.string(), data: z.unknown() }) },

  patches: {
    multiChannel: true,   // active: new workflows use multi-channel path
    legacySms: false,     // deprecated: kept for in-flight replay, not for new runs
  },

  rng: {
    session: true,
    // Parametrized RNG: different candidates get different seeds
    cohort: (userId: string, wave: number) => `cohort:${userId}:${wave}`,
  },

  state: ({ rng }) => ({
    // State factory receives rng — allows deterministic initial state
    sessionId: rng.session.uuidv4(),
    cohortSeed: rng.cohort("setup", 0).int(1, 100),
    launched: false,
    sentCount: 0,
  }),

  retention: {
    complete: 7 * 24 * 3600,     // 7 days
    failed: 30 * 24 * 3600,      // 30 days
    terminated: 24 * 3600,       // 1 day
  },

  async execute(ctx, args) {
    ctx.logger.info("Campaign starting", {
      sessionId: ctx.state.sessionId,
      cohortSeed: ctx.state.cohortSeed,
    });

    // --- Deterministic RNG methods ---
    const sessionRng = ctx.rng.session;

    // uuidv4 — deterministic UUID
    const campaignId = sessionRng.uuidv4();

    // int — integer in [1, 10]
    const batchSize = sessionRng.int(1, 10);

    // next — float in [0, 1)
    const threshold = sessionRng.next();

    // bool / chance
    const runExperiment = sessionRng.bool();
    const sendImmediately = sessionRng.chance(0.8);

    // pick — random element
    const firstCandidate = sessionRng.pick(args.candidates);

    // weightedPick
    const selectedTier = sessionRng.weightedPick([
      { value: "premium", weight: 20 },
      { value: "standard", weight: 70 },
      { value: "basic", weight: 10 },
    ]);

    // shuffle — random order
    const shuffled = sessionRng.shuffle(args.candidates);

    // sample — N random elements without replacement
    const sampled = sessionRng.sample(args.candidates, Math.min(batchSize, args.candidates.length));

    // string — random string
    const token = sessionRng.string({ length: 16, alphabet: "abcdef0123456789" });

    // bytes
    const nonce = sessionRng.bytes(8);

    // Parametrized RNG — different seed per wave
    const wave1Rng = ctx.rng.cohort(args.userId, 1);
    const wave1Id = wave1Rng.uuidv4();

    ctx.logger.info("Campaign params computed", {
      campaignId,
      batchSize,
      threshold,
      runExperiment,
      sendImmediately,
      firstCandidate,
      selectedTier,
      shuffled,
      sampled,
      token,
      nonceLength: nonce.length,
      wave1Id,
    });

    await ctx.streams.events.write({ type: "campaign_start", data: { campaignId } });

    // --- Patches ---

    // Boolean form: check if legacySms patch is active
    const useLegacySms = await ctx.patches.legacySms();
    if (useLegacySms) {
      ctx.logger.info("Using legacy SMS path (replaying old workflow)");
    }

    // Callback form: run new multi-channel code if patch is active
    const notificationId = await ctx.patches.multiChannel(async () => {
      const result = await ctx.steps.sendNotification(
        args.userId,
        `Campaign ${campaignId}: you are selected for ${selectedTier}`,
      );
      return result.notificationId;
    }, null);

    ctx.state.launched = true;

    // Send to each candidate in the sampled batch
    for (const candidate of sampled) {
      await ctx.steps.sendNotification(
        candidate,
        `Campaign wave from ${args.userId}, token: ${token}`,
      );
      ctx.state.sentCount += 1;
    }

    await ctx.streams.events.write({
      type: "campaign_complete",
      data: { campaignId, notificationId, sent: ctx.state.sentCount },
    });
  },
});

// =============================================================================
// 8. compensationHooksWorkflow
//    Covers: beforeCompensate/afterCompensate hooks, compCtx.scope(), compCtx.forEach(),
//            compCtx.select() for-await, compCtx.channels.receive(), compCtx.streams.write(),
//            compCtx.events.set(), CompensationStepCall.retry(), compCtx.sleep()
// =============================================================================

const CompensationHooksArgs = z.object({
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  customerId: z.string(),
  notificationEmail: z.string(),
});

const CompensationCommand = z.object({ type: z.literal("ack") });

export const compensationHooksWorkflow = defineWorkflow({
  name: "compensationHooks",
  args: CompensationHooksArgs,
  channels: { compAck: CompensationCommand },
  streams: { compLog: z.object({ msg: z.string(), ts: z.number() }) },
  events: { compensationStarted: true, compensationComplete: true },
  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },

  // beforeCompensate — runs BEFORE any compensation callbacks fire
  beforeCompensate: async ({ ctx, args }) => {
    ctx.logger.info("Compensation starting", { workflowId: ctx.workflowId });
    await ctx.streams.compLog.write({
      msg: `Compensation started for ${args.destination}`,
      ts: ctx.timestamp,
    });
    await ctx.events.compensationStarted.set();

    // Wait for external acknowledgement that it is safe to proceed
    const ack = await ctx.channels.compAck.receive();
    ctx.logger.info("Compensation ack received", { type: ack.type });

    await ctx.sleep(1);
  },

  // afterCompensate — runs AFTER all compensation callbacks complete
  afterCompensate: async ({ ctx, args }) => {
    ctx.logger.info("All compensations done");

    // Run two notifications concurrently using compCtx.scope()
    await ctx.scope(
      {
        logEntry: async () => {
          const result = await ctx.steps.sendEmail(
            args.notificationEmail,
            "Order Compensated",
            `Your order to ${args.destination} was cancelled and refunded.`,
          );
          return result;
        },
        auditEntry: async () => {
          const result = await ctx.steps
            .sendEmail(
              "audit@example.com",
              "Compensation Complete",
              `Workflow ${ctx.workflowId} fully compensated.`,
            )
            .retry({ maxAttempts: 5 });
          return result;
        },
      },
      async ({ logEntry, auditEntry }) => {
        // compCtx.forEach() — process both results; handle failure gracefully
        await ctx.forEach(
          { logEntry, auditEntry },
          {
            logEntry: (data) => {
              if (!data.ok) ctx.logger.warn("Customer notification failed to send");
            },
            auditEntry: (data) => {
              if (!data.ok) ctx.logger.warn("Audit notification failed to send");
            },
          },
        );
      },
    );

    await ctx.streams.compLog.write({
      msg: "Compensation finalized",
      ts: ctx.timestamp,
    });
    await ctx.events.compensationComplete.set();
  },

  async execute(ctx, args) {
    // Book flight and hotel with unconditional compensation callbacks.
    // The compensation context (compCtx) demonstrating various CompensationContext APIs
    // is exercised in the .compensate() callbacks below.

    await ctx.steps
      .bookFlight(args.destination, args.customerId)
      .compensate(async (compCtx) => {
        // CompensationStepCall.retry() — override retry policy on the cancel step
        const result = await compCtx.steps
          .cancelFlight(args.destination, args.customerId)
          .retry({ maxAttempts: 15, intervalSeconds: 10, backoffRate: 2 });

        if (!result.ok) {
          compCtx.logger.error("Flight cancellation failed after retries", {
            reason: result.reason,
          });
        }
      });

    await ctx.steps
      .bookHotel(args.destination, args.checkIn, args.checkOut)
      .compensate(async (compCtx) => {
        // compCtx.scope() — cancel hotel and send notification concurrently
        await compCtx.scope(
          {
            cancel: async () =>
              compCtx.steps
                .cancelHotel(args.destination, args.checkIn, args.checkOut)
                .retry({ maxAttempts: 10 }),
            notify: async () =>
              compCtx.steps.sendEmail(
                args.notificationEmail,
                "Hotel Cancelled",
                `Hotel booking for ${args.destination} was cancelled.`,
              ),
          },
          async ({ cancel, notify }) => {
            const sel = compCtx.select({ cancel, notify });

            // compCtx.select() for-await — process all branch results as they arrive;
            // branch failure auto-terminates this compensation scope.
            for await (const _data of sel) {
              compCtx.logger.debug("Compensation branch resolved");
            }
          },
        );

        // compCtx.streams.write()
        await compCtx.streams.compLog.write({
          msg: `Hotel compensation complete for ${args.destination}`,
          ts: compCtx.timestamp,
        });
      });

    // This workflow is designed to always fail — triggering the compensation chain
    // and showcasing the hooks above.
    throw new Error("Intentional failure to trigger compensation demo");
  },
});
