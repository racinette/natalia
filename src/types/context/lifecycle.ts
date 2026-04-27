import type { EventCheckResult, EventWaitResult, EventWaitResultNoTimeout } from "../results";
import type { AtomicResult, BlockingResult } from "./deterministic-handles";

// =============================================================================
// LIFECYCLE EVENTS
// =============================================================================

/**
 * Engine-managed phase lifecycle event names.
 * Automatically managed by the engine — cannot be set by user code.
 *
 * Shared across execution and compensation phases:
 *
 * - started:    set when the phase begins
 * - complete:   set when the phase completes successfully
 * - failed:     set when the phase fails
 * - terminated: set when the phase is terminated
 *
 * After a phase reaches a terminal state, all unset events are marked "never" —
 * they will never fire.
 */
export type PhaseLifecycleEventName =
  | "started"
  | "complete"
  | "failed"
  | "terminated";

/**
 * Lifecycle event accessor — supports wait/get with "never" semantics.
 */
export interface LifecycleEventAccessor {
  /**
   * Wait for the lifecycle event to be set.
   * Returns "never" if the workflow reached a terminal state without this event firing.
   */
  wait(): BlockingResult<EventWaitResultNoTimeout>;

  /**
   * Wait for the lifecycle event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): BlockingResult<EventWaitResult>;

  /**
   * Check if the lifecycle event is set (non-blocking).
   */
  get(): AtomicResult<EventCheckResult>;
}

/**
 * User-defined event accessor for reading (on child/external handles).
 * Supports "never" semantics.
 */
export interface EventAccessorReadonly {
  /**
   * Wait for the event to be set.
   * Returns "never" if the workflow reached a terminal state without setting this event.
   */
  wait(): BlockingResult<EventWaitResultNoTimeout>;

  /**
   * Wait for the event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): BlockingResult<EventWaitResult>;

  /**
   * Check if the event is set (non-blocking).
   */
  get(): AtomicResult<EventCheckResult>;
}

/**
 * Lifecycle events available for a single workflow phase.
 */
export interface PhaseLifecycleEvents {
  readonly started: LifecycleEventAccessor;
  readonly complete: LifecycleEventAccessor;
  readonly failed: LifecycleEventAccessor;
  readonly terminated: LifecycleEventAccessor;
}
