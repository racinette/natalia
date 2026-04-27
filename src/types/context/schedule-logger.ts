import type { BlockingResult } from "./deterministic-handles";

// =============================================================================
// SCHEDULE
// =============================================================================

/**
 * Options for cron-like schedule creation.
 */
export interface ScheduleOptions {
  /** IANA timezone identifier (default: UTC). */
  timezone?: string;
  /**
   * Explicit schedule anchor time.
   *
   * The first emitted tick is the first schedule point STRICTLY after this
   * instant (never equal), preventing duplicate boundary ticks during handoff.
   */
  resumeAt?: Date | number;
}

/**
 * One deterministic schedule tick produced by `ScheduleHandle`.
 */
export interface ScheduleTick {
  /** Intended execution time for this tick (pure cron math). */
  readonly scheduledAt: Date;
  /** Intended execution time for the next tick. */
  readonly nextScheduledAt: Date;
  /** Convenience value: seconds between `scheduledAt` and `nextScheduledAt`. */
  readonly secondsUntilNext: number;
  /** 0-based monotonically increasing tick counter. */
  readonly index: number;
}

/**
 * Handle returned by `ctx.schedule()` for cron-like recurring execution.
 */
export interface ScheduleHandle extends AsyncIterable<ScheduleTick> {
  /**
   * Suspend until the next scheduled tick.
   * Returns immediately if the next scheduled time is already in the past.
   */
  sleep(): BlockingResult<ScheduleTick>;
  /**
   * Cancel a pending sleep and stop future iteration.
   */
  cancel(): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<ScheduleTick>;
}

// =============================================================================
// LOGGER
// =============================================================================

/**
 * Workflow logger — replay-aware.
 *
 * This logger is replay-aware and only emits logs when the workflow is executing
 * NEW code (past the replay boundary). During replay, all log calls are suppressed
 * to avoid polluting logs with duplicate messages.
 *
 * Steps should NOT use this logger. Use your own application logger (console.log,
 * Winston, Pino, etc.) inside step implementations.
 */
export interface WorkflowLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
