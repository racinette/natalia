import type { ErrorDefinitions } from "./definitions/errors";
import type { JsonInput } from "./json-input";
import type { SchemaInvocationInput } from "./context/entries";
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

// =============================================================================
// COMPENSATION BLOCK INSTANCE ID
// =============================================================================

/**
 * Branded opaque public id for a compensation block instance.
 *
 * Compensation block instances are addressable through the parent workflow's
 * `compensations.<step>` query namespace (step 12). The `__step` phantom
 * prevents ids from different compensable steps being assignable to each
 * other at the type level.
 *
 * Internally a `CompensationId<TStep>` is the workflow id of the
 * compensation block instance (`workflow` table row, see `REFACTOR.MD` Part
 * 8). Externally that detail is not exposed.
 */
export type CompensationId<TStep> = string & {
  readonly __brand: "CompensationId";
  readonly __step: TStep;
};

/**
 * Per-try outcome record for a retried operation.
 *
 * Error fields (`message`, `type`, `details`) are nullable — a try may end
 * without structured error info (for example a successful step `execute`
 * return, or a throw with no message).
 */
export interface Failure {
  readonly startedAt: Date;
  readonly failedAt: Date;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
}

/**
 * A single execution attempt on a retried operation (1-indexed `attempt`).
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

// =============================================================================
// QUEUE HANDLER ERRORS
// =============================================================================

/**
 * Loose error fields captured when persisting a schema-backed details payload
 * fails, or when extracting an unhandled throw.
 */
export type BaseError = {
  readonly message: string | null;
  readonly type: string | null;
  readonly details: JsonInput | undefined;
};

/**
 * Retry / dead-letter disposition passed to every queue error factory call.
 */
export type QueueErrorDisposition = {
  readonly deadLetter: boolean;
};

/**
 * Factory map for `ctx.errors` inside queue handlers — mirrors workflow
 * `ErrorFactories`, with a required `{ deadLetter }` options bag on each call.
 */
export type QueueErrorFactories<TErrors extends ErrorDefinitions> = {
  [K in keyof TErrors & string]: TErrors[K] extends true
    ? (
        message: string,
        options: QueueErrorDisposition,
      ) => QueueHandlerDeclaredError<K, undefined>
    : TErrors[K] extends StandardSchemaV1<unknown, unknown>
      ? (
          message: string,
          details: SchemaInvocationInput<TErrors[K]>,
          options: QueueErrorDisposition,
        ) => QueueHandlerDeclaredError<
          K,
          StandardSchemaV1.InferOutput<TErrors[K]>
        >
      : never;
};

/**
 * Throwable error created by `ctx.errors.X(...)` in a queue handler.
 */
export class QueueHandlerDeclaredError<
  TCode extends string = string,
  TDetails = unknown,
> extends Error {
  readonly code: TCode;
  readonly details: TDetails;
  readonly deadLetter: boolean;

  constructor(
    code: TCode,
    message: string,
    details: TDetails,
    deadLetter: boolean,
  ) {
    super(message);
    this.name = "QueueHandlerDeclaredError";
    this.code = code;
    this.details = details;
    this.deadLetter = deadLetter;
  }
}

/**
 * Outcome of persisting a declared error's optional schema-backed `details`
 * payload on a queue handler attempt.
 *
 * `serialization_error` means the handler threw a declared error with
 * `details`, but validation/persistence failed — handler disposition
 * (`deadLetter`, `code`, `message`) is unchanged; only structured observability
 * degrades.
 */
export type QueueHandlerAttemptDetails<TDetails> = [TDetails] extends [never]
  ? { readonly status: "unspecified" }
  :
      | {
          readonly ok: true;
          readonly status: "serialized";
          readonly result: TDetails;
        }
      | {
          readonly ok: false;
          readonly status: "serialization_error";
          readonly error: BaseError;
        }
      | { readonly ok: false; readonly status: "unspecified" };

/**
 * Attempt record for a declared queue handler error (`code` is non-null).
 *
 * `message` is always a string when `code` is set — declared errors require a
 * message at the factory call site.
 */
export type DeclaredQueueHandlerAttempt<
  TErrors extends ErrorDefinitions,
  TCode extends keyof TErrors & string,
> = {
  readonly attempt: number;
  readonly deadLetter: boolean;
  readonly code: TCode;
  readonly message: string;
  readonly details: TErrors[TCode] extends true
    ? undefined
    : QueueHandlerAttemptDetails<
        StandardSchemaV1.InferOutput<
          Extract<TErrors[TCode], StandardSchemaV1<unknown, unknown>>
        >
      >;
};

/**
 * Attempt record for an unhandled queue handler throw (no declared `code`).
 */
export type UnhandledQueueHandlerAttempt = {
  readonly attempt: number;
  readonly deadLetter: boolean;
  readonly code: null;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: { readonly status: "unspecified" };
};

/**
 * Per-try outcome record for a retried queue message handler (1-indexed `attempt`).
 */
export type QueueHandlerAttempt<
  TErrors extends ErrorDefinitions = Record<string, never>,
> =
  | UnhandledQueueHandlerAttempt
  | ([keyof TErrors & string] extends [never]
      ? never
      : {
          [K in keyof TErrors & string]: DeclaredQueueHandlerAttempt<
            TErrors,
            K
          >;
        }[keyof TErrors & string]);

/**
 * Lazy, async-iterable accessor over queue handler attempt records for a
 * dead-lettered message, an in-flight retried message, or
 * {@link QueueRetentionContext} at finalize time.
 */
export interface QueueHandlerAttemptAccessor<
  TErrors extends ErrorDefinitions = Record<string, never>,
> {
  last(): Promise<QueueHandlerAttempt<TErrors>>;
  all(): Promise<QueueHandlerAttempt<TErrors>[]>;
  count(): Promise<number>;
  [Symbol.asyncIterator](): AsyncIterableIterator<QueueHandlerAttempt<TErrors>>;
  reverse(): AsyncIterable<QueueHandlerAttempt<TErrors>>;
}

// =============================================================================
// REQUEST HANDLER ERRORS
// =============================================================================

/**
 * Manual / retry disposition passed to every request error factory call.
 */
export type RequestErrorDisposition = {
  readonly manual: boolean;
};

/**
 * Factory map for `ctx.errors` inside forward request handlers — each call
 * requires `{ manual }` to choose retry vs manual escalation.
 */
export type RequestErrorFactories<TErrors extends ErrorDefinitions> = {
  [K in keyof TErrors & string]: TErrors[K] extends true
    ? (
        message: string,
        options: RequestErrorDisposition,
      ) => RequestHandlerDeclaredError<K, undefined>
    : TErrors[K] extends StandardSchemaV1<unknown, unknown>
      ? (
          message: string,
          details: SchemaInvocationInput<TErrors[K]>,
          options: RequestErrorDisposition,
        ) => RequestHandlerDeclaredError<
          K,
          StandardSchemaV1.InferOutput<TErrors[K]>
        >
      : never;
};

/**
 * Factory map for `ctx.errors` where every throw escalates to manual mode —
 * used in compensation handlers. Mirrors workflow `ErrorFactories` (no
 * disposition flag).
 */
export type RequestManualEscalationErrorFactories<
  TErrors extends ErrorDefinitions,
> = {
  [K in keyof TErrors & string]: TErrors[K] extends true
    ? (message: string) => RequestHandlerDeclaredError<K, undefined>
    : TErrors[K] extends StandardSchemaV1<unknown, unknown>
      ? (
          message: string,
          details: SchemaInvocationInput<TErrors[K]>,
        ) => RequestHandlerDeclaredError<
          K,
          StandardSchemaV1.InferOutput<TErrors[K]>
        >
      : never;
};

/**
 * Throwable error created by `ctx.errors.X(...)` in a request handler or
 * request compensation handler.
 */
export class RequestHandlerDeclaredError<
  TCode extends string = string,
  TDetails = unknown,
> extends Error {
  readonly code: TCode;
  readonly details: TDetails;
  readonly manual: boolean;

  constructor(
    code: TCode,
    message: string,
    details: TDetails,
    manual: boolean,
  ) {
    super(message);
    this.name = "RequestHandlerDeclaredError";
    this.code = code;
    this.details = details;
    this.manual = manual;
  }
}

/**
 * Outcome of persisting a declared error's optional schema-backed `details`
 * payload on a request handler attempt.
 */
export type RequestHandlerAttemptDetails<TDetails> = QueueHandlerAttemptDetails<TDetails>;

/**
 * Attempt record for a declared request handler error (`code` is non-null).
 */
export type DeclaredRequestHandlerAttempt<
  TErrors extends ErrorDefinitions,
  TCode extends keyof TErrors & string,
> = {
  readonly attempt: number;
  readonly manual: boolean;
  readonly code: TCode;
  readonly message: string;
  readonly details: TErrors[TCode] extends true
    ? undefined
    : RequestHandlerAttemptDetails<
        StandardSchemaV1.InferOutput<
          Extract<TErrors[TCode], StandardSchemaV1<unknown, unknown>>
        >
      >;
};

/**
 * Attempt record for an unhandled request handler throw (no declared `code`).
 */
export type UnhandledRequestHandlerAttempt = {
  readonly attempt: number;
  readonly manual: boolean;
  readonly code: null;
  readonly message: string | null;
  readonly type: string | null;
  readonly details: { readonly status: "unspecified" };
};

/**
 * Per-try outcome record for a retried request handler (1-indexed `attempt`).
 */
export type RequestHandlerAttempt<
  TErrors extends ErrorDefinitions = Record<string, never>,
> =
  | UnhandledRequestHandlerAttempt
  | ([keyof TErrors & string] extends [never]
      ? never
      : {
          [K in keyof TErrors & string]: DeclaredRequestHandlerAttempt<
            TErrors,
            K
          >;
        }[keyof TErrors & string]);

/**
 * Writable escalation record for {@link RequestHandleExternal.escalateToManual} —
 * mirrors {@link RequestHandlerAttempt} minus engine-owned `attempt` and
 * `manual`, with schema-backed `details` as invocation input (not the
 * persisted `RequestHandlerAttemptDetails` union).
 */
/**
 * Untyped external escalation — `message` only (optional `type`). Omit `code`;
 * the engine persists `code: null` on the attempt row.
 */
export type RequestUntypedManualEscalationInput = {
  readonly message: string;
  readonly type?: string | null;
  readonly code?: never;
};

export type RequestDeclaredManualEscalationInput<
  TErrors extends ErrorDefinitions,
> = {
  [K in keyof TErrors & string]: TErrors[K] extends true
    ? { readonly code: K; readonly message: string }
    : {
        readonly code: K;
        readonly message: string;
        readonly details: SchemaInvocationInput<
          Extract<TErrors[K], StandardSchemaV1<unknown, unknown>>
        >;
      };
}[keyof TErrors & string];

/**
 * When `code` is omitted, escalation is untyped (`message`, optional `type`).
 * When `code` is set, it must be a declared error with the matching shape.
 */
export type RequestManualEscalationInput<
  TErrors extends ErrorDefinitions = Record<string, never>,
> =
  | RequestUntypedManualEscalationInput
  | ([keyof TErrors & string] extends [never]
      ? never
      : RequestDeclaredManualEscalationInput<TErrors>);

/**
 * Lazy, async-iterable accessor over request handler attempt records.
 */
export interface RequestHandlerAttemptAccessor<
  TErrors extends ErrorDefinitions = Record<string, never>,
> {
  last(): Promise<RequestHandlerAttempt<TErrors>>;
  all(): Promise<RequestHandlerAttempt<TErrors>[]>;
  count(): Promise<number>;
  [Symbol.asyncIterator](): AsyncIterableIterator<RequestHandlerAttempt<TErrors>>;
  reverse(): AsyncIterable<RequestHandlerAttempt<TErrors>>;
}

/**
 * Signals that a topic consumer failure is permanent — the runtime should not
 * retry and should proceed to the exhaustion path (`onConsumeError`).
 */
export class UnrecoverableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "UnrecoverableError";
  }
}

/**
 * Lazy, async-iterable accessor over execution attempt records for a retried
 * operation (step, request handler, queue message, topic consumer, forward
 * step observed from compensation `undo`, and similar).
 *
 * **Steps** persist one row per execution attempt (including attempts whose
 * `execute` returned successfully). **Queues, requests, and topics** persist
 * rows for failed tries only; successful handling writes the outcome directly.
 *
 * When `undo` runs for a compensable step, the forward step was attempted at
 * least once, so `count()` is always at least `1` on `CompensationInfo.attempts`.
 */
export interface AttemptAccessor {
  /** Most recent attempt record. */
  last(): Promise<Attempt>;
  /** All attempt records, oldest first (by attempt number). */
  all(): Promise<Attempt[]>;
  /** Number of persisted attempt records exposed by this accessor. */
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
 * throw. They are resolved automatically by patch + replay, or by `skip(...)`
 * on the workflow handle (which transitions the workflow to `'skipped'` and
 * records an operator-supplied result).
 */
export type WorkflowHaltStatus = "pending" | "resolved";

/**
 * Durable halt state for compensation block instance halts.
 *
 * Compensation block instances are isolated; if `undo` throws unrecognised,
 * the instance is halted. The operator can either patch + replay or
 * `skip(...)` the compensation block instance, which records the synthesised
 * result and abandons the running `undo`.
 */
export type CompensationBlockHaltStatus =
  | "pending"
  | "resolved"
  | "skipped";

// =============================================================================
// HALT RECORD — DURABLE ROW
// =============================================================================

/**
 * Durable record of a halt — one row per occurrence in the unified `halt`
 * table (`REFACTOR.MD` Part 3). One table covers every workflow kind in the
 * system (execution workflows, base compensation workflows, and compensation
 * block instances). The differences between workflow kinds are at the
 * operator-action layer (which actions are available against which kinds),
 * not at the halt-table layer.
 */
export interface HaltRecord {
  readonly id: number;
  readonly workflowId: string;
  readonly afterStepId: number | null;
  readonly status: WorkflowHaltStatus | CompensationBlockHaltStatus;
  readonly errorType: string | null;
  readonly errorMessage: string | null;
  readonly errorStacktrace: string | null;
  readonly errorDetails: JsonInput | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// =============================================================================
// CONNECTION AND TRANSACTION (forward-declared; step 19 firms up)
// =============================================================================

declare const workflowConnectionBrand: unique symbol;
declare const workflowTransactionBrand: unique symbol;

/**
 * Opaque database connection for engine IO.
 *
 * Step 19 introduces the `client.connection()` constructor and the
 * acquisition / disposal lifecycle. Step 12 wires `txOrConn?: IWorkflowConnection
 * | IWorkflowTransaction` onto every IO method on operator-facing handles.
 *
 * The brand is non-enumerable at runtime; user code cannot construct values of
 * this type directly.
 */
export interface IWorkflowConnection {
  /** @internal */
  readonly [workflowConnectionBrand]: true;
}

/**
 * Opaque database transaction for engine IO.
 *
 * `await using tx = await client.transaction(); ... await tx.commit();` is the
 * canonical usage pattern (step 19). Operations passed `{ txOrConn: tx }`
 * participate in the same transaction.
 */
export interface IWorkflowTransaction {
  /** @internal */
  readonly [workflowTransactionBrand]: true;
}

// =============================================================================
// OPERATOR-ACTION VERBS — TYPE-LEVEL SIGNATURES
//
// `REFACTOR.MD` Part 3 defines three terminal-action verbs on operator-
// addressable workflow rows: `sigkill()`, `sigterm()`, and `skip(result, opts?)`.
//
// Step 09 defines the verb signature types here. Step 12 plugs them onto the
// concrete handles (`WorkflowHandleExternal`, `CompensationBlockUniqueHandle`).
// =============================================================================

/**
 * Strategy for `skip(...)` on a workflow.
 *
 * - `"sigterm"` (default): cancel in-flight work via `AbortSignal`, then run
 *   the compensation stack before transitioning to `'skipped'`.
 * - `"sigkill"`: abandon in-flight work without raising any abort and without
 *   running compensation; transition immediately to `'skipped'`.
 */
export type SkipStrategy = "sigterm" | "sigkill";

/**
 * Common options bag accepted by every operator-action verb.
 *
 * Step 19 makes `txOrConn?` mandatory across every IO method; step 12 plugs
 * this options shape onto the concrete handle methods.
 */
export interface OperatorActionOptions {
  readonly txOrConn?: IWorkflowConnection | IWorkflowTransaction;
}

/** Outcome of a `sigkill()` invocation. Status is set on the workflow row. */
export interface SigkillOutcome {
  readonly status: "terminated";
}

/**
 * Outcome of a `sigterm()` invocation. The workflow runs the compensation
 * stack and transitions to `'completed'` or `'failed'` depending on the
 * compensation outcome.
 */
export type SigtermOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed" };

/** Outcome of a `skip(result, opts?)` invocation. Status is `'skipped'`. */
export interface SkipOutcome {
  readonly status: "skipped";
}

/**
 * Operator-action verbs available on globally-addressable workflows
 * (root execution workflows and independent roots started via
 * `externalWorkflows.<name>.start`).
 *
 * The `skip(...)` overload set is conditional on the workflow's result
 * schema: when `TResult` is `void`, `skip()` accepts zero data arguments
 * (just options); otherwise the operator-supplied result is required.
 */
export interface WorkflowOperatorActions<TResult> {
  sigkill(opts?: OperatorActionOptions): Promise<SigkillOutcome>;
  sigterm(opts?: OperatorActionOptions): Promise<SigtermOutcome>;
  skip(
    ...args: [TResult] extends [void]
      ? [opts?: OperatorActionOptions & { strategy?: SkipStrategy }]
      : [
          result: TResult,
          opts?: OperatorActionOptions & { strategy?: SkipStrategy },
        ]
  ): Promise<SkipOutcome>;
}

/**
 * Operator-action verbs available on compensation block instances.
 *
 * Compensation blocks expose only `skip(result)` — no `sigkill`, no
 * `sigterm`, no strategy choice. For compensation, `skip` IS abandonment
 * with an operator-supplied result. There is no graceful alternative
 * because compensation blocks have no compensation stack of their own
 * (Part 6 forbids recursive compensation).
 */
export interface CompensationBlockOperatorActions<TResult> {
  skip(
    ...args: [TResult] extends [void]
      ? [opts?: OperatorActionOptions]
      : [result: TResult, opts?: OperatorActionOptions]
  ): Promise<SkipOutcome>;
}

// =============================================================================
// RESULT TYPES — TERMINAL WAIT
//
// Returned by `WorkflowHandleExternal.wait()` and
// `WorkflowClientAccessor.execute()`. Discriminates the workflow's terminal
// outcome — completed (with the typed result), failed (with the typed
// declared business error), or terminated (with a runtime termination
// reason).
// =============================================================================

export type WorkflowResult<T, TError = WorkflowExecutionError> =
  | { ok: true; status: "complete"; data: T }
  | { ok: false; status: "failed"; error: TError }
  | {
      ok: false;
      status: "terminated";
      reason: WorkflowTerminationReason;
    };

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
 * await handle.wait({ signal: AbortSignal.timeout(5_000) });
 *
 * // Cancellable wait
 * const controller = new AbortController();
 * await handle.wait({ signal: controller.signal });
 * // elsewhere: controller.abort();
 * ```
 *
 * If the signal aborts, wait operations reject with AbortError.
 */
export interface ExternalWaitOptions {
  signal?: AbortSignal;
}
