import { z } from "zod";
import { defineStep, defineWorkflow } from "../workflow";
import { paymentWorkflow, campaignWorker } from "./shared";

const ConcurrencyPrimitivesArgs = z.object({
  origin: z.string(),
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  customerId: z.string(),
  flightProviders: z.array(z.string()),
  hotelProviders: z.array(z.string()),
  existingCampaignId: z.string().optional(),
});

const CancelCommand = z.object({
  type: z.literal("cancel"),
  reason: z.string(),
});

const Leg = z.object({
  from: z.string(),
  to: z.string(),
});

const FlightItinerary = z.object({
  itineraryId: z.string(),
  hops: z.number().int().min(0).max(3),
  price: z.number(),
  legs: z.array(Leg),
});

const SearchFlightOptionsResult = z.object({
  provider: z.string(),
  itineraries: z.array(FlightItinerary),
});

const ReserveHotelResult = z.object({
  reservationId: z.string(),
  provider: z.string(),
  price: z.number(),
});

const CancelResult = z.object({ ok: z.boolean() });

const searchFlightOptions = defineStep({
  name: "searchFlightOptions",
  execute: async (
    { signal },
    provider: string,
    origin: string,
    destination: string,
  ) => {
    const res = await fetch(`https://api.${provider}.com/flights/search`, {
      method: "POST",
      body: JSON.stringify({
        origin,
        destination,
        maxHops: 3,
      }),
      signal,
    });
    return res.json() as Promise<z.input<typeof SearchFlightOptionsResult>>;
  },
  schema: SearchFlightOptionsResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

const cancelFlightItinerary = defineStep({
  name: "cancelFlightItinerary",
  execute: async ({ signal }, provider: string, itineraryId: string) => {
    await fetch(`https://api.${provider}.com/flights/cancel`, {
      method: "POST",
      body: JSON.stringify({ itineraryId }),
      signal,
    });
    return { ok: true };
  },
  schema: CancelResult,
  retryPolicy: { maxAttempts: 20, intervalSeconds: 5 },
});

const reserveHotel = defineStep({
  name: "reserveHotel",
  execute: async (
    { signal },
    provider: string,
    destination: string,
    checkIn: string,
    checkOut: string,
  ) => {
    const res = await fetch(`https://api.${provider}.com/hotels/reserve`, {
      method: "POST",
      body: JSON.stringify({ destination, checkIn, checkOut }),
      signal,
    });
    return res.json() as Promise<z.input<typeof ReserveHotelResult>>;
  },
  schema: ReserveHotelResult,
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
});

const cancelHotelReservation = defineStep({
  name: "cancelHotelReservation",
  execute: async ({ signal }, provider: string, reservationId: string) => {
    await fetch(`https://api.${provider}.com/hotels/cancel`, {
      method: "POST",
      body: JSON.stringify({ reservationId }),
      signal,
    });
    return { ok: true };
  },
  schema: CancelResult,
  retryPolicy: { maxAttempts: 10, intervalSeconds: 5 },
});

/**
 * Showcases:
 * - dynamic provider fan-out with Map handles (runtime-known cardinality)
 * - `ctx.map()` for cheapest itinerary extraction (up to 3 hops)
 * - concurrent hotel reservations while searching flights
 * - `ctx.map()` with a `ChannelReceiveCall` (non-blocking cancel poll)
 * - `ctx.select({ branch, channel.receive() }).match()` loop for "first successful hotel hold"
 * - child workflows in both result mode and detached mode
 * - foreign workflow channel access to existing workflow instance
 */
export const concurrencyPrimitivesWorkflow = defineWorkflow({
  name: "concurrencyPrimitives",
  args: ConcurrencyPrimitivesArgs,
  channels: { cancel: CancelCommand },
  steps: {
    searchFlightOptions,
    cancelFlightItinerary,
    reserveHotel,
    cancelHotelReservation,
  },
  childWorkflows: { payment: paymentWorkflow, campaignWorker },
  foreignWorkflows: { campaignWorker },
  rng: { ids: true },
  result: z.object({
    outcome: z.enum(["booked", "cancelled"]),
    itineraryId: z.string().nullable(),
    hops: z.number().nullable(),
    flightProvider: z.string().nullable(),
    hotelReservationId: z.string().nullable(),
    hotelProvider: z.string().nullable(),
    totalPrice: z.number().nullable(),
    paymentReceiptId: z.string().nullable(),
    candidateCount: z.number(),
  }),

  async execute(ctx, args) {
    if (args.flightProviders.length === 0 || args.hotelProviders.length === 0) {
      throw new Error("At least one flight provider and one hotel provider is required");
    }

    const flightSearches = new Map(
      args.flightProviders.map((provider) => [
        provider,
        ctx.steps
          .searchFlightOptions(provider, args.origin, args.destination)
          .compensate(async (compCtx, result) => {
            if (result.status !== "complete") return;
            for (const itinerary of result.data.itineraries) {
              await compCtx.steps.cancelFlightItinerary(
                provider,
                itinerary.itineraryId,
              );
            }
          }),
      ]),
    );

    const hotelReservations = new Map(
      args.hotelProviders.map((provider) => [
        provider,
        ctx.steps
          .reserveHotel(provider, args.destination, args.checkIn, args.checkOut)
          .compensate(async (compCtx, result) => {
            if (result.status !== "complete") return;
            await compCtx.steps.cancelHotelReservation(
              provider,
              result.data.reservationId,
            );
          }),
      ]),
    );

    const decision = await ctx.scope(
      { flights: flightSearches, hotels: hotelReservations },
      async (ctx, { flights, hotels }) => {
        const pricedFlights = await ctx.map(
          { flights },
          {
            flights: {
              complete: (data, provider) => {
                const viable = data.itineraries.filter((it) => it.hops <= 3);
                if (viable.length === 0) return null;
                const cheapest = viable.reduce((best, curr) =>
                  curr.price < best.price ? curr : best,
                );
                return {
                  provider,
                  itineraryId: cheapest.itineraryId,
                  hops: cheapest.hops,
                  price: cheapest.price,
                  legs: cheapest.legs,
                };
              },
              failure: async (failure, provider) => {
                ctx.logger.warn("Flight search provider failed", { provider });
                return null;
              },
            },
          },
        );

        let bestFlight:
          | {
              provider: string;
              itineraryId: string;
              hops: number;
              price: number;
              legs: Array<{ from: string; to: string }>;
            }
          | null = null;

        for (const value of pricedFlights.flights.values()) {
          if (value == null) continue;
          if (bestFlight == null || value.price < bestFlight.price) {
            bestFlight = value;
          }
        }

        // Non-blocking poll (receive(0) = nowait): check whether a cancel message
        // arrived while we were searching flights. This demonstrates ctx.map() with
        // a ChannelReceiveCall — the key resolves immediately (undefined if no message).
        const earlyCancel = await ctx.map(
          { cancel: ctx.channels.cancel.receive(0) },
          { cancel: (msg) => msg },
        );
        if (earlyCancel.cancel !== undefined) {
          return {
            outcome: "cancelled" as const,
            itineraryId: null,
            hops: null,
            flightProvider: null,
            hotelReservationId: null,
            hotelProvider: null,
            totalPrice: null,
            paymentReceiptId: null,
            candidateCount: Array.from(pricedFlights.flights.values()).filter(
              (v) => v != null,
            ).length,
          };
        }

        // One-shot race: hotel branches exhaust naturally; cancel.receive() resolves
        // once and is removed from remaining, so the while loop always terminates.
        const hotelSel = ctx.select({
          hotel: hotels,
          cancel: ctx.channels.cancel.receive(),
        });
        let selectedHotel:
          | { provider: string; reservationId: string; price: number }
          | null = null;
        let cancelled = false;

        for await (const val of hotelSel.match({
          cancel: () => {
            cancelled = true;
            return null;
          },
          hotel: {
            complete: ({ data, innerKey }) => ({
              provider: innerKey,
              reservationId: data.reservationId,
              price: data.price,
            }),
            failure: async () => {
              ctx.logger.warn("Hotel reservation provider failed");
              return null;
            },
          },
        })) {
          if (cancelled) break;
          if (val != null) {
            selectedHotel = val;
            break;
          }
        }

        if (cancelled || bestFlight == null || selectedHotel == null) {
          return {
            outcome: "cancelled" as const,
            itineraryId: null,
            hops: null,
            flightProvider: null,
            hotelReservationId: null,
            hotelProvider: null,
            totalPrice: null,
            paymentReceiptId: null,
            candidateCount: Array.from(pricedFlights.flights.values()).filter(
              (v) => v != null,
            ).length,
          };
        }

        const totalPrice = bestFlight.price + selectedHotel.price;
        const paymentReceiptId = await ctx.childWorkflows
          .payment({
            id: `payment-${ctx.rng.ids.uuidv4()}`,
            metadata: {
              tenantId: `tenant-${args.customerId}`,
              correlationId: `corr-payment-${args.customerId}`,
            },
            seed: `trip-payment-${args.customerId}`,
            args: { customerId: args.customerId, amount: totalPrice },
          })
          .failure(async (failure) => {
            if (failure.status === "failed") {
              ctx.logger.error("Payment workflow failed", {
                error: failure.error.message,
              });
            } else {
              ctx.logger.error("Payment workflow terminated", {
                reason: failure.reason,
              });
            }
            return null;
          })
          .complete((data) => data.receiptId);

        const campaign = await ctx.childWorkflows.campaignWorker({
          id: `campaign-${ctx.rng.ids.uuidv4()}`,
          metadata: {
            tenantId: `tenant-${args.customerId}`,
            correlationId: `corr-campaign-${args.customerId}`,
          },
          seed: `trip-campaign-${args.customerId}`,
          args: { userId: args.customerId },
          detached: true,
        });
        await campaign.channels.nudge.send({ type: "nudge" });

        if (args.existingCampaignId) {
          const existing = ctx.foreignWorkflows.campaignWorker.get(
            args.existingCampaignId,
          );
          await existing.channels.nudge.send({ type: "nudge" });
        }

        return {
          outcome: "booked" as const,
          itineraryId: bestFlight.itineraryId,
          hops: bestFlight.hops,
          flightProvider: bestFlight.provider,
          hotelReservationId: selectedHotel.reservationId,
          hotelProvider: selectedHotel.provider,
          totalPrice,
          paymentReceiptId,
          candidateCount: Array.from(pricedFlights.flights.values()).filter(
            (v) => v != null,
          ).length,
        };
      },
    );

    return decision;
  },
});
