/**
 * Public examples index.
 * Each example lives in a dedicated file with focused showcase docs.
 */
export { heartbeatWorkflow } from "./heartbeat.example";
export { orderWorkflow } from "./order.example";
export { flightBookingWorkflow } from "./flight-booking.example";
export { quoteAggregationWorkflow } from "./quote-aggregation.example";
export { paymentOrchestrationWorkflow } from "./payment-orchestration.example";
export { channelRaceWorkflow } from "./channel-race.example";
export { campaignWorkflow } from "./campaign.example";
export { compensationHooksWorkflow } from "./compensation-hooks.example";
export { scopeSleepRaceWorkflow } from "./scope-sleep-race.example";

// Shared helper workflows/steps (optional imports for composing custom examples).
export { paymentWorkflow, campaignWorker } from "./shared";
