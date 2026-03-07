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
  existingCampaignIdempotencyKey: z.string().optional(),
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
 * - dynamic provider fan-out using closure entries (runtime-known cardinality)
 * - ctx.all() for collecting flight search results
 * - concurrent hotel reservations while searching flights
 * - ctx.select({ branch, channel.receive() }).ctx.match() loop for "first successful hotel hold"
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
      throw new Error(
        "At least one flight provider and one hotel provider is required",
      );
    }

    const decision = await ctx.execute(
      ctx.scope(
        "PlanTrip",
        {
          flights: async (ctx) =>
            ctx.execute(
              ctx.all(
                Object.fromEntries(
                  args.flightProviders.map((provider) => [
                    provider,
                    async (innerCtx: typeof ctx) =>
                      innerCtx.execute(
                        innerCtx.steps
                          .searchFlightOptions(
                            provider,
                            args.origin,
                            args.destination,
                          )
                          .compensate(async (ctx, result) => {
                            if (result.status !== "complete") return;
                            for (const itinerary of result.data.itineraries) {
                              await ctx.execute(
                                ctx.steps.cancelFlightItinerary(
                                  provider,
                                  itinerary.itineraryId,
                                ),
                              );
                            }
                          }),
                      ),
                  ]),
                ),
              ),
            ),
          hotels: async (ctx) =>
            ctx.execute(
              ctx.all(
                Object.fromEntries(
                  args.hotelProviders.map((provider) => [
                    provider,
                    async (innerCtx: typeof ctx) =>
                      innerCtx.execute(
                        innerCtx.steps
                          .reserveHotel(
                            provider,
                            args.destination,
                            args.checkIn,
                            args.checkOut,
                          )
                          .compensate(async (ctx, result) => {
                            if (result.status !== "complete") return;
                            await ctx.execute(
                              ctx.steps.cancelHotelReservation(
                                provider,
                                result.data.reservationId,
                              ),
                            );
                          }),
                      ),
                  ]),
                ),
              ),
            ),
        },
        async (ctx, { flights, hotels }) => {
          const flightResults = await ctx.join(flights);
          const hotelResults = await ctx.join(hotels);

          let bestFlight: {
            provider: string;
            itineraryId: string;
            hops: number;
            price: number;
            legs: Array<{ from: string; to: string }>;
          } | null = null;
          let candidateCount = 0;

          for (const [provider, data] of Object.entries(flightResults)) {
            const viable = data.itineraries.filter((it) => it.hops <= 3);
            if (viable.length === 0) continue;
            const cheapest = viable.reduce((best, curr) =>
              curr.price < best.price ? curr : best,
            );
            candidateCount++;
            if (bestFlight == null || cheapest.price < bestFlight.price) {
              bestFlight = {
                provider,
                itineraryId: cheapest.itineraryId,
                hops: cheapest.hops,
                price: cheapest.price,
                legs: cheapest.legs,
              };
            }
          }

          // Non-blocking poll (receiveNowait): check whether a cancel message
          // arrived while we were searching flights. Returns immediately — undefined
          // if no message is available. Cannot be passed to ctx.select() since it
          // completes atomically and is not a selectable branch.
          const earlyCancelMsg = await ctx.channels.cancel.receiveNowait();
          if (earlyCancelMsg !== undefined) {
            return {
              outcome: "cancelled" as const,
              itineraryId: null,
              hops: null,
              flightProvider: null,
              hotelReservationId: null,
              hotelProvider: null,
              totalPrice: null,
              paymentReceiptId: null,
              candidateCount,
            };
          }

          // One-shot race: select first available hotel or cancel.
          // Since hotels were already resolved via all(), we iterate the results
          // and race against a cancel signal using ctx.listen().
          let selectedHotel: {
            provider: string;
            reservationId: string;
            price: number;
          } | null = null;
          let cancelled = false;

          // Check for a cancel message that arrived while we were resolving hotels.
          const earlyCancelHotel = await ctx.channels.cancel.receiveNowait();
          if (earlyCancelHotel !== undefined) {
            cancelled = true;
          }

          if (!cancelled) {
            // Pick the first successfully resolved hotel.
            for (const [provider, data] of Object.entries(hotelResults)) {
              if (selectedHotel == null) {
                selectedHotel = {
                  provider,
                  reservationId: data.reservationId,
                  price: data.price,
                };
                break;
              }
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
              candidateCount,
            };
          }

          const totalPrice = bestFlight.price + selectedHotel.price;
          const paymentReceiptId = await ctx.execute(
            ctx.childWorkflows
              .payment({
                idempotencyKey: `payment-${ctx.rng.ids.uuidv4()}`,
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
              .complete((data) => data.receiptId),
          );

          const campaign =
            await ctx.childWorkflows.campaignWorker.startDetached({
              idempotencyKey: `campaign-${ctx.rng.ids.uuidv4()}`,
              metadata: {
                tenantId: `tenant-${args.customerId}`,
                correlationId: `corr-campaign-${args.customerId}`,
              },
              seed: `trip-campaign-${args.customerId}`,
              args: { userId: args.customerId },
            });
          await campaign.channels.nudge.send({ type: "nudge" });

          if (args.existingCampaignIdempotencyKey) {
            const existing = ctx.foreignWorkflows.campaignWorker.get(
              args.existingCampaignIdempotencyKey,
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
            candidateCount,
          };
        },
      ),
    );

    return decision;
  },
});
