import { z } from "zod";
import { defineStep, defineWorkflow } from "../workflow";

// Shared schemas
export const FlightResult = z.object({ id: z.string(), price: z.number() });
export const HotelResult = z.object({ id: z.string(), price: z.number() });
export const QuoteResult = z.object({
  price: z.number(),
  provider: z.string(),
});
export const CancelResult = z.object({ ok: z.boolean() });
export const EmailResult = z.object({ sent: z.boolean() });
export const PaymentResult = z.object({ receiptId: z.string() });
export const ChargeResult = z.object({
  chargeId: z.string(),
  amount: z.number(),
});
export const RefundResult = z.object({ refundId: z.string() });
export const NotifyResult = z.object({ notificationId: z.string() });

// Shared steps
export const bookFlight = defineStep({
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

export const cancelFlight = defineStep({
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

export const bookHotel = defineStep({
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

export const cancelHotel = defineStep({
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

export const getQuote = defineStep({
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

export const cancelQuote = defineStep({
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

export const sendEmail = defineStep({
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

export const chargeCustomer = defineStep({
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

export const refundCustomer = defineStep({
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

export const sendNotification = defineStep({
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

// Shared child/foreign workflow definitions
const PaymentArgs = z.object({
  customerId: z.string(),
  amount: z.number(),
});
const PaymentMetadata = z.object({
  tenantId: z.string(),
  correlationId: z.string().optional(),
});

const PaymentWorkflowResult = z.object({ receiptId: z.string() });
const AbortCommand = z.object({ type: z.literal("abort") });

export const paymentWorkflow = defineWorkflow({
  name: "payment",
  args: PaymentArgs,
  metadata: PaymentMetadata,
  result: PaymentWorkflowResult,
  channels: { abort: AbortCommand },
  steps: { chargeCustomer, refundCustomer },

  async execute(ctx, args) {
    ctx.logger.info("Processing payment", { amount: args.amount });
    const charge = await ctx.execute(
      ctx.steps
        .chargeCustomer(args.customerId, args.amount)
        .compensate(async (ctx, _result) => {
          await ctx.execute(ctx.steps.refundCustomer(charge.chargeId));
        }),
    );
    return { receiptId: charge.chargeId };
  },
});

const CampaignArgs = z.object({ userId: z.string() });
const CampaignWorkerMetadata = z.object({
  tenantId: z.string(),
  correlationId: z.string().optional(),
});
const NudgeCommand = z.object({ type: z.literal("nudge") });

export const campaignWorker = defineWorkflow({
  name: "campaignWorker",
  args: CampaignArgs,
  metadata: CampaignWorkerMetadata,
  channels: { nudge: NudgeCommand },

  async execute(ctx, args) {
    ctx.logger.info("Campaign started", { userId: args.userId });
    const cmd = await ctx.channels.nudge.receive();
    ctx.logger.info("Campaign nudged", { type: cmd.type });
  },
});
