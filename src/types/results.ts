// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Serializable error object for a single step attempt.
 * Captures what went wrong on each retry attempt.
 */
export interface StepExecutionError {
  /** Error message */
  readonly message: string;
  /** Error class name (e.g. "TypeError", "Error") */
  readonly type: string;
  /** 1-indexed attempt number */
  readonly attempt: number;
  /** Epoch milliseconds when the error occurred */
  readonly timestamp: number;
  /** Optional structured details */
  readonly details?: Record<string, unknown>;
}

/**
 * Lazy, async-iterable accessor over a step's error history.
 * Provides access to errors from all retry attempts.
 */
export interface StepErrorAccessor {
  /** Get the most recent error */
  last(): Promise<StepExecutionError>;
  /** Get all errors (ordered by attempt) */
  all(): Promise<StepExecutionError[]>;
  /** Async iterate over errors (oldest first) */
  [Symbol.asyncIterator](): AsyncIterableIterator<StepExecutionError>;
  /** Async iterate over errors (newest first) */
  reverse(): AsyncIterable<StepExecutionError>;
  /** Number of recorded errors */
  readonly count: number;
}

/**
 * Serializable error object for a failed workflow.
 * Workflows don't retry, so there's no `attempt` field.
 */
export interface WorkflowExecutionError {
  /** Error message */
  readonly message: string;
  /** Error class name (e.g. "TypeError", "Error") */
  readonly type: string;
  /** Epoch milliseconds when the error occurred */
  readonly timestamp: number;
  /** Optional structured details */
  readonly details?: Record<string, unknown>;
}

/**
 * Reason for workflow termination (non-failure terminal path).
 */
export type WorkflowTerminationReason =
  | "deadline_exceeded"
  | "terminated_by_signal"
  | "terminated_by_parent";

// =============================================================================
// RESULT TYPES — STEP (COMPENSATION)
// =============================================================================

/**
 * Result passed to compensation callbacks.
 * Represents what happened to the forward step — the compensation callback
 * must inspect `status` to decide what to undo.
 *
 * "terminated" IS included because SIGTERM can arrive during compensation
 * (e.g. the workflow failed and is compensating, then SIGTERM arrives).
 */
export type StepCompensationResult<T> =
  | { status: "complete"; data: T; errors: StepErrorAccessor }
  | {
      status: "failed";
      reason: "attempts_exhausted" | "timeout";
      errors: StepErrorAccessor;
    }
  | { status: "terminated"; errors: StepErrorAccessor };

/**
 * Result of executing a step inside CompensationContext.
 * Compensation code MUST handle step failures gracefully — it cannot crash
 * the compensation chain. The `ok` field enables Go-style error checking.
 *
 * "terminated" is NOT included — the only way to terminate during compensation
 * is SIGKILL, which tears down the entire process immediately. Compensation
 * code never observes a "terminated" status.
 */
export type CompensationStepResult<T> =
  | { ok: true; status: "complete"; data: T; errors: StepErrorAccessor }
  | {
      ok: false;
      status: "failed";
      reason: "attempts_exhausted" | "timeout";
      errors: StepErrorAccessor;
    };

/**
 * Result passed to child workflow compensation callbacks.
 * Similar to StepCompensationResult but for child workflows — no `reason`
 * or `errors` (workflows don't retry, and error info is on the `error` field).
 */
export type ChildWorkflowCompensationResult<T> =
  | { status: "complete"; data: T }
  | { status: "failed"; error: WorkflowExecutionError }
  | { status: "terminated"; reason: WorkflowTerminationReason };

// =============================================================================
// RESULT TYPES — ENGINE LEVEL (with error info)
// =============================================================================

/**
 * Result of a child workflow run/join at engine level.
 * Retains full discriminated union with `ok` field — engine callers need
 * explicit outcome handling.
 */
export type WorkflowResult<T> =
  | { ok: true; status: "complete"; data: T }
  | { ok: false; status: "failed"; error: WorkflowExecutionError }
  | {
      ok: false;
      status: "terminated";
      reason: WorkflowTerminationReason;
    };

/**
 * Result of waiting for execution phase terminal outcome (engine level).
 */
export type ExecutionResultExternal<TResult> =
  | { ok: true; status: "complete"; data: TResult }
  | { ok: false; status: "failed"; error: WorkflowExecutionError }
  | {
      ok: false;
      status: "terminated";
      reason: WorkflowTerminationReason;
    }
  | { ok: false; status: "not_found" };

/**
 * Result of waiting for compensation phase terminal outcome (engine level).
 */
export type CompensationResultExternal =
  | { ok: true; status: "complete" }
  | { ok: false; status: "failed"; error: WorkflowExecutionError }
  | {
      ok: false;
      status: "terminated";
      reason: WorkflowTerminationReason;
    }
  | { ok: false; status: "not_found" };

// =============================================================================
// RESULT TYPES — CHANNELS, STREAMS, EVENTS
// =============================================================================

/**
 * @deprecated Use T directly — channel receive returns the decoded value directly.
 */
export type ChannelReceiveResultNoTimeout<T> = T;

/**
 * Result of sending a message to a channel (engine level).
 */
export type ChannelSendResult =
  | { ok: true; status: "sent" }
  | { ok: false; status: "not_found" };

/**
 * Result of reading from a stream (engine level / random access).
 */
export type StreamReadResult<T> =
  | { ok: true; status: "received"; data: T; offset: number }
  | { ok: false; status: "closed" }
  | { ok: false; status: "not_found" };

/**
 * Result of reading the next record from a stream iterator.
 */
export type StreamIteratorReadResult<T> =
  | { ok: true; status: "record"; data: T; offset: number }
  | { ok: false; status: "closed" };

/**
 * Result of checking if a stream is open (engine level).
 */
export type StreamOpenResult =
  | { ok: true; status: "open" }
  | { ok: false; status: "closed" }
  | { ok: false; status: "not_found" };

/**
 * Result of waiting for an event.
 * "never" means the event will never be set — the workflow reached a terminal
 * state without setting it.
 */
export type EventWaitResult =
  | { ok: true; status: "set" }
  | { ok: false; status: "never" }
  | { ok: false; status: "timeout" };

/**
 * Result of waiting for an event without timeout.
 * When no timeout is specified, timeout cannot occur.
 */
export type EventWaitResultNoTimeout =
  | { ok: true; status: "set" }
  | { ok: false; status: "never" };

/**
 * Result of checking if an event is set (non-blocking).
 */
export type EventCheckResult =
  | { ok: true; status: "set" }
  | { ok: false; status: "not_set" }
  | { ok: false; status: "never" }
  | { ok: false; status: "not_found" };

/**
 * Result of sending a signal (sigterm/sigkill) to a workflow (engine level).
 */
export type SignalResult =
  | { ok: true; status: "sent" }
  | { ok: false; status: "already_finished" }
  | { ok: false; status: "not_found" };

// =============================================================================
// EXTERNAL WAIT OPTIONS
// =============================================================================

/**
 * Options for engine-level (runtime) wait operations.
 *
 * Engine-level waits are runtime concerns — not recorded in the execution log.
 * Use `AbortSignal.timeout(ms)` for time-based waits, or wire up an
 * `AbortController` for cancellation driven by HTTP request lifecycle,
 * process shutdown, user action, etc.
 *
 * @example
 * ```typescript
 * // Time-based wait (5 seconds)
 * await handle.execution.wait({ signal: AbortSignal.timeout(5_000) });
 *
 * // Cancellable wait
 * const controller = new AbortController();
 * await handle.execution.wait({ signal: controller.signal });
 * // elsewhere: controller.abort();
 * ```
 *
 * If the signal aborts, wait operations reject with AbortError.
 */
export interface ExternalWaitOptions {
  signal?: AbortSignal;
}
