import type { JsonInput } from "./json-input";
import type { StandardSchemaV1 } from "./standard-schema";

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Throwable business error created by `ctx.errors.X(...)`.
 *
 * The engine recognizes these only against the local definition's declared
 * error map and serializes them as `ErrorValue<TErrorDefinitions>`.
 */
export class ExplicitError<
  TCode extends string = string,
  TDetails = unknown,
> extends Error {
  readonly code: TCode;
  readonly details: TDetails;

  constructor(code: TCode, message: string, details: TDetails) {
    super(message);
    this.name = "ExplicitError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Serializable representation of a declared business error.
 *
 * Carries the `type: "ExplicitError"` discriminator so external callers can
 * distinguish declared business failures from arbitrary thrown values
 * captured as `Failure` records.
 */
export type ErrorValue<TErrors> = {
  [K in keyof TErrors & string]: {
    readonly type: "ExplicitError";
    readonly code: K;
    readonly message: string;
    readonly details: TErrors[K] extends true
      ? undefined
      : TErrors[K] extends StandardSchemaV1<unknown, unknown>
        ? StandardSchemaV1.InferOutput<TErrors[K]>
        : never;
  };
}[keyof TErrors & string];

/**
 * Workflow failure surface visible to external callers.
 */
export type FailureInfo<TWorkflowErrors> = ErrorValue<TWorkflowErrors>;

/**
 * Base captured-throw record for non-explicit failures.
 */
export interface Failure {
  readonly startedAt: Date;
  readonly failedAt: Date;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
}

/**
 * Retried operations extend `Failure` with an attempt number.
 */
export interface Attempt extends Failure {
  readonly attempt: number;
}

/**
 * Throwable error for structured, JSON-serializable attempt failure details.
 */
export class AttemptError extends Error {
  readonly type: string | null;
  readonly details: JsonInput | undefined;

  constructor(options: {
    readonly type?: string | null;
    readonly message?: string | null;
    readonly details?: JsonInput;
  } = {}) {
    super(options.message ?? options.type ?? "AttemptError");
    this.name = "AttemptError";
    this.type = options.type ?? null;
    this.details = options.details;
  }
}

/**
 * Lazy, async-iterable accessor over a retried operation's attempt history.
 */
export interface AttemptAccessor {
  /** Get the most recent failed attempt. */
  last(): Promise<Attempt>;
  /** Get all failed attempts, ordered by attempt. */
  all(): Promise<Attempt[]>;
  /** Get the number of recorded failed attempts. */
  count(): Promise<number>;
  /** Async iterate over attempts, oldest first. */
  [Symbol.asyncIterator](): AsyncIterableIterator<Attempt>;
  /** Async iterate over attempts, newest first. */
  reverse(): AsyncIterable<Attempt>;
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
// HALT STATUS — OPERATOR VISIBILITY
// =============================================================================

/**
 * Durable halt state for workflow execution halts.
 *
 * Workflow execution halts pause the workflow at the point of an unrecognised
 * throw. They are resolved automatically by patch + replay, or by `sigkill()`
 * on the workflow handle. There is no operator-callable skip — skipping
 * workflow code would leave parent in-memory state inconsistent.
 */
export type WorkflowHaltStatus = "pending" | "resolved";

/**
 * Durable halt state for compensation block instance halts.
 *
 * Compensation block instances are isolated; if `undo` throws unrecognised,
 * the instance is halted. The operator can either patch + replay or
 * `skip(...)` the compensation block instance, which records the synthesised
 * result and clears the halt.
 */
export type CompensationBlockHaltStatus =
  | "pending"
  | "resolved"
  | "skipped";

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
  | { status: "complete"; data: T; attempts: AttemptAccessor }
  | {
      status: "failed";
      reason: "attempts_exhausted" | "timeout";
      attempts: AttemptAccessor;
    }
  | { status: "terminated"; attempts: AttemptAccessor };

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
  | { ok: true; status: "complete"; data: T; attempts: AttemptAccessor }
  | {
      ok: false;
      status: "failed";
      reason: "attempts_exhausted" | "timeout";
      attempts: AttemptAccessor;
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
export type WorkflowResult<T, TError = WorkflowExecutionError> =
  | { ok: true; status: "complete"; data: T }
  | { ok: false; status: "failed"; error: TError }
  | {
      ok: false;
      status: "terminated";
      reason: WorkflowTerminationReason;
    };

/**
 * Result of waiting for execution phase terminal outcome (engine level).
 */
export type ExecutionResultExternal<TResult, TError = WorkflowExecutionError> =
  | { ok: true; status: "complete"; data: TResult }
  | { ok: false; status: "failed"; error: TError }
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
