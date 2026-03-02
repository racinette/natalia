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
export { channelTimeoutWorkflow } from "./channel-timeout.example";
export { campaignWorkflow } from "./campaign.example";
export { compensationHooksWorkflow } from "./compensation-hooks.example";
export { scopeSleepRaceWorkflow } from "./scope-sleep-race.example";
export {
  dailyReportJobWorkflow,
  dailyReportSchedulerWorkerWorkflow,
  dailyReportSchedulerManagerWorkflow,
} from "./cron-scheduler.example";
export {
  pageScraperHeader,
  pageScraperWorkflow,
} from "./web-scraper.example";
export {
  clientApiShowcase,
  engineLevelApiShowcase,
} from "./engine-level-api.example";
export { concurrencyPrimitivesWorkflow } from "./concurrency-primitives.example";
export { searchQueryTypeMatrixRegression } from "./search-query-type-matrix-regression.example";
export { onboardingVerificationWorkflow } from "./onboarding-verification.example";
export { scopePossessionViolationsWorkflow } from "./scope-possession-violations.example";

// Shared helper workflows/steps (optional imports for composing custom examples).
export { paymentWorkflow, campaignWorker } from "./shared";
