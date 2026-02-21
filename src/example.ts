import { z } from "zod";
import { Pool } from "pg";
import { defineStep, defineWorkflow } from "./workflow";
import { WorkflowEngine } from "./engine";

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

/**
 * Flight booking result schema.
 */
const FlightBookingResult = z.object({
  id: z.string(),
  price: z.number(),
});

/**
 * Hotel booking result schema.
 */
const HotelBookingResult = z.object({
  id: z.string(),
  price: z.number(),
});

/**
 * Car reservation result schema.
 */
const CarReservationResult = z.object({
  id: z.string(),
  price: z.number(),
});

/**
 * Step: Book a flight.
 * Demonstrates: flattened defineStep with retry config, typed args/result.
 */
const bookFlight = defineStep({
  name: "bookFlight",
  execute: async ({ signal }, destination: string, customerId: string) => {
    console.log("Booking flight", { destination, customerId });
    const response = await fetch("https://api.flights.com/book", {
      method: "POST",
      body: JSON.stringify({ destination, customerId }),
      signal,
    });
    if (!response.ok) throw new Error("Flight booking failed");
    return FlightBookingResult.parse(await response.json());
  },
  schema: FlightBookingResult,
  retryPolicy: {
    maxAttempts: 3,
    intervalSeconds: 2,
    backoffRate: 2,
  },
});

/**
 * Step: Cancel a flight (idempotent).
 * Used inside compensation callbacks to undo bookFlight.
 */
const cancelFlight = defineStep({
  name: "cancelFlight",
  execute: async ({ signal }, destination: string, customerId: string) => {
    console.log("Cancelling flight by route", { destination, customerId });
    await fetch("https://api.flights.com/cancel-by-route", {
      method: "POST",
      body: JSON.stringify({ destination, customerId }),
      signal,
    });
    return undefined;
  },
  schema: z.undefined(),
  retryPolicy: {
    maxAttempts: 20,
    intervalSeconds: 5,
  },
});

/**
 * Step: Book a hotel.
 */
const bookHotel = defineStep({
  name: "bookHotel",
  execute: async (
    { signal },
    city: string,
    checkIn: string,
    checkOut: string,
  ) => {
    console.log("Booking hotel", { city, checkIn, checkOut });
    const response = await fetch("https://api.hotels.com/book", { signal });
    return HotelBookingResult.parse(await response.json());
  },
  schema: HotelBookingResult,
  retryPolicy: {
    maxAttempts: 3,
  },
});

/**
 * Step: Cancel a hotel (idempotent).
 */
const cancelHotel = defineStep({
  name: "cancelHotel",
  execute: async (
    { signal },
    city: string,
    checkIn: string,
    checkOut: string,
  ) => {
    console.log("Cancelling hotel", { city, checkIn, checkOut });
    await fetch("https://api.hotels.com/cancel-by-reservation", {
      method: "POST",
      body: JSON.stringify({ city, checkIn, checkOut }),
      signal,
    });
    return undefined;
  },
  schema: z.undefined(),
  retryPolicy: {
    maxAttempts: 10,
  },
});

/**
 * Step: Reserve a car.
 */
const reserveCar = defineStep({
  name: "reserveCar",
  execute: async ({ signal }, city: string, dates: string) => {
    console.log("Reserving car", { city, dates });
    const response = await fetch("https://api.cars.com/reserve", { signal });
    return CarReservationResult.parse(await response.json());
  },
  schema: CarReservationResult,
  retryPolicy: {
    maxAttempts: 3,
  },
});

/**
 * Step: Cancel a car reservation (idempotent).
 */
const cancelCar = defineStep({
  name: "cancelCar",
  execute: async ({ signal }, city: string, dates: string) => {
    console.log("Cancelling car reservation", { city, dates });
    await fetch("https://api.cars.com/cancel-by-reservation", {
      method: "POST",
      body: JSON.stringify({ city, dates }),
      signal,
    });
    return undefined;
  },
  schema: z.undefined(),
  retryPolicy: {
    maxAttempts: 10,
  },
});

/**
 * Step: Send email (fire-and-forget, no compensation needed).
 */
const sendEmail = defineStep({
  name: "sendEmail",
  execute: async ({ signal }, to: string, subject: string, body: string) => {
    console.log("Sending email", { to, subject });
    await fetch("https://api.email.com/send", {
      method: "POST",
      body: JSON.stringify({ to, subject, body }),
      signal,
    });
    return undefined;
  },
  schema: z.undefined(),
  retryPolicy: {
    maxAttempts: 1,
  },
});

/**
 * Step: Process payment.
 */
const processPayment = defineStep({
  name: "processPayment",
  execute: async ({ signal }, amount: number, txnId: string) => {
    console.log("Processing payment", { amount, txnId });
    return { success: true, receiptId: `receipt-${txnId}` };
  },
  schema: z.object({
    success: z.boolean(),
    receiptId: z.string(),
  }),
});

/**
 * Step: Refund payment (idempotent).
 */
const refundPayment = defineStep({
  name: "refundPayment",
  execute: async ({ signal }, amount: number, txnId: string) => {
    console.log("Refunding payment", { amount, txnId });
    return undefined;
  },
  schema: z.undefined(),
  retryPolicy: {
    maxAttempts: 10,
  },
});

// =============================================================================
// WORKFLOW: Sequential Booking — happy-path model, compensation callbacks
// =============================================================================

const TravelBookingArgs = z.object({
  customerId: z.string(),
  destination: z.string(),
  checkInDate: z.string(),
  checkOutDate: z.string(),
});

/**
 * Demonstrates the happy-path model for sequential workflows.
 *
 * Showcases:
 * - `.execute()` returns T directly — no `if (!result.ok) throw` boilerplate
 * - Compensation callbacks with CompensationContext and step result
 * - addCompensation for general-purpose cleanup
 * - Automatic workflow termination on step failure
 * - LIFO compensation ordering
 */
const travelBookingWorkflow = defineWorkflow({
  name: "travelBooking",

  args: TravelBookingArgs,

  state: () => ({
    bookingId: "",
    status: "pending" as "pending" | "booked" | "paid",
    totalCost: 0,
  }),

  retention: {
    complete: 86400 * 365,
    failed: 86400 * 90,
    terminated: 86400 * 30,
  },

  channels: {
    payment: z.object({
      amount: z.number(),
      txnId: z.string(),
    }),
    userCommand: z.object({
      command: z.enum(["cancel", "upgrade"]),
    }),
  },

  streams: {
    progress: z.object({
      step: z.string(),
      message: z.string(),
      timestamp: z.number(),
    }),
  },

  events: {
    bookingConfirmed: true,
    paymentReceived: true,
  },

  steps: {
    bookFlight,
    cancelFlight,
    bookHotel,
    cancelHotel,
    sendEmail,
    processPayment,
    refundPayment,
  },

  async beforeCompensate({ ctx, args }) {
    await ctx.streams.progress.write({
      step: "compensation",
      message: `Starting compensation for ${args.destination}`,
      timestamp: ctx.timestamp,
    });
  },

  async afterCompensate({ ctx, args }) {
    // Steps in compensation hooks return CompensationStepResult (must handle failures)
    const emailResult = await ctx.steps.sendEmail.execute(
      "customer@example.com",
      "Booking Cancelled",
      `Your booking for ${args.destination} has been cancelled. Refunds are being processed.`,
    );
    if (!emailResult.ok) {
      ctx.logger.error("Failed to send cancellation email", {
        status: emailResult.status,
      });
    }

    await ctx.streams.progress.write({
      step: "compensated",
      message: "All compensations complete",
      timestamp: ctx.timestamp,
    });
  },

  async execute(ctx, args) {
    ctx.state.bookingId = ctx.workflowId;

    ctx.logger.info("Starting travel booking workflow", {
      destination: args.destination,
      customerId: args.customerId,
    });

    await ctx.streams.progress.write({
      step: "start",
      message: `Travel booking started for ${args.destination}`,
      timestamp: ctx.timestamp,
    });

    // -----------------------------------------------------------------------
    // Book flight — .execute() returns T directly (happy path!)
    // Compensation callback receives CompensationContext + StepCompensationResult
    // -----------------------------------------------------------------------
    ctx.logger.info("Booking flight");
    const flight = await ctx.steps.bookFlight.execute(
      args.destination,
      args.customerId,
      {
        compensate: async (compCtx, result) => {
          // result.status is "complete" | "failed" | "terminated"
          // We attempt cancellation regardless — idempotent best-effort
          const cancelResult = await compCtx.steps.cancelFlight.execute(
            args.destination,
            args.customerId,
          );
          if (!cancelResult.ok) {
            compCtx.logger.error("Failed to cancel flight", {
              reason: cancelResult.status,
              errors: await cancelResult.errors.all(),
            });
          }
        },
      },
    );
    // flight is { id: string, price: number } — the decoded result DIRECTLY

    ctx.state.totalCost += flight.price;

    ctx.logger.info("Flight booked", {
      flightId: flight.id,
      price: flight.price,
    });

    await ctx.streams.progress.write({
      step: "flight",
      message: `Flight booked: ${flight.id}`,
      timestamp: ctx.timestamp,
    });

    // -----------------------------------------------------------------------
    // Book hotel — .execute() returns T directly
    // -----------------------------------------------------------------------
    ctx.logger.info("Booking hotel");
    const hotel = await ctx.steps.bookHotel.execute(
      args.destination,
      args.checkInDate,
      args.checkOutDate,
      {
        compensate: async (compCtx, result) => {
          await compCtx.steps.cancelHotel.execute(
            args.destination,
            args.checkInDate,
            args.checkOutDate,
          );
        },
      },
    );
    // If hotel fails, workflow auto-terminates.
    // Compensations run LIFO: hotel comp (sees "failed"), flight comp (sees "complete").

    ctx.state.totalCost += hotel.price;
    ctx.state.status = "booked";

    await ctx.streams.progress.write({
      step: "hotel",
      message: `Hotel booked: ${hotel.id}`,
      timestamp: ctx.timestamp,
    });

    await ctx.events.bookingConfirmed.set();

    // -----------------------------------------------------------------------
    // Wait for payment (channels are unchanged — Go-style result)
    // -----------------------------------------------------------------------
    ctx.logger.info("Waiting for payment", { totalCost: ctx.state.totalCost });
    const paymentResult = await ctx.channels.payment.receive(300, {
      suspendAfter: 60,
    });

    if (!paymentResult.ok) {
      throw new Error("Payment timeout");
      // Both flight and hotel compensations will run
    }

    const payment = paymentResult.data;
    ctx.logger.info("Processing payment", { amount: payment.amount });

    // Process payment — .execute() returns T directly
    const paymentStep = await ctx.steps.processPayment.execute(
      payment.amount,
      payment.txnId,
      {
        compensate: async (compCtx, result) => {
          await compCtx.steps.refundPayment.execute(
            payment.amount,
            payment.txnId,
          );
        },
      },
    );

    ctx.state.status = "paid";
    await ctx.events.paymentReceived.set();

    await ctx.streams.progress.write({
      step: "payment",
      message: `Payment received: $${payment.amount}`,
      timestamp: ctx.timestamp,
    });

    // -----------------------------------------------------------------------
    // addCompensation — general-purpose cleanup
    // -----------------------------------------------------------------------
    ctx.addCompensation(async (compCtx) => {
      await compCtx.streams.progress.write({
        step: "cleanup",
        message: "General cleanup during compensation",
        timestamp: compCtx.timestamp,
      });
    });

    // -----------------------------------------------------------------------
    // Send confirmation email — .execute() returns T directly (no compensation)
    // -----------------------------------------------------------------------
    ctx.logger.info("Sending confirmation email");
    await ctx.steps.sendEmail.execute(
      "customer@example.com",
      "Booking Confirmed",
      `Your trip to ${args.destination} is confirmed!`,
    );

    ctx.logger.info("Travel booking completed", {
      bookingId: ctx.state.bookingId,
      totalCost: ctx.state.totalCost,
    });

    return {
      bookingId: ctx.state.bookingId,
      totalCost: ctx.state.totalCost,
    };
  },

  result: z.object({
    bookingId: z.string(),
    totalCost: z.number(),
  }),
});

// =============================================================================
// WORKFLOW: Race Pattern — scope with compensation callbacks
// =============================================================================

const RaceWorkflowArgs = z.object({
  customerId: z.string(),
});

/**
 * Demonstrates the race pattern with structured concurrency.
 *
 * Showcases:
 * - ctx.scope() — structured concurrency primitive
 * - Compensation callbacks on .start() — full CompensationContext + result
 * - Scope exit: handles with compensate → compensated; handles without → settled
 * - select inside scope — only successful events in happy-path model
 */
const raceWorkflow = defineWorkflow({
  name: "race",

  args: RaceWorkflowArgs,

  steps: { bookFlight, cancelFlight },

  result: z.object({ winnerId: z.string() }),

  async execute(ctx, args) {
    ctx.logger.info("Starting race workflow", {
      customerId: args.customerId,
    });

    const winner = await ctx.scope(
      {
        // Both providers start concurrently
        // compensate callback = loser gets compensated on scope exit
        provider1: ctx.steps.bookFlight.start("Paris", args.customerId, {
          compensate: async (compCtx, result) => {
            if (result.status === "complete") {
              await compCtx.steps.cancelFlight.execute(
                "Paris",
                args.customerId,
              );
            }
          },
        }),
        provider2: ctx.steps.bookFlight.start("Paris", args.customerId, {
          compensate: async (compCtx, result) => {
            if (result.status === "complete") {
              await compCtx.steps.cancelFlight.execute(
                "Paris",
                args.customerId,
              );
            }
          },
          retryPolicy: { maxAttempts: 5 },
        }),
      },
      async ({ provider1, provider2 }) => {
        // provider1 and provider2 are StepHandle<FlightBookingResult>
        const sel = ctx.select({ provider1, provider2 });
        const first = await sel.next();
        if (first.key === null) throw new Error("All providers failed");
        return first.data;
        // Scope exits → loser's compensate callback fires
        // (the engine interleaves compensation callbacks via virtual event loop)
      },
    );

    return { winnerId: winner.id };
  },
});

// =============================================================================
// WORKFLOW: Background Task — scope without compensation
// =============================================================================

const BackgroundWorkflowArgs = z.object({
  destination: z.string(),
  customerId: z.string(),
  email: z.string(),
});

/**
 * Demonstrates scope behavior without compensation.
 *
 * Showcases:
 * - Handles without compensate → settled on scope exit (waited for, result ignored)
 * - Handles with compensate → compensated on scope exit
 * - Mixing compensated and non-compensated handles
 */
const backgroundWorkflow = defineWorkflow({
  name: "background",

  args: BackgroundWorkflowArgs,

  steps: { bookFlight, cancelFlight, sendEmail },

  result: z.object({ flightId: z.string() }),

  async execute(ctx, args) {
    const result = await ctx.scope(
      {
        flight: ctx.steps.bookFlight.start(args.destination, args.customerId, {
          compensate: async (compCtx, result) => {
            await compCtx.steps.cancelFlight.execute(
              args.destination,
              args.customerId,
            );
          },
        }),
        // No compensate → settled on scope exit (wait for completion, ignore result)
        email: ctx.steps.sendEmail.start(
          args.email,
          "Booking Started",
          "...",
        ),
      },
      async ({ flight, email }) => {
        // Join only the flight — email runs in background
        const flightData = await flight.join();
        // When scope exits: email is settled (waited for, result ignored)
        return flightData;
      },
    );

    return { flightId: result.id };
  },
});

// =============================================================================
// WORKFLOW: forEach + map with { onComplete, onFailure } handlers
// =============================================================================

const BatchArgs = z.object({
  customerId: z.string(),
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
});

/**
 * Demonstrates forEach and map with the new API.
 *
 * Showcases:
 * - forEach with positional default handler
 * - forEach with { onComplete, onFailure } handler entries
 * - map with { onComplete, onFailure } — onFailure return value is fallback
 * - Happy-path: plain callbacks receive data T directly (not result union)
 * - onFailure receives CompensationContext, failure info, and { compensate } tools
 */
const batchWorkflow = defineWorkflow({
  name: "batch",

  args: BatchArgs,

  state: () => ({
    results: {} as Record<string, string>,
  }),

  steps: {
    bookFlight,
    cancelFlight,
    bookHotel,
    cancelHotel,
    reserveCar,
    cancelCar,
  },

  result: z.object({
    bookingIds: z.record(z.string(), z.string()),
  }),

  async execute(ctx, args) {
    ctx.logger.info("Starting batch workflow", {
      destination: args.destination,
    });

    // -----------------------------------------------------------------------
    // Start all in a scope
    // -----------------------------------------------------------------------
    await ctx.scope(
      {
        flight: ctx.steps.bookFlight.start(args.destination, args.customerId, {
          compensate: async (compCtx, result) => {
            await compCtx.steps.cancelFlight.execute(
              args.destination,
              args.customerId,
            );
          },
        }),
        hotel: ctx.steps.bookHotel.start(
          args.destination,
          args.checkIn,
          args.checkOut,
          {
            compensate: async (compCtx, result) => {
              await compCtx.steps.cancelHotel.execute(
                args.destination,
                args.checkIn,
                args.checkOut,
              );
            },
          },
        ),
        car: ctx.steps.reserveCar.start(
          args.destination,
          `${args.checkIn}-${args.checkOut}`,
          {
            compensate: async (compCtx, result) => {
              await compCtx.steps.cancelCar.execute(
                args.destination,
                `${args.checkIn}-${args.checkOut}`,
              );
            },
          },
        ),
      },
      async ({ flight, hotel, car }) => {
        // -------------------------------------------------------------------
        // forEach with { onComplete, onFailure } + positional default
        // -------------------------------------------------------------------
        await ctx.forEach(
          { flight, hotel, car },
          {
            // { onComplete, onFailure } for explicit failure handling
            flight: {
              onComplete: (data) => {
                ctx.state.results["flight"] = data.id;
              },
              onFailure: async (failure) => {
                // failure: { reason, errors, compensate }
                ctx.logger.error("Flight booking failed", {
                  reason: failure.reason,
                });
                // Explicitly run compensation to discharge SAGA obligation
                await failure.compensate();
              },
            },
          },
          // Positional default — only receives keys NOT in handlers (hotel, car)
          // TypeScript narrows: key is "hotel" | "car", data is their union type
          (key, data) => {
            ctx.logger.info(`${key} completed`, { id: data.id });
            ctx.state.results[key] = data.id;
          },
        );

        return null;
      },
    );

    // -----------------------------------------------------------------------
    // map example — { onComplete, onFailure } handlers
    // -----------------------------------------------------------------------
    const ids = await ctx.scope(
      {
        flight: ctx.steps.bookFlight.start(args.destination, args.customerId, {
          compensate: async (compCtx, result) => {
            await compCtx.steps.cancelFlight.execute(
              args.destination,
              args.customerId,
            );
          },
        }),
        hotel: ctx.steps.bookHotel.start(
          args.destination,
          args.checkIn,
          args.checkOut,
          {
            compensate: async (compCtx, result) => {
              await compCtx.steps.cancelHotel.execute(
                args.destination,
                args.checkIn,
                args.checkOut,
              );
            },
          },
        ),
      },
      async ({ flight, hotel }) => {
        // map returns { flight: string | undefined, hotel: string | undefined }
        const result = await ctx.map(
          { flight, hotel },
          {
            // { onComplete, onFailure } — onFailure return value is the fallback
            flight: {
              onComplete: (data) => data.id,
              onFailure: async (failure) => {
                ctx.logger.warn("Flight failed, using fallback");
                await failure.compensate();
                return "FLIGHT_FAILED";
              },
            },
            // Plain function: failure crashes the workflow (happy-path default)
            hotel: (data) => data.id,
          },
        );
        return result;
      },
    );

    ctx.logger.info("Map results", { ids });

    return {
      bookingIds: ctx.state.results,
    };
  },
});

// =============================================================================
// WORKFLOW: Select with match + { onComplete, onFailure } + default + timeout
// =============================================================================

const ConcurrentArgs = z.object({
  customerId: z.string(),
  destination: z.string(),
});

/**
 * Demonstrates select with the new match API.
 *
 * Showcases:
 * - select with happy-path events (.next() crashes workflow on failure)
 * - match with positional default handler
 * - match with { onComplete, onFailure } handlers
 * - onFailure returns a fallback value for match
 * - match with timeout
 * - Async iteration (for await...of) — only sees successful events
 * - sel.remaining
 */
const concurrentWorkflow = defineWorkflow({
  name: "concurrent",

  args: ConcurrentArgs,

  state: () => ({
    completedBookings: [] as string[],
    totalCost: 0,
  }),

  channels: {
    abort: z.object({
      reason: z.string(),
    }),
  },

  events: {
    allBooked: true,
  },

  steps: {
    bookFlight,
    cancelFlight,
    bookHotel,
    cancelHotel,
    reserveCar,
    cancelCar,
  },

  result: z.object({
    bookings: z.array(z.string()),
    totalCost: z.number(),
  }),

  async execute(ctx, args) {
    ctx.logger.info("Starting concurrent workflow", {
      destination: args.destination,
    });

    const result = await ctx.scope(
      {
        flight: ctx.steps.bookFlight.start(args.destination, args.customerId, {
          compensate: async (compCtx, result) => {
            await compCtx.steps.cancelFlight.execute(
              args.destination,
              args.customerId,
            );
          },
        }),
        hotel: ctx.steps.bookHotel.start(
          args.destination,
          "2026-06-01",
          "2026-06-07",
          {
            compensate: async (compCtx, result) => {
              await compCtx.steps.cancelHotel.execute(
                args.destination,
                "2026-06-01",
                "2026-06-07",
              );
            },
          },
        ),
        car: ctx.steps.reserveCar.start(
          args.destination,
          "2026-06-01-2026-06-07",
          {
            compensate: async (compCtx, result) => {
              await compCtx.steps.cancelCar.execute(
                args.destination,
                "2026-06-01-2026-06-07",
              );
            },
          },
        ),
      },
      async ({ flight, hotel, car }) => {
        // Select multiplexes handles + a channel for external abort
        const sel = ctx.select({
          flight,
          hotel,
          car,
          abort: ctx.channels.abort,
        });

        // -------------------------------------------------------------------
        // match with { onComplete, onFailure }, positional default, + timeout
        // -------------------------------------------------------------------
        const firstResult = await sel.match(
          {
            // { onComplete, onFailure } for explicit failure recovery
            flight: {
              onComplete: (data) => ({
                type: "booking" as const,
                id: data.id,
              }),
              onFailure: async (failure) => {
                // failure: { reason, errors, compensate }
                ctx.logger.error("Flight booking failed in match", {
                  reason: failure.reason,
                });
                // Compensate explicitly and return a fallback value
                await failure.compensate();
                return { type: "booking" as const, id: "FAILED" };
              },
            },
            // Channel handler: plain function (channels can't fail)
            abort: (data) => null,
          },
          // Positional default — only receives unhandled keys (hotel, car)
          (event) => ({
            type: "other" as const,
            key: event.key,
          }),
          120, // timeout in seconds
        );

        if (!firstResult.ok) {
          ctx.logger.warn("Match did not produce a result", {
            status: firstResult.status, // "timeout" | "exhausted"
          });
        }

        // -------------------------------------------------------------------
        // Remaining handles
        // -------------------------------------------------------------------
        ctx.logger.info("Remaining handles", {
          remaining: Array.from(sel.remaining),
        });

        // -------------------------------------------------------------------
        // Async iteration — only sees successful step events
        // If a step/child fails, the workflow auto-terminates
        // -------------------------------------------------------------------
        for await (const event of sel) {
          if (event.key === "abort") {
            ctx.logger.info("Abort signal received", {
              reason: event.data.reason,
            });
            break;
          }

          // Step events — only successful data
          ctx.state.completedBookings.push(`${event.key}:${event.data.id}`);
          ctx.state.totalCost += event.data.price;
        }

        return {
          bookings: ctx.state.completedBookings,
          totalCost: ctx.state.totalCost,
        };
      },
    );

    if (result.bookings.length === 0) {
      throw new Error("No bookings completed");
    }

    await ctx.events.allBooked.set();

    return result;
  },
});

// =============================================================================
// WORKFLOW: Payment Processing — child workflow
// =============================================================================

const PaymentArgs = z.object({
  amount: z.number(),
  customerId: z.string(),
});

const paymentWorkflow = defineWorkflow({
  name: "payment",

  args: PaymentArgs,

  streams: {
    auditLog: z.object({
      event: z.string(),
      timestamp: z.number(),
    }),
  },

  events: {
    processed: true,
    settled: true,
  },

  steps: { processPayment, refundPayment },

  rng: {
    txn: true,
  },

  result: z.object({
    receiptId: z.string(),
    settledAt: z.number(),
  }),

  async execute(ctx, { amount, customerId }) {
    ctx.logger.info("Starting payment processing", {
      amount,
      customerId,
    });

    await ctx.streams.auditLog.write({
      event: `Payment initiated: $${amount}`,
      timestamp: ctx.timestamp,
    });

    const txnId = ctx.rng.txn.uuidv4();

    // .execute() returns T directly in workflow context
    const result = await ctx.steps.processPayment.execute(amount, txnId, {
      compensate: async (compCtx, stepResult) => {
        await compCtx.steps.refundPayment.execute(amount, txnId);
      },
    });

    await ctx.events.processed.set();

    await ctx.streams.auditLog.write({
      event: `Payment processed: ${result.receiptId}`,
      timestamp: ctx.timestamp,
    });

    await ctx.sleep(5);

    await ctx.events.settled.set();

    return {
      receiptId: result.receiptId,
      settledAt: ctx.timestamp,
    };
  },
});

// =============================================================================
// WORKFLOW: Parent — child workflow interaction
// =============================================================================

const ParentWorkflowArgs = z.object({
  customerId: z.string(),
  amount: z.number(),
});

/**
 * Demonstrates parent-child workflow interaction.
 *
 * Showcases:
 * - ctx.workflows.payment.execute() returns T directly (happy path)
 * - Child workflows in scope — no unjoined strategy, just compensate presence
 * - Reading child streams
 * - Observing child lifecycle events and user-defined events
 * - Child workflow compensation callback
 */
const parentWorkflow = defineWorkflow({
  name: "parentWorkflow",

  args: ParentWorkflowArgs,

  workflows: {
    payment: paymentWorkflow,
  },

  steps: { sendEmail },

  rng: {
    paymentId: true,
  },

  result: z.object({
    paymentReceiptId: z.string(),
  }),

  async execute(ctx, args) {
    ctx.logger.info("Starting parent workflow", {
      customerId: args.customerId,
    });

    // -----------------------------------------------------------------------
    // Sequential child workflow — .execute() returns T directly
    // -----------------------------------------------------------------------
    const paymentResult = await ctx.workflows.payment.execute({
      workflowId: `payment-${ctx.rng.paymentId.uuidv4()}`,
      args: { amount: args.amount, customerId: args.customerId },
      suspendAfter: 30,
      compensate: async (compCtx, result) => {
        if (result.status === "complete") {
          compCtx.logger.info("Compensating successful payment", {
            receiptId: result.data.receiptId,
          });
        }
      },
    });
    // paymentResult is { receiptId: string, settledAt: number } directly

    // -----------------------------------------------------------------------
    // Child workflow in scope
    // -----------------------------------------------------------------------
    const secondReceipt = await ctx.scope(
      {
        secondPayment: ctx.workflows.payment.start({
          workflowId: `payment-${ctx.rng.paymentId.uuidv4()}-2`,
          args: { amount: 50, customerId: args.customerId },
          // No compensate → settled on scope exit (wait for completion, ignore)
        }),
      },
      async ({ secondPayment }) => {
        // Read from child's stream while waiting
        const auditIterator = secondPayment.streams.auditLog.iterator(0);
        const auditEntry = await auditIterator.read(86400, {
          suspendAfter: 0,
        });
        if (auditEntry.ok) {
          ctx.logger.info("Audit entry received", {
            event: auditEntry.data.event,
          });
        }

        // Observe child lifecycle events
        const processed = await secondPayment.events.processed.wait(60);
        if (processed.ok) {
          ctx.logger.info("Second payment processed");
        }

        // Join returns T directly
        const result = await secondPayment.join({ suspendAfter: 30 });
        return result.receiptId;
      },
    );

    // Send confirmation email — .execute() returns T
    await ctx.steps.sendEmail.execute(
      "customer@example.com",
      "Payment Confirmed",
      `Payment receipts: ${paymentResult.receiptId}, ${secondReceipt}`,
    );

    return { paymentReceiptId: paymentResult.receiptId };
  },
});

// =============================================================================
// WORKFLOW: Coordinator — cross-workflow messaging (fire-and-forget)
// =============================================================================

/**
 * Demonstrates sending messages to other workflows via .get() handle.
 * Only channels.send() is available (fire-and-forget, severely limited).
 */
const coordinatorWorkflow = defineWorkflow({
  name: "coordinator",

  workflows: {
    travel: travelBookingWorkflow,
  },

  rng: {
    txnId: true,
  },

  result: z.object({ coordinated: z.boolean() }),

  async execute(ctx) {
    ctx.logger.info("Starting coordinator");

    const travelHandle = ctx.workflows.travel.get("booking-123");

    await travelHandle.channels.payment.send({
      amount: 500,
      txnId: "txn-" + ctx.rng.txnId.uuidv4(),
    });

    await ctx.sleep(10);

    await travelHandle.channels.userCommand.send({
      command: "upgrade",
    });

    return { coordinated: true };
  },
});

// =============================================================================
// WORKFLOW: Minimal — no state, no args, happy path
// =============================================================================

const minimalWorkflow = defineWorkflow({
  name: "minimal",

  steps: { sendEmail },

  result: z.object({ done: z.boolean() }),

  async execute(ctx) {
    ctx.logger.info("Running minimal workflow");

    // .execute() returns T directly — no ok check needed
    await ctx.steps.sendEmail.execute(
      "admin@example.com",
      "Heartbeat",
      "System is alive",
    );
    // If sendEmail fails, workflow auto-terminates

    return { done: true };
  },
});

// =============================================================================
// WORKFLOW: Compensation Context Demo — full structured concurrency
// =============================================================================

/**
 * Demonstrates the CompensationContext with full structured concurrency.
 *
 * Showcases:
 * - Steps in CompensationContext return CompensationStepResult (with ok)
 * - scope() in compensation — concurrent compensation operations
 * - select() in compensation — failures visible in event types
 * - forEach() in compensation — callbacks receive result unions
 * - Virtual event loop: engine interleaves compensation callbacks from the
 *   same scope transparently; developer writes sequential code
 * - Inspecting errors via StepErrorAccessor
 */
const compensationDemoWorkflow = defineWorkflow({
  name: "compensationDemo",

  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },

  streams: {
    issues: z.object({
      code: z.string(),
      errors: z.array(z.unknown()),
      meta: z.record(z.string(), z.unknown()),
    }),
    updates: z.object({
      info: z.string(),
    }),
  },

  channels: {
    flightCancelCustomerService: z.object({
      resolution: z.string(),
    }),
  },

  result: z.object({ success: z.boolean() }),

  async execute(ctx) {
    // -----------------------------------------------------------------------
    // Book flight + hotel in scope with compensation callbacks
    // The engine interleaves these compensation callbacks via virtual event loop
    // -----------------------------------------------------------------------
    await ctx.scope(
      {
        flight: ctx.steps.bookFlight.start("Paris", "cust-1", {
          compensate: async (compCtx) => {
            // This is sequential code, but the engine runs it concurrently
            // with hotel's compensation callback via the virtual event loop
            const result = await compCtx.steps.cancelFlight.execute(
              "Paris",
              "cust-1",
            );
            if (!result.ok) {
              await compCtx.streams.issues.write({
                code: "flight-cancellation-failed",
                errors: await result.errors.all(),
                meta: { destination: "Paris", customerId: "cust-1" },
              });
              // Human-in-the-loop: wait for customer service resolution
              const resolution =
                await compCtx.channels.flightCancelCustomerService.receive();
              compCtx.logger.info("Customer service resolution", {
                resolution: resolution.resolution,
              });
            }
          },
        }),
        hotel: ctx.steps.bookHotel.start("Paris", "2026-06-01", "2026-06-07", {
          compensate: async (compCtx) => {
            // This runs concurrently with flight's compensation via virtual event loop
            await compCtx.streams.updates.write({
              info: "Cancelling hotel reservation",
            });
            const result = await compCtx.steps.cancelHotel.execute(
              "Paris",
              "2026-06-01",
              "2026-06-07",
            );
            if (!result.ok) {
              compCtx.logger.error("Hotel cancellation failed", {
                errors: await result.errors.all(),
              });
            }
          },
        }),
      },
      async ({ flight, hotel }) => {
        const flightData = await flight.join();
        const hotelData = await hotel.join();

        if (flightData.price + hotelData.price > 1000) {
          throw new Error("Budget exceeded");
          // Both compensation callbacks fire — engine interleaves them
        }

        return null;
      },
    );

    return { success: true };
  },
});

// =============================================================================
// WORKFLOW: Compensation Scope Demo — scope/select/forEach in compensation
// =============================================================================

/**
 * Demonstrates structured concurrency INSIDE CompensationContext.
 *
 * Showcases:
 * - compCtx.scope() — concurrent compensation operations with handles
 * - compCtx.select() — multiplexed waiting with failures visible in events
 * - compCtx.forEach() — process compensation handle results with explicit failure handling
 * - CompensationStepHandle.join() returns CompensationStepResult (not T)
 * - All unjoined handles in compensation scope are settled (no compensation nesting)
 */
const compensationScopeWorkflow = defineWorkflow({
  name: "compensationScope",

  steps: { bookFlight, cancelFlight, bookHotel, cancelHotel, sendEmail },

  result: z.object({ success: z.boolean() }),

  async execute(ctx) {
    // Book flight with compensation that uses scope() internally
    const flight = await ctx.steps.bookFlight.execute("Paris", "cust-1", {
      compensate: async (compCtx, result) => {
        if (result.status !== "complete") return;

        // Use scope() inside compensation for concurrent undo operations
        await compCtx.scope(
          {
            cancel: compCtx.steps.cancelFlight.start("Paris", "cust-1"),
            notify: compCtx.steps.sendEmail.start(
              "customer@example.com",
              "Flight Cancelled",
              `Flight ${result.data.id} has been cancelled`,
            ),
          },
          async ({ cancel, notify }) => {
            // CompensationStepHandle.join() returns CompensationStepResult
            const cancelResult = await cancel.join();
            if (!cancelResult.ok) {
              compCtx.logger.error("Cancel failed", {
                errors: await cancelResult.errors.all(),
              });
            }

            const notifyResult = await notify.join();
            if (!notifyResult.ok) {
              compCtx.logger.error("Notify failed");
            }
          },
        );
      },
    });

    // Book hotel with compensation that uses select() + forEach()
    const hotel = await ctx.steps.bookHotel.execute(
      "Paris",
      "2026-06-01",
      "2026-06-07",
      {
        compensate: async (compCtx, result) => {
          if (result.status !== "complete") return;

          // Use scope + select inside compensation
          await compCtx.scope(
            {
              cancel: compCtx.steps.cancelHotel.start(
                "Paris",
                "2026-06-01",
                "2026-06-07",
              ),
              notify: compCtx.steps.sendEmail.start(
                "customer@example.com",
                "Hotel Cancelled",
                `Hotel ${result.data.id} cancelled`,
              ),
            },
            async ({ cancel, notify }) => {
              // select in compensation — events include failures
              const sel = compCtx.select({ cancel, notify });

              for await (const event of sel) {
                // Events in compensation include ok/status for step handles
                if (event.key === "cancel") {
                  if (event.ok) {
                    compCtx.logger.info("Hotel cancellation succeeded");
                  } else {
                    compCtx.logger.error("Hotel cancellation failed", {
                      reason: event.reason,
                    });
                  }
                } else if (event.key === "notify") {
                  if (event.ok) {
                    compCtx.logger.info("Notification sent");
                  } else {
                    compCtx.logger.error("Notification failed");
                  }
                }
              }
            },
          );
        },
      },
    );

    // Force failure to trigger compensation
    if (flight.price + hotel.price > 1000) {
      throw new Error("Budget exceeded");
    }

    return { success: true };
  },
});

// =============================================================================
// WORKFLOW: tryExecute / tryJoin — explicit error handling without auto-termination
// =============================================================================

const TryDemoArgs = z.object({
  customerId: z.string(),
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
});

/**
 * Demonstrates tryExecute and tryJoin for explicit error handling.
 *
 * Key concepts:
 * - tryExecute/tryJoin accept { onComplete, onFailure } callbacks — the same
 *   pattern used by match, forEach, and map.
 * - With `compensate` → onFailure gets `tools` with `compensate()` for eager
 *   discharge. If not called, engine runs it at scope exit (safe default).
 * - Without `compensate` → onFailure does NOT get `tools` (full type safety).
 * - Calling `tools.compensate()` switches to compensation mode (SIGTERM-resilient).
 * - Both callbacks return the same or compatible types — the result is their union.
 *
 * Showcases:
 * 1. tryExecute WITH compensate → eager discharge via tools.compensate()
 * 2. tryExecute WITHOUT compensate → no tools, manual management
 * 3. tryExecute on child workflow → handles "terminated" with tools.compensate()
 * 4. tryJoin on handle started WITH compensate → tools in onFailure
 * 5. tryJoin on handle started WITHOUT compensate → no tools in onFailure
 */
const tryDemoWorkflow = defineWorkflow({
  name: "tryDemo",

  args: TryDemoArgs,

  state: () => ({
    flightId: null as string | null,
    hotelId: null as string | null,
    carId: null as string | null,
  }),

  steps: {
    bookFlight,
    cancelFlight,
    bookHotel,
    cancelHotel,
    reserveCar,
    cancelCar,
    sendEmail,
  },

  workflows: {
    payment: paymentWorkflow,
  },

  rng: {
    paymentId: true,
  },

  result: z.object({
    flightId: z.union([z.string(), z.null()]),
    hotelId: z.union([z.string(), z.null()]),
    carId: z.union([z.string(), z.null()]),
    paymentStatus: z.string(),
  }),

  async execute(ctx, args) {
    ctx.logger.info("Starting try demo workflow");

    // -----------------------------------------------------------------------
    // 1. tryExecute WITH compensate
    //    onFailure receives failure info with compensate() for eager discharge.
    //    Compensation is registered on LIFO before execution (SIGTERM-safe).
    //    Returns the value from whichever callback fires.
    // -----------------------------------------------------------------------
    const flightId = await ctx.steps.bookFlight.tryExecute(
      args.destination,
      args.customerId,
      {
        compensate: async (compCtx, result) => {
          if (result.status === "complete") {
            await compCtx.steps.cancelFlight.execute(
              args.destination,
              args.customerId,
            );
          }
        },
        onComplete: (data) => {
          ctx.logger.info("Flight booked", { id: data.id });
          return data.id;
        },
        onFailure: async (failure) => {
          // failure: { reason, errors, compensate }
          // Eagerly discharge: switches to compensation mode (SIGTERM-resilient),
          // runs the callback to completion, removes from LIFO stack.
          await failure.compensate();
          ctx.logger.warn("Flight booking failed, compensated eagerly", {
            reason: failure.reason,
            errorCount: failure.errors.count,
          });
          return null;
        },
      },
    );
    ctx.state.flightId = flightId;

    // -----------------------------------------------------------------------
    // 2. tryExecute WITHOUT compensate
    //    onFailure receives plain failure info — no compensate() present.
    //    The type system enforces this: compensate property doesn't exist.
    // -----------------------------------------------------------------------
    const carId = await ctx.steps.reserveCar.tryExecute(
      args.destination,
      `${args.checkIn}-${args.checkOut}`,
      {
        onComplete: (data) => {
          ctx.addCompensation(async (compCtx) => {
            await compCtx.steps.cancelCar.execute(
              args.destination,
              `${args.checkIn}-${args.checkOut}`,
            );
          });
          return data.id;
        },
        onFailure: (failure) => {
          // failure: { reason, errors } — no compensate() present.
          ctx.logger.info("Car reservation failed, not critical");
          return null;
        },
      },
    );
    ctx.state.carId = carId;

    // -----------------------------------------------------------------------
    // 3. tryExecute on child workflow WITH compensate
    //    Handles "terminated" status (admin killed the child externally).
    //    failure.compensate() available for both "failed" and "terminated"
    //    outcomes since compensation was registered.
    // -----------------------------------------------------------------------
    const paymentStatus = await ctx.workflows.payment.tryExecute({
      workflowId: `payment-${ctx.rng.paymentId.uuidv4()}`,
      args: { amount: 100, customerId: args.customerId },
      suspendAfter: 30,
      compensate: async (compCtx, result) => {
        if (result.status === "complete") {
          compCtx.logger.info("Refunding payment", {
            receiptId: result.data.receiptId,
          });
        }
      },
      onComplete: (data) => `paid:${data.receiptId}`,
      onFailure: async (failure) => {
        // failure: { status, ..., compensate }
        if (failure.status === "failed") {
          ctx.logger.error("Payment failed", {
            error: failure.error.message,
          });
          // Don't call failure.compensate() — let LIFO handle it (safe default).
          return "failed";
        }
        // failure.status === "terminated"
        // Admin killed the child workflow. Eagerly discharge compensation.
        await failure.compensate();
        ctx.logger.warn("Payment workflow terminated, compensated eagerly");
        return "terminated";
      },
    });

    // -----------------------------------------------------------------------
    // 4. tryJoin on handle started WITH compensate
    //    StepHandle<T, true> — onFailure includes compensate() on failure obj.
    // -----------------------------------------------------------------------
    const hotelId = await ctx.scope(
      {
        hotel: ctx.steps.bookHotel.start(
          args.destination,
          args.checkIn,
          args.checkOut,
          {
            compensate: async (compCtx, result) => {
              if (result.status === "complete") {
                await compCtx.steps.cancelHotel.execute(
                  args.destination,
                  args.checkIn,
                  args.checkOut,
                );
              }
            },
          },
        ),
      },
      async ({ hotel }) => {
        // hotel is StepHandle<T, true> — tryJoin's onFailure includes compensate()
        return await hotel.tryJoin({
          onComplete: (data) => data.id,
          onFailure: async (failure) => {
            // failure: { reason, errors, compensate }
            await failure.compensate();
            ctx.logger.warn("Hotel booking failed, compensated eagerly", {
              reason: failure.reason,
            });
            return null;
          },
        });
      },
    );
    ctx.state.hotelId = hotelId;

    // -----------------------------------------------------------------------
    // 5. tryJoin on handle started WITHOUT compensate
    //    StepHandle<T, false> — onFailure receives plain failure info.
    // -----------------------------------------------------------------------
    await ctx.scope(
      {
        email: ctx.steps.sendEmail.start(
          "customer@example.com",
          "Booking Summary",
          `Flight: ${ctx.state.flightId ?? "N/A"}, Hotel: ${ctx.state.hotelId ?? "N/A"}, Car: ${ctx.state.carId ?? "N/A"}`,
        ),
      },
      async ({ email }) => {
        // email is StepHandle<T, false> — no compensate() on failure
        await email.tryJoin({
          onComplete: () => {},
          onFailure: (failure) => {
            // failure: { reason, errors } — no compensate() present.
            ctx.logger.warn("Email failed, not critical");
          },
        });
      },
    );

    return {
      flightId: ctx.state.flightId,
      hotelId: ctx.state.hotelId,
      carId: ctx.state.carId,
      paymentStatus,
    };
  },
});

// =============================================================================
// WORKFLOW: Patch Demo — safe workflow evolution
// =============================================================================

const PatchDemoArgs = z.object({
  flightId: z.string(),
  customerId: z.string(),
});

/**
 * Demonstrates patches for safe workflow code evolution.
 *
 * Showcases:
 * - Callback form: Adding new code (antifraud check)
 * - Boolean form: Removing old code (legacy email)
 * - Deprecated patch: requireSelfie is false — new workflows skip it
 */
const patchDemoWorkflow = defineWorkflow({
  name: "patchDemo",

  args: PatchDemoArgs,

  steps: { bookFlight, sendEmail },

  patches: {
    antifraud: true,
    removeLegacyEmail: true,
    requireSelfie: false,
  },

  result: z.object({
    flightId: z.string(),
    fraudCheckResult: z.union([z.string(), z.null()]),
  }),

  async execute(ctx, args) {
    ctx.logger.info("Starting patch demo workflow", {
      flightId: args.flightId,
    });

    // Callback form — .execute() returns T directly in happy-path model
    const fraudResult = await ctx.patches.antifraud(async () => {
      const result = await ctx.steps.bookFlight.execute(
        args.flightId,
        args.customerId,
      );
      return result.id; // T is the decoded result, access .id directly
    }, null);

    ctx.logger.info("Fraud check result", { fraudResult });

    // Boolean form — removing old code
    if (!(await ctx.patches.removeLegacyEmail())) {
      await ctx.steps.sendEmail.execute(
        "legacy@example.com",
        "Legacy Notification",
        `Flight ${args.flightId} booked (legacy path)`,
      );
    }

    // Deprecated patch
    if (await ctx.patches.requireSelfie()) {
      ctx.logger.info("Selfie verification required (old workflow path)");
    }

    await ctx.steps.sendEmail.execute(
      "customer@example.com",
      "Booking Confirmed",
      `Flight ${args.flightId} confirmed`,
    );

    return {
      flightId: args.flightId,
      fraudCheckResult: fraudResult,
    };
  },
});

// =============================================================================
// WORKFLOW: Suspend Demo — explicit suspension at blocking points
// =============================================================================

const SuspendDemoArgs = z.object({
  orderId: z.string(),
  customerId: z.string(),
});

/**
 * Demonstrates explicit workflow suspension at blocking points.
 *
 * Showcases:
 * - ctx.sleep() with { suspend: true } — immediate eviction for long sleeps
 * - ctx.channels.receive() with { suspendAfter } — hot window then suspend
 * - ctx.workflows.execute() with { suspendAfter } — child workflow shorthand
 * - Deliberate non-suspension for short/frequent waits
 * - select is NOT suspendable (holds live handle references in memory)
 */
const suspendDemoWorkflow = defineWorkflow({
  name: "suspendDemo",

  args: SuspendDemoArgs,

  channels: {
    approval: z.object({
      approved: z.boolean(),
      approvedBy: z.string(),
    }),
    playerAction: z.object({
      action: z.string(),
    }),
  },

  workflows: {
    payment: paymentWorkflow,
  },

  steps: { sendEmail },

  result: z.object({
    orderId: z.string(),
    settled: z.boolean(),
  }),

  async execute(ctx, args) {
    ctx.logger.info("Starting suspend demo", { orderId: args.orderId });

    // 1. Long sleep with suspension
    await ctx.sleep(86400 * 7, { suspend: true });

    // 2. Channel receive with hot window
    const approval = await ctx.channels.approval.receive(86400 * 30, {
      suspendAfter: 600,
    });
    if (!approval.ok) throw new Error("Approval timeout — 30 days exceeded");

    // No timeout → returns T directly (no discriminated union)
    const approval2 = await ctx.channels.approval.receive({
      suspendAfter: 600,
    });
    // approval2 is the decoded message directly — e.g. { approved: boolean }

    // 3. Child workflow .execute() with suspendAfter — returns T directly
    const paymentResult = await ctx.workflows.payment.execute({
      workflowId: `payment-${args.orderId}`,
      args: { amount: 100, customerId: args.customerId },
      suspendAfter: 30,
    });
    // paymentResult is { receiptId: string, settledAt: number } directly

    // 4. Short sleep — no suspension
    await ctx.sleep(5);

    // 5. Fast channel receive — no suspension
    const action = await ctx.channels.playerAction.receive(120);
    if (!action.ok) throw new Error("Player action timeout");

    // 6. select is NOT suspendable
    const sel = ctx.select({
      action: ctx.channels.playerAction,
      approval: ctx.channels.approval,
    });

    const event = await sel.next(60);
    if (event.key === "action") {
      ctx.logger.info("Player action via select", {
        action: event.data.action,
      });
    }

    await ctx.steps.sendEmail.execute(
      "customer@example.com",
      "Order Complete",
      `Order ${args.orderId} has been fulfilled.`,
    );

    return {
      orderId: args.orderId,
      settled: true,
    };
  },
});

// =============================================================================
// EXTERNAL USAGE — engine-level error observability
// =============================================================================

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const engine = new WorkflowEngine({
    pool,
    workflows: {
      travelBooking: travelBookingWorkflow,
      race: raceWorkflow,
      background: backgroundWorkflow,
      batch: batchWorkflow,
      concurrent: concurrentWorkflow,
      payment: paymentWorkflow,
      parent: parentWorkflow,
      coordinator: coordinatorWorkflow,
      minimal: minimalWorkflow,
      compensationDemo: compensationDemoWorkflow,
      compensationScope: compensationScopeWorkflow,
      tryDemo: tryDemoWorkflow,
      patchDemo: patchDemoWorkflow,
      suspendDemo: suspendDemoWorkflow,
    },
  });

  await engine.start();

  // =========================================================================
  // Run a minimal workflow — engine.execute() returns WorkflowResult with ok/status
  // =========================================================================

  const minimalResult = await engine.workflows.minimal.execute({
    workflowId: "minimal-" + Date.now(),
  });

  if (minimalResult.ok) {
    console.log("Minimal workflow completed:", minimalResult.data);
  } else {
    console.log("Minimal workflow failed:", minimalResult.status);
  }

  // =========================================================================
  // Start a travel booking workflow (with handle for interactive use)
  // =========================================================================

  const handle = await engine.workflows.travelBooking.start({
    workflowId: "booking-" + Date.now(),
    args: {
      customerId: "customer-123",
      destination: "Paris",
      checkInDate: "2026-06-01",
      checkOutDate: "2026-06-07",
    },
    retention: 86400 * 365 * 5,
  });

  console.log("Started workflow:", handle.workflowId);

  // =========================================================================
  // Lifecycle events — engine-managed, with "never" semantics
  // =========================================================================

  const started = await handle.lifecycle.started.wait({
    signal: AbortSignal.timeout(10_000),
  });
  if (started.ok) {
    console.log("Workflow started!");
  }

  const completeCheck = await handle.lifecycle.complete.get();
  if (completeCheck.ok) {
    console.log("Workflow already complete");
  } else if (completeCheck.status === "not_set") {
    console.log("Still running...");
  } else if (completeCheck.status === "never") {
    console.log("Workflow will never complete (failed/terminated)");
  }

  // =========================================================================
  // Send a message (engine level)
  // =========================================================================

  const sendResult = await handle.channels.payment.send({
    amount: 500,
    txnId: "txn-123",
  });

  if (sendResult.ok) {
    console.log("Payment message sent");
  } else {
    console.log("Workflow not found");
  }

  // =========================================================================
  // Wait for user-defined events
  // =========================================================================

  const eventResult = await handle.events.bookingConfirmed.wait({
    signal: AbortSignal.timeout(60_000),
  });
  if (eventResult.ok) {
    console.log("Booking confirmed!");
  } else if (eventResult.status === "never") {
    console.log("Event will never be set — workflow finished without it");
  } else if (eventResult.status === "timeout") {
    console.log("Timed out waiting for confirmation");
  }

  // =========================================================================
  // Read from stream using iterator
  // =========================================================================

  const progressIterator = handle.streams.progress.iterator(0);
  while (true) {
    const record = await progressIterator.read({
      signal: AbortSignal.timeout(5_000),
    });
    if (record.ok) {
      console.log(`Progress [${record.offset}]:`, record.data);
    } else if (record.status === "closed") {
      console.log("Stream closed");
      break;
    } else {
      console.log("No new records (timeout)");
      break;
    }
  }

  const firstRecord = await handle.streams.progress.read(0, {
    signal: AbortSignal.timeout(5_000),
  });
  if (firstRecord.ok) {
    console.log("First record:", firstRecord.data);
  }

  // =========================================================================
  // Get final result — engine-level with error observability
  // =========================================================================

  const finalResult = await handle.getResult({
    signal: AbortSignal.timeout(300_000),
  });
  if (finalResult.ok) {
    console.log("Workflow completed:", finalResult.data);
  } else {
    switch (finalResult.status) {
      case "failed":
        console.log("Workflow failed:", finalResult.error.message);
        console.log("Error type:", finalResult.error.type);
        console.log("Timestamp:", finalResult.error.timestamp);
        if (finalResult.error.details) {
          console.log("Details:", finalResult.error.details);
        }
        break;
      case "terminated":
        console.log("Workflow terminated");
        break;
      case "timeout":
        console.log("Timed out waiting for result");
        break;
      case "not_found":
        console.log("Workflow not found");
        break;
    }
  }

  // =========================================================================
  // Signals — ONLY available at engine level (not in workflow code)
  // =========================================================================

  const sigtermResult = await handle.sigterm();
  if (sigtermResult.ok) {
    console.log("SIGTERM sent — compensations will run");

    const compensated = await handle.lifecycle.compensated.wait({
      signal: AbortSignal.timeout(60_000),
    });
    if (compensated.ok) {
      console.log("All compensations completed");
    }
  } else if (sigtermResult.status === "already_finished") {
    console.log("Workflow already finished");
  }

  const sigkillResult = await handle.sigkill();
  if (sigkillResult.ok) {
    console.log("SIGKILL sent — workflow terminated immediately");
  }

  await engine.shutdown();
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  // Steps
  bookFlight,
  cancelFlight,
  bookHotel,
  cancelHotel,
  reserveCar,
  cancelCar,
  sendEmail,
  processPayment,
  refundPayment,
  // Workflows
  travelBookingWorkflow,
  raceWorkflow,
  backgroundWorkflow,
  batchWorkflow,
  concurrentWorkflow,
  paymentWorkflow,
  parentWorkflow,
  coordinatorWorkflow,
  minimalWorkflow,
  compensationDemoWorkflow,
  compensationScopeWorkflow,
  patchDemoWorkflow,
  suspendDemoWorkflow,
  // Main
  main,
};
