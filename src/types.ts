import type { StandardSchemaV1 } from "./internal/standard-schema";

// =============================================================================
// SCHEMA DEFINITIONS
// =============================================================================

/**
 * Channel definitions map - keys are channel names, values are standard schemas.
 * Channels are for async message passing between workflows.
 */
export type ChannelDefinitions = Record<
  string,
  StandardSchemaV1<unknown, unknown>
>;

/**
 * Stream definitions map - keys are stream names, values are standard schemas.
 * Streams are append-only logs for external consumption.
 */
export type StreamDefinitions = Record<
  string,
  StandardSchemaV1<unknown, unknown>
>;

/**
 * Event definitions - keys are event names, values are `true`.
 * Events are value-less write-once flags for coordination.
 */
export type EventDefinitions = Record<string, true>;

/**
 * Patch definitions — keys are patch names, values indicate active status.
 *
 * - `true`: The patch is active — new workflows will execute the patched code path.
 * - `false`: The patch is deprecated — new workflows will NOT execute the patched code path,
 *   but old (replaying) workflows that already entered it will still run it.
 *
 * Patches enable safe, incremental evolution of workflow code without breaking
 * in-flight workflows.
 */
export type PatchDefinitions = Record<string, boolean>;

/**
 * RNG definitions — keys are RNG stream names, values are either:
 *
 * - `true`: A simple named RNG stream. Accessed as `ctx.rng.name` (a `DeterministicRNG` instance).
 * - A key derivation function: A parametrized RNG stream. Accessed as `ctx.rng.name(...args)`
 *   which returns a `DeterministicRNG` instance. The function receives the parameters and
 *   returns a string key that the engine uses (prefixed with the definition name) to seed
 *   the RNG. Must be pure and deterministic — same arguments must always produce the same key.
 *
 * @example
 * ```typescript
 * rng: {
 *   txnId: true,                                               // simple
 *   itemsShuffle: (category: string) => `items:${category}`,   // parametrized
 * }
 * // ctx.rng.txnId.uuidv4()
 * // ctx.rng.itemsShuffle('electronics').shuffle(products)
 * ```
 */
export type RngDefinitions = Record<
  string,
  true | ((...args: any[]) => string)
>;

/**
 * Accessor for a single patch on ctx.patches.
 *
 * Supports two usage patterns:
 *
 * **Boolean form** — returns true/false indicating whether the patch is active.
 * Use for removing code or complex restructuring:
 * ```typescript
 * if (!await ctx.patches.removeLegacyEmail()) {
 *   await ctx.steps.sendLegacyEmail(...);
 * }
 * ```
 *
 * **Callback form** — runs the callback if active, returns default otherwise.
 * Use for adding new code paths (90% of the time):
 * ```typescript
 * const result = await ctx.patches.antifraud(async () => {
 *   return await ctx.steps.fraudCheck(flightId);
 * }, null);
 * ```
 */
export interface PatchAccessor {
  /** Boolean form — returns whether this patch is active for this workflow instance */
  (): Promise<boolean>;
  /** Callback form with default — runs callback if active, returns default otherwise */
  <T, D>(callback: () => Promise<T>, defaultValue: D): Promise<T | D>;
  /** Callback form without default — runs callback if active, returns undefined otherwise */
  <T>(callback: () => Promise<T>): Promise<T | undefined>;
}

// =============================================================================
// RETRY POLICY
// =============================================================================

/**
 * Configuration for retry behavior and timeouts.
 */
export interface RetryPolicyOptions {
  /** Maximum retry attempts (default: unlimited) */
  maxAttempts?: number;
  /** Initial retry interval in seconds (default: 1) */
  intervalSeconds?: number;
  /** Backoff multiplier (default: 2) */
  backoffRate?: number;
  /** Maximum retry interval cap in seconds (default: 300) */
  maxIntervalSeconds?: number;
  /** Step timeout in seconds (default: no timeout) */
  timeoutSeconds?: number;
}

// =============================================================================
// STEP DEFINITION
// =============================================================================

/**
 * Step definition - created via defineStep().
 *
 * Steps are durable, idempotent operations executed outside the workflow.
 *
 * Use your own application logger (console.log, Winston, Pino, etc.) inside
 * step implementations — workflow-level logging is separate via ctx.logger.
 */
export interface StepDefinition<
  TArgs extends unknown[] = unknown[],
  TResultSchema extends StandardSchemaV1<unknown, unknown> = any,
> {
  readonly name: string;
  /**
   * Execute function — must return z.input<schema>.
   * Use your own application logger for step-level logging.
   */
  readonly execute: (
    context: { signal: AbortSignal },
    ...args: TArgs
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  /** Result schema for encoding/decoding */
  readonly schema: TResultSchema;
  /** Default retry policy */
  readonly retryPolicy?: RetryPolicyOptions;
}

/**
 * Map of step definitions.
 */
export type StepDefinitions = Record<string, StepDefinition<any[], any>>;

/**
 * Map of workflow definitions for child workflows.
 */
export type WorkflowDefinitions = Record<
  string,
  WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>
>;

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
  | { status: "terminated" };

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
  | { ok: false; status: "terminated" };

/**
 * Result of getting a workflow's result (engine level).
 * Includes all possible outcomes including timeout and not_found.
 */
export type WorkflowResultExternal<TResult> =
  | { ok: true; status: "complete"; data: TResult }
  | { ok: false; status: "failed"; error: WorkflowExecutionError }
  | { ok: false; status: "terminated" }
  | { ok: false; status: "timeout" }
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
  | { ok: false; status: "timeout" }
  | { ok: false; status: "not_found" };

/**
 * Result of reading from a stream without timeout.
 * When no timeout is specified, timeout cannot occur.
 */
export type StreamReadResultNoTimeout<T> =
  | { ok: true; status: "received"; data: T; offset: number }
  | { ok: false; status: "closed" }
  | { ok: false; status: "not_found" };

/**
 * Result of reading the next record from a stream iterator.
 */
export type StreamIteratorReadResult<T> =
  | { ok: true; status: "record"; data: T; offset: number }
  | { ok: false; status: "closed" }
  | { ok: false; status: "timeout" };

/**
 * Result of reading the next record from a stream iterator without timeout.
 * When no timeout is specified, timeout cannot occur.
 */
export type StreamIteratorReadResultNoTimeout<T> =
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
 * await handle.getResult({ signal: AbortSignal.timeout(5_000) });
 *
 * // Cancellable wait
 * const controller = new AbortController();
 * await handle.getResult({ signal: controller.signal });
 * // elsewhere: controller.abort();
 * ```
 */
export interface ExternalWaitOptions {
  signal?: AbortSignal;
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

// =============================================================================
// DETERMINISTIC RNG
// =============================================================================

/**
 * Deterministic random utilities for use inside workflows.
 * Accessed through typed RNG accessors on the workflow context.
 */
export interface DeterministicRNG {
  /** Generate a deterministic UUID */
  uuidv4(): string;
  /** Generate a deterministic integer in range [min, max] */
  int(minInclusive?: number, maxInclusive?: number): number;
  /** Generate a deterministic float in range [0, 1) */
  next(): number;
  /** boolean with p = 0.5 */
  bool(): boolean;
  /** boolean with custom probability */
  chance(probability: number): boolean;
  /** Generate a deterministic string of length n */
  string(options: { length: number; alphabet?: string }): string;
  /** Pick a random element from an array */
  pick<T>(array: readonly T[]): T;
  /** Pick a random element from an array with weights */
  weightedPick<T>(items: readonly { value: T; weight: number }[]): T;
  /** Shuffle an array */
  shuffle<T>(array: readonly T[]): T[];
  /** Sample count elements from an array */
  sample<T>(array: readonly T[], count: number): T[];
  /** Sample count elements from an array with weights */
  weightedSample<T>(
    items: readonly { value: T; weight: number }[],
    count: number,
  ): T[];
  /** Generate a deterministic bytes array */
  bytes(length: number): Uint8Array;
}

/**
 * Map RNG definitions to their runtime accessor types.
 *
 * - `true` entries become `DeterministicRNG` instances (direct access).
 * - Function entries become functions with the same signature that return `DeterministicRNG`.
 */
export type RngAccessors<TRng extends RngDefinitions> = {
  [K in keyof TRng]: TRng[K] extends true
    ? DeterministicRNG
    : TRng[K] extends (...args: infer A) => string
      ? (...args: A) => DeterministicRNG
      : never;
};

// =============================================================================
// FAILURE INFO TYPES
// =============================================================================

/**
 * Failure information for a step, passed to `.failure()` builder callbacks
 * and concurrency primitive failure handlers.
 */
export interface StepFailureInfo {
  readonly reason: "attempts_exhausted" | "timeout";
  readonly errors: StepErrorAccessor;
}

/**
 * Failure information for a child workflow, passed to `.failure()` builder callbacks.
 * Discriminated union — the child may have failed (threw an error) or been
 * terminated externally by an administrator.
 */
export type ChildWorkflowFailureInfo =
  | { readonly status: "failed"; readonly error: WorkflowExecutionError }
  | { readonly status: "terminated" };

/**
 * Augment a failure info type with a `compensate()` handle.
 *
 * `compensate()` invokes the compensation callback registered via `.compensate()`.
 * Calling it explicitly discharges the SAGA obligation for this handle — the engine
 * will NOT run the compensation again at scope exit.
 *
 * **Context switch:** Calling `compensate()` transparently switches the
 * execution context to compensation mode (SIGTERM-resilient). The compensation
 * callback runs to completion even if SIGTERM arrives mid-execution. Control
 * returns to the `failure` handler in normal WorkflowContext after.
 *
 * If `compensate()` is NOT called, the engine still runs the compensation at
 * scope exit / LIFO unwinding (the safe default).
 *
 * Only present when a `compensate` callback was registered. If no `compensate`
 * was provided, the failure object does not include `compensate` — full type safety.
 */
export type WithCompensation<T> = T & {
  readonly compensate: () => Promise<void>;
};

/**
 * Failure information for a scope branch, passed to `failure` callbacks in
 * forEach, map, and match handlers.
 *
 * Includes `compensate()` to eagerly discharge the LIFO compensation obligation
 * for any compensated steps registered within this branch. If not called, the
 * engine runs compensations at scope exit (safe default).
 */
export interface BranchFailureInfo {
  compensate(): Promise<void>;
  /**
   * Explicitly discharge the compensation obligation for this branch
   * WITHOUT running the compensation callback.
   * Use when you have already compensated externally, or the operation is
   * known to have had no effect and compensation is unnecessary.
   */
  dontCompensate(): void;
}

// =============================================================================
// STEP CALL — THENABLE BUILDER (WorkflowContext)
// =============================================================================

/**
 * Thenable returned by calling a step in WorkflowContext.
 *
 * Chain builder methods before awaiting:
 * - `.compensate()` — register compensation callback (switches HasCompensation to true)
 * - `.retry()` — override retry policy
 * - `.failure()` — handle failure explicitly instead of auto-terminating; return TFail
 * - `.complete()` — transform success result
 *
 * Await the call to resolve to `T | TFail` (happy path when no `.failure()` is
 * chained auto-terminates the workflow on failure).
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam TCompCtx - The CompensationContext type for this workflow.
 */
export interface StepCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  TCompCtx = unknown,
> {
  /**
   * Register a compensation callback for this step.
   * Runs during LIFO unwinding when the workflow fails.
   * May be invoked explicitly via `failure.compensate()` for eager discharge.
   */
  compensate(
    cb: (ctx: TCompCtx, result: StepCompensationResult<T>) => Promise<void>,
  ): StepCall<T, TFail, true, TCompCtx>;

  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): StepCall<T, TFail, HasCompensation, TCompCtx>;

  /**
   * Handle step failure explicitly — the workflow does NOT auto-terminate.
   * The callback return value becomes TFail in the resolved union.
   *
   * If `.compensate()` was called, the failure object includes `compensate()`
   * for eager discharge. If not called, compensation still runs at scope exit.
   */
  failure<R>(
    cb: (
      failure: HasCompensation extends true
        ? WithCompensation<StepFailureInfo>
        : StepFailureInfo,
    ) => R,
  ): StepCall<T, Awaited<R>, HasCompensation, TCompCtx>;

  /**
   * Transform the success result.
   * The callback return value replaces T in the resolved type.
   */
  complete<R>(cb: (data: T) => R): StepCall<Awaited<R>, TFail, HasCompensation, TCompCtx>;

  then<R1 = T | TFail, R2 = never>(
    onfulfilled?:
      | ((value: T | TFail) => R1 | PromiseLike<R1>)
      | null
      | undefined,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null | undefined,
  ): Promise<R1 | R2>;
}

// =============================================================================
// COMPENSATION STEP CALL — THENABLE (CompensationContext)
// =============================================================================

/**
 * Thenable returned by calling a step in CompensationContext.
 *
 * Always resolves to `CompensationStepResult<T>` — compensation code MUST
 * handle both ok and !ok cases gracefully.
 *
 * Only `.retry()` is available — no `.compensate()` (can't nest compensations),
 * no `.failure()` (failures are in the result union).
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 */
export interface CompensationStepCall<T> {
  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): CompensationStepCall<T>;

  then<R1 = CompensationStepResult<T>, R2 = never>(
    onfulfilled?:
      | ((value: CompensationStepResult<T>) => R1 | PromiseLike<R1>)
      | null
      | undefined,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null | undefined,
  ): Promise<R1 | R2>;
}

// =============================================================================
// FOREIGN WORKFLOW HANDLE
// =============================================================================

/**
 * A limited handle to an existing (non-child) workflow instance.
 * Only channels.send() is available — prevents tight coupling.
 * Send is fire-and-forget: returns void, no delivery confirmation.
 */
export interface ForeignWorkflowHandle<
  TChannels extends ChannelDefinitions = Record<string, never>,
> {
  readonly workflowId: string;

  /**
   * Channels for sending messages to this workflow.
   * Fire-and-forget: returns void.
   */
  readonly channels: {
    [K in keyof TChannels]: {
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): Promise<void>;
    };
  };
}

// =============================================================================
// WORKFLOW CALL — THENABLE BUILDER (WorkflowContext)
// =============================================================================

/**
 * Thenable returned after applying at least one result-mode builder
 * (`.compensate()`, `.failure()`, `.complete()`) on a `WorkflowCall`.
 *
 * Result mode and detached mode are mutually exclusive:
 * once a result builder is applied, `.detached()` is no longer available.
 *
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam TCompCtx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowCallResult<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  TCompCtx = unknown,
> {
  /**
   * Register a compensation callback for this child workflow invocation.
   * Runs during LIFO unwinding when the parent workflow fails.
   */
  compensate(
    cb: (
      ctx: TCompCtx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, TCompCtx>;

  /**
   * Handle child workflow failure explicitly — the parent does NOT auto-terminate.
   */
  failure<R>(
    cb: (
      failure: HasCompensation extends true
        ? WithCompensation<ChildWorkflowFailureInfo>
        : ChildWorkflowFailureInfo,
    ) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, TCompCtx>;

  /**
   * Transform the child workflow's success result.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, TCompCtx>;

  then<R1 = T | TFail, R2 = never>(
    onfulfilled?:
      | ((value: T | TFail) => R1 | PromiseLike<R1>)
      | null
      | undefined,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null | undefined,
  ): Promise<R1 | R2>;
}

/**
 * Thenable returned by calling a child workflow accessor in WorkflowContext.
 *
 * Supports two mutually exclusive modes:
 *
 * **Structured result mode** — chain `.compensate()`, `.failure()`, `.complete()`,
 * then await. The parent awaits the child's terminal result.
 *
 * **Detached messaging mode** — chain `.detached()`, then await. The child runs
 * independently; the result is a `ForeignWorkflowHandle` for message passing only.
 *
 * Builder exclusivity is enforced at the type level: applying a result builder
 * returns `WorkflowCallResult` (no `.detached()`), and calling `.detached()` returns
 * `DetachedWorkflowCall` (no result builders).
 *
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam TCompCtx - The CompensationContext type for the parent workflow.
 * @typeParam TChannels - Channel definitions of the child workflow (for `.detached()`).
 */
export interface WorkflowCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  TCompCtx = unknown,
  TChannels extends ChannelDefinitions = Record<string, never>,
> {
  /**
   * Register a compensation callback — enters result mode (no `.detached()` after this).
   */
  compensate(
    cb: (
      ctx: TCompCtx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, TCompCtx>;

  /**
   * Handle child workflow failure explicitly — enters result mode (no `.detached()` after this).
   */
  failure<R>(
    cb: (
      failure: HasCompensation extends true
        ? WithCompensation<ChildWorkflowFailureInfo>
        : ChildWorkflowFailureInfo,
    ) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, TCompCtx>;

  /**
   * Transform the child workflow's success result — enters result mode.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, TCompCtx>;

  /**
   * Switch to detached mode — the child runs independently of the parent's lifecycle.
   *
   * No scope required. No compensation. The child is NOT terminated when the parent fails.
   * Resolves to a `ForeignWorkflowHandle` for fire-and-forget message passing.
   */
  detached(): DetachedWorkflowCall<TChannels>;

  then<R1 = T | TFail, R2 = never>(
    onfulfilled?:
      | ((value: T | TFail) => R1 | PromiseLike<R1>)
      | null
      | undefined,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null | undefined,
  ): Promise<R1 | R2>;
}

// =============================================================================
// COMPENSATION WORKFLOW CALL — THENABLE (CompensationContext)
// =============================================================================

/**
 * Thenable returned by calling a child workflow accessor in CompensationContext.
 * Always resolves to `WorkflowResult<T>` — compensation code MUST handle all outcomes.
 *
 * @typeParam T - Decoded child workflow result type.
 */
export interface CompensationWorkflowCall<T> {
  then<R1 = WorkflowResult<T>, R2 = never>(
    onfulfilled?:
      | ((value: WorkflowResult<T>) => R1 | PromiseLike<R1>)
      | null
      | undefined,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null | undefined,
  ): Promise<R1 | R2>;
}

// =============================================================================
// DETACHED WORKFLOW CALL — THENABLE
// =============================================================================

/**
 * Thenable returned by `.detached()` on a `WorkflowCall`.
 * Resolves to a `ForeignWorkflowHandle` for fire-and-forget channel messaging.
 *
 * @typeParam TChannels - Channel definitions of the child workflow.
 */
export interface DetachedWorkflowCall<
  TChannels extends ChannelDefinitions = Record<string, never>,
> {
  then<R1 = ForeignWorkflowHandle<TChannels>, R2 = never>(
    onfulfilled?:
      | ((value: ForeignWorkflowHandle<TChannels>) => R1 | PromiseLike<R1>)
      | null
      | undefined,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null | undefined,
  ): Promise<R1 | R2>;
}

// =============================================================================
// WORKFLOW ACCESSORS (CONTEXT-SPECIFIC)
// =============================================================================

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in WorkflowContext.
 *
 * Call it with `{ workflowId, args, timeoutSeconds? }` to get a `WorkflowCall<T>`.
 * Chain builders before awaiting:
 * - `.compensate()` — register compensation
 * - `.failure()` — explicit failure handling
 * - `.complete()` — transform success result
 * - `.detached()` — fire-and-forget mode, resolves to foreign handle
 *
 * @typeParam W - The child workflow definition.
 * @typeParam TCompCtx - The parent workflow's CompensationContext type.
 */
export interface ChildWorkflowAccessor<
  W extends WorkflowDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >,
  TCompCtx = unknown,
> {
  (options: {
    workflowId: string;
    args?: InferWorkflowArgsInput<W>;
    timeoutSeconds?: number;
  }): WorkflowCall<
    InferWorkflowResult<W>,
    never,
    false,
    TCompCtx,
    InferWorkflowChannels<W>
  >;
}

/**
 * Foreign workflow accessor on `ctx.foreignWorkflows` in WorkflowContext.
 *
 * Use `.get(workflowId)` to obtain a `ForeignWorkflowHandle` for an existing
 * (non-child) workflow instance. Only `channels.send()` is available — no
 * events, streams, or lifecycle (prevents tight coupling).
 *
 * @typeParam W - The workflow definition (for channel type inference).
 */
export interface ForeignWorkflowAccessor<
  W extends WorkflowDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >,
> {
  /**
   * Get a limited handle to an existing workflow instance.
   * Only channels.send() is available (fire-and-forget).
   *
   * @param workflowId - The workflow instance ID.
   */
  get(workflowId: string): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in CompensationContext.
 * Returns full `WorkflowResult<T>` — compensation code must handle all outcomes.
 *
 * @typeParam W - The child workflow definition.
 */
export interface CompensationChildWorkflowAccessor<
  W extends WorkflowDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >,
> {
  (options: {
    workflowId: string;
    args?: InferWorkflowArgsInput<W>;
    timeoutSeconds?: number;
  }): CompensationWorkflowCall<InferWorkflowResult<W>>;
}

// =============================================================================
// CHANNEL HANDLE, STREAM ACCESSOR, EVENT ACCESSOR (WORKFLOW INTERNAL)
// =============================================================================

/**
 * Channel handle on ctx.channels.
 * Can be used directly for receive, or passed into select.
 * T is the decoded type (z.output<Schema>).
 */
export interface ChannelHandle<T> {
  /**
   * Receive a message from this channel (FIFO order).
   * Blocks until a message arrives. Returns the decoded value directly.
   */
  receive(): Promise<T>;
}

/**
 * Stream accessor on ctx.streams (for writing from within the workflow).
 * T is the encoded type (z.input<Schema>).
 */
export interface StreamAccessor<T> {
  /**
   * Write a record to the stream.
   * @param data - Record data (z.input type — encoded).
   * @returns The offset at which the record was saved.
   */
  write(data: T): Promise<number>;
}

/**
 * Event accessor on ctx.events (for setting from within the workflow).
 */
export interface EventAccessor {
  /**
   * Set the event (idempotent — second call is no-op).
   */
  set(): Promise<void>;
}

// =============================================================================
// LIFECYCLE EVENTS
// =============================================================================

/**
 * Engine-managed lifecycle event names.
 * Automatically managed by the engine — cannot be set by user code.
 *
 * - started:       set when workflow begins execution
 * - sigterm:       set when SIGTERM signal is received
 * - compensating:  set when compensation begins
 * - compensated:   set when all compensations finish
 * - complete:      set when workflow returns successfully;
 *                  preemptively "never" when failed/terminated
 * - failed:        set when workflow throws;
 *                  preemptively "never" when complete
 *
 * After the workflow reaches a terminal state, all lifecycle events that were
 * not set are marked "never" — they will never fire.
 */
export type LifecycleEventName =
  | "started"
  | "sigterm"
  | "compensating"
  | "compensated"
  | "complete"
  | "failed";

/**
 * Lifecycle event accessor — supports wait/get with "never" semantics.
 */
export interface LifecycleEventAccessor {
  /**
   * Wait for the lifecycle event to be set.
   * Returns "never" if the workflow reached a terminal state without this event firing.
   */
  wait(): Promise<EventWaitResultNoTimeout>;

  /**
   * Wait for the lifecycle event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): Promise<EventWaitResult>;

  /**
   * Check if the lifecycle event is set (non-blocking).
   */
  get(): Promise<EventCheckResult>;
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
  wait(): Promise<EventWaitResultNoTimeout>;

  /**
   * Wait for the event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): Promise<EventWaitResult>;

  /**
   * Check if the event is set (non-blocking).
   */
  get(): Promise<EventCheckResult>;
}

/**
 * All lifecycle events available on a workflow handle.
 */
export interface LifecycleEvents {
  readonly started: LifecycleEventAccessor;
  readonly sigterm: LifecycleEventAccessor;
  readonly compensating: LifecycleEventAccessor;
  readonly compensated: LifecycleEventAccessor;
  readonly complete: LifecycleEventAccessor;
  readonly failed: LifecycleEventAccessor;
}

// =============================================================================
// SCOPE TYPES — CLOSURES AND BRANCH HANDLES
// =============================================================================

/**
 * A scope branch — an async closure that runs on the virtual event loop.
 * Passed into `ctx.scope()` entries. The engine interleaves branch execution
 * at durable yield points (step calls, child workflow calls, channel receives, etc.).
 *
 * @typeParam T - The resolved value type of the branch.
 */
export type ScopeBranch<T> = () => Promise<T>;

/**
 * A handle to a running scope branch — awaitable in the scope callback.
 * Resolves to T when the branch completes successfully.
 *
 * `BranchHandle<T>` values are produced by `ctx.scope()` and can be:
 * - Directly awaited: `const result = await flight`
 * - Passed into `ctx.select()`, `ctx.forEach()`, `ctx.map()`
 * - Accumulated into collections for dynamic fan-out
 *
 * @typeParam T - The resolved value type.
 */
export interface BranchHandle<T> extends Promise<T> {}

/**
 * A group of branch handles — single, array, or map.
 * Used as input to `ctx.select()`, `ctx.forEach()`, and `ctx.map()`.
 *
 * - Single: `BranchHandle<T>` — one branch
 * - Array: `BranchHandle<T>[]` — N parallel branches
 * - Map: `Map<K, BranchHandle<T>>` — keyed parallel branches
 *
 * @typeParam T - The branch value type.
 * @typeParam K - The map key type (only relevant for Map variant).
 */
export type HandleGroup<T, K = any> =
  | BranchHandle<T>
  | BranchHandle<T>[]
  | Map<K, BranchHandle<T>>;

/**
 * Valid entry values for `ctx.scope()` declarations.
 * Each entry is a closure (single) or a collection of closures (array/map).
 */
export type ScopeEntries = Record<
  string,
  | (() => Promise<any>)
  | (() => Promise<any>)[]
  | Map<any, () => Promise<any>>
>;

/**
 * Maps scope entry closures to their corresponding branch handle types,
 * preserving collection structure (single → BranchHandle, array → array, map → map).
 */
export type ScopeHandles<E extends ScopeEntries> = {
  [K in keyof E]: E[K] extends () => Promise<infer T>
    ? BranchHandle<T>
    : E[K] extends (infer U)[]
      ? U extends () => Promise<infer T>
        ? BranchHandle<T>[]
        : never
      : E[K] extends Map<infer MK, infer V>
        ? V extends () => Promise<infer T>
          ? Map<MK, BranchHandle<T>>
          : never
        : never;
};

// =============================================================================
// SELECT — HANDLE TYPES
// =============================================================================

/**
 * Handle types that can be passed into ctx.select() (WorkflowContext and CompensationContext).
 * Includes BranchHandle collections for dynamic fan-out.
 */
export type SelectableHandle =
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  | ChannelHandle<any>;

// =============================================================================
// SELECT — EVENT TYPES (WorkflowContext)
// =============================================================================

/**
 * Map a handle type to its select event result type.
 *
 * - BranchHandle: `{ key, status: "complete", data: T } | { key, status: "failed", failure }`
 * - BranchHandle[]: `{ key, innerKey: number, status: "complete", data: T } | { key, innerKey: number, status: "failed", failure }`
 * - Map<K, BranchHandle>: `{ key, innerKey: K, status: "complete", data: T } | { key, innerKey: K, status: "failed", failure }`
 * - ChannelHandle: `{ key, data: T }`
 */
export type HandleSelectEvent<K extends string, H> =
  H extends BranchHandle<infer T>
    ?
        | { key: K; status: "complete"; data: T }
        | { key: K; status: "failed"; failure: BranchFailureInfo }
    : H extends BranchHandle<infer T>[]
      ?
          | { key: K; innerKey: number; status: "complete"; data: T }
          | { key: K; innerKey: number; status: "failed"; failure: BranchFailureInfo }
      : H extends Map<infer MK, BranchHandle<infer T>>
        ?
            | { key: K; innerKey: MK; status: "complete"; data: T }
            | { key: K; innerKey: MK; status: "failed"; failure: BranchFailureInfo }
        : H extends ChannelHandle<infer T>
          ? { key: K; data: T }
          : never;

/**
 * What a match handler receives for a specific key.
 *
 * - BranchHandle<T>: `T` directly
 * - BranchHandle<T>[]: `{ data: T; innerKey: number }`
 * - Map<K, BranchHandle<T>>: `{ data: T; innerKey: K }`
 * - ChannelHandle<T>: `T` directly
 */
export type HandleMatchData<H> =
  H extends BranchHandle<infer T>
    ? T
    : H extends BranchHandle<infer T>[]
      ? { data: T; innerKey: number }
      : H extends Map<infer MK, BranchHandle<infer T>>
        ? { data: T; innerKey: MK }
        : H extends ChannelHandle<infer T>
          ? T
          : never;

/**
 * Union of all possible events from a select record.
 */
export type SelectEvent<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]: HandleSelectEvent<K, M[K]>;
}[keyof M & string];

/**
 * Union of successful data values yielded by `for await...of` on a Selection.
 * Branch handles yield their result type T; channel handles yield their message type T.
 * For collections (array/map), the per-element data type is yielded.
 * A branch failure auto-terminates the workflow when iterating with `for await`.
 */
export type SelectDataUnion<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]: BranchData<M[K]>;
}[keyof M & string];

// =============================================================================
// MATCH HELPERS
// =============================================================================

/**
 * Result of Selection.match().
 */
export type SelectMatchResult<T> =
  | { ok: true; status: "matched"; data: T }
  | { ok: false; status: "exhausted" };

/**
 * Extract the return type from a match/forEach/map handler entry.
 * Supports plain functions and `{ complete, failure }` objects.
 */
type ExtractHandlerReturn<H> = H extends (...args: any[]) => infer R
  ? Awaited<R>
  : H extends {
        complete: (...args: any[]) => infer R;
        failure: (...args: any[]) => infer R2;
      }
    ? Awaited<R> | Awaited<R2>
    : H extends { complete: (...args: any[]) => infer R }
      ? Awaited<R>
      : never;

// =============================================================================
// MATCH HANDLER ENTRY TYPES
// =============================================================================

/**
 * A match handler entry for a specific key.
 *
 * For BranchHandle keys (single or collection), the handler can be either a plain
 * function (failure auto-terminates workflow) or a `{ complete, failure }` object
 * for explicit failure recovery.
 *
 * For channels, streams, and events, only a plain function is allowed.
 */
export type MatchHandlerEntry<H extends SelectableHandle> = H extends
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  ?
      | ((data: HandleMatchData<H>) => any)
      | {
          complete: (data: HandleMatchData<H>) => any;
          failure: (failure: BranchFailureInfo) => any;
        }
  : (data: HandleMatchData<H>) => any;

/**
 * Handler map for Selection.match().
 */
export type MatchHandlers<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]?: MatchHandlerEntry<M[K]>;
};

/**
 * Return type of Selection.match().
 */
export type MatchReturn<
  M extends Record<string, SelectableHandle>,
  H extends MatchHandlers<M>,
> = {
  [K in keyof H & string]: ExtractHandlerReturn<H[K]>;
}[keyof H & string];

/**
 * Union of select events from keys NOT present in the handler map.
 */
export type UnhandledSelectEvent<
  M extends Record<string, SelectableHandle>,
  H extends Partial<Record<keyof M & string, any>>,
> = {
  [K in Exclude<keyof M & string, keyof H & string>]: HandleSelectEvent<
    K,
    M[K]
  >;
}[Exclude<keyof M & string, keyof H & string>];

// =============================================================================
// SELECTION (WorkflowContext)
// =============================================================================

/**
 * A selection — multiplexes multiple handles and yields events as they arrive.
 * Events are ordered by global_sequence for deterministic replay.
 *
 * **`for await...of`** — the primary iteration surface.
 * Yields `SelectDataUnion<M>` (successful data values) until all handles are exhausted.
 * Any branch failure auto-terminates the workflow and triggers LIFO compensation.
 * Use this for simple "process everything, fail on any error" patterns.
 *
 * **`.match()`** — the lower-level, key-aware API.
 * Waits for the first event matching a provided handler map.
 * Handlers can be plain functions (failure crashes workflow) or
 * `{ complete, failure }` objects for BranchHandle keys for explicit recovery.
 * Returns `{ ok: false, status: "exhausted" }` when all handles resolve without matching.
 *
 * For collection handles (BranchHandle[], Map<K, BranchHandle>), each element
 * produces its own event with an `innerKey`.
 *
 * @typeParam M - The handle record type.
 */
export interface Selection<M extends Record<string, SelectableHandle>>
  extends AsyncIterable<SelectDataUnion<M>> {
  /**
   * Wait for the first event matching a handler.
   *
   * Handlers can be plain functions (failure crashes workflow) or
   * `{ complete, failure }` objects for BranchHandle keys.
   */
  match<H extends MatchHandlers<M>>(
    handlers: H,
  ): Promise<SelectMatchResult<MatchReturn<M, H>>>;

  /** Handlers + default for unhandled events. */
  match<H extends MatchHandlers<M>, TDefault>(
    handlers: H,
    defaultHandler: (
      event: UnhandledSelectEvent<M, H>,
    ) => Promise<TDefault> | TDefault,
  ): Promise<SelectMatchResult<MatchReturn<M, H> | Awaited<TDefault>>>;

  /**
   * Live set of unresolved handle keys.
   */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// SELECTION (CompensationContext)
// =============================================================================

/**
 * A selection in CompensationContext.
 *
 * **`for await...of`** — yields `SelectDataUnion<M>` until all handles are exhausted.
 * Any branch failure auto-terminates the compensation scope.
 *
 * **`.match()`** — key-aware, one-event-at-a-time API with explicit `{ complete, failure }`
 * handlers for granular recovery during compensation.
 */
export interface CompensationSelection<M extends Record<string, SelectableHandle>>
  extends AsyncIterable<SelectDataUnion<M>> {
  /** Pattern-match on events. */
  match<H extends MatchHandlers<M>>(
    handlers: H,
  ): Promise<SelectMatchResult<MatchReturn<M, H>>>;

  /** Handlers + default. */
  match<H extends MatchHandlers<M>, TDefault>(
    handlers: H,
    defaultHandler: (
      event: UnhandledSelectEvent<M, H>,
    ) => Promise<TDefault> | TDefault,
  ): Promise<SelectMatchResult<MatchReturn<M, H> | Awaited<TDefault>>>;

  /** Live set of unresolved handle keys. */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// forEach / map — HANDLER ENTRY TYPES
// =============================================================================

/**
 * Extract data type from a branch handle or collection.
 * For collections, this is the element's data type (innerKey is separate).
 */
type BranchData<H> =
  H extends BranchHandle<infer T>
    ? T
    : H extends BranchHandle<infer T>[]
      ? T
      : H extends Map<any, BranchHandle<infer T>>
        ? T
        : never;

/**
 * Extract the inner key type for collection handles.
 * Single BranchHandle has no innerKey (never).
 */
type BranchInnerKey<H> =
  H extends BranchHandle<any>
    ? never
    : H extends BranchHandle<any>[]
      ? number
      : H extends Map<infer K, BranchHandle<any>>
        ? K
        : never;

/**
 * A forEach handler entry for a branch handle or collection.
 *
 * - Single `BranchHandle<T>`: plain `(data: T) => void` or `{ complete, failure }`
 * - `BranchHandle<T>[]`: receives `(data: T, innerKey: number)` per element
 * - `Map<K, BranchHandle<T>>`: receives `(data: T, innerKey: K)` per entry
 *
 * For plain function handlers, failure auto-terminates the workflow.
 * For `{ complete, failure }` handlers, failure is handled explicitly.
 */
export type ForEachHandlerEntry<H extends SelectableHandle> =
  H extends BranchHandle<any> | BranchHandle<any>[] | Map<any, BranchHandle<any>>
    ? BranchInnerKey<H> extends never
      ? // Single BranchHandle
          | ((data: BranchData<H>) => Promise<void> | void)
            | {
                complete: (data: BranchData<H>) => Promise<void> | void;
                failure: (failure: BranchFailureInfo) => Promise<void> | void;
              }
      : // Collection BranchHandle (array or map)
          | ((
                data: BranchData<H>,
                innerKey: BranchInnerKey<H>,
              ) => Promise<void> | void)
            | {
                complete: (
                  data: BranchData<H>,
                  innerKey: BranchInnerKey<H>,
                ) => Promise<void> | void;
                failure: (
                  failure: BranchFailureInfo,
                  innerKey: BranchInnerKey<H>,
                ) => Promise<void> | void;
              }
    : never;

/**
 * A map handler entry for a branch handle or collection.
 * Same structure as ForEachHandlerEntry but returns a value instead of void.
 *
 * `ctx.map()` return type mirrors the collection structure:
 * - Single → single transformed value
 * - Array → array of transformed values
 * - Map → Map of transformed values
 */
export type MapHandlerEntry<H extends SelectableHandle> =
  H extends BranchHandle<any> | BranchHandle<any>[] | Map<any, BranchHandle<any>>
    ? BranchInnerKey<H> extends never
      ? // Single BranchHandle
          | ((data: BranchData<H>) => any)
            | {
                complete: (data: BranchData<H>) => any;
                failure: (failure: BranchFailureInfo) => any;
              }
      : // Collection BranchHandle
          | ((data: BranchData<H>, innerKey: BranchInnerKey<H>) => any)
            | {
                complete: (
                  data: BranchData<H>,
                  innerKey: BranchInnerKey<H>,
                ) => any;
                failure: (
                  failure: BranchFailureInfo,
                  innerKey: BranchInnerKey<H>,
                ) => any;
              }
    : never;

/**
 * Mirror the map output structure to match the input collection structure.
 * - BranchHandle<T> → ExtractHandlerReturn<C>
 * - BranchHandle<T>[] → ExtractHandlerReturn<C>[]
 * - Map<K, BranchHandle<T>> → Map<K, ExtractHandlerReturn<C>>
 */
type MapOutputFor<H, C> =
  H extends BranchHandle<any>
    ? ExtractHandlerReturn<C> | undefined
    : H extends BranchHandle<any>[]
      ? (ExtractHandlerReturn<C> | undefined)[]
      : H extends Map<infer K, BranchHandle<any>>
        ? Map<K, ExtractHandlerReturn<C> | undefined>
        : never;

// =============================================================================
// forEach / map — HANDLER ENTRY TYPES (CompensationContext)
// =============================================================================

/**
 * A forEach handler entry for CompensationContext.
 * Plain function — receives the branch data directly (already a result union).
 * No `complete`/`failure` split — the result union encodes success/failure.
 */
export type CompensationForEachHandlerEntry<H extends SelectableHandle> =
  H extends BranchHandle<any>
    ? (data: BranchData<H>) => Promise<void> | void
    : H extends BranchHandle<any>[]
      ? (data: BranchData<H>, innerKey: number) => Promise<void> | void
      : H extends Map<infer K, BranchHandle<any>>
        ? (data: BranchData<H>, innerKey: K) => Promise<void> | void
        : never;

/**
 * A map handler entry for CompensationContext.
 * Plain function — receives the branch data directly.
 */
export type CompensationMapHandlerEntry<H extends SelectableHandle> =
  H extends BranchHandle<any>
    ? (data: BranchData<H>) => any
    : H extends BranchHandle<any>[]
      ? (data: BranchData<H>, innerKey: number) => any
      : H extends Map<infer K, BranchHandle<any>>
        ? (data: BranchData<H>, innerKey: K) => any
        : never;

// =============================================================================
// BASE CONTEXT (shared between WorkflowContext and CompensationContext)
// =============================================================================

/**
 * Base context shared between WorkflowContext and CompensationContext.
 * Contains all primitives that are identical between the two contexts.
 */
export interface BaseContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> {
  /** Unique workflow instance ID */
  readonly workflowId: string;

  /** Mutable workflow state (replayed on recovery) */
  readonly state: TState;

  /** Replay-aware logger */
  readonly logger: WorkflowLogger;

  /**
   * Channels for receiving messages.
   * Receive returns z.output<Schema> (decoded).
   */
  readonly channels: {
    [K in keyof TChannels]: ChannelHandle<
      StandardSchemaV1.InferOutput<TChannels[K]>
    >;
  };

  /**
   * Streams for outputting data.
   * Write accepts z.input<Schema> (encoded).
   */
  readonly streams: {
    [K in keyof TStreams]: StreamAccessor<
      StandardSchemaV1.InferInput<TStreams[K]>
    >;
  };

  /**
   * Events for signaling.
   */
  readonly events: {
    [K in keyof TEvents]: EventAccessor;
  };

  /**
   * Patches for safe, incremental workflow evolution.
   */
  readonly patches: {
    [K in keyof TPatches]: PatchAccessor;
  };

  /**
   * Durable sleep.
   * @param seconds - Duration in seconds.
   */
  sleep(seconds: number): Promise<void>;

  /**
   * Deterministic random utilities.
   */
  readonly rng: RngAccessors<TRng>;

  /** Deterministic timestamp (milliseconds since epoch) */
  readonly timestamp: number;
  /** Deterministic Date object */
  readonly date: Date;
}

// =============================================================================
// COMPENSATION CONTEXT
// =============================================================================

/**
 * Context available inside compensation callbacks and hooks (beforeCompensate,
 * afterCompensate).
 *
 * Key differences from WorkflowContext:
 * - Steps return `CompensationStepResult<T>` via `CompensationStepCall<T>` —
 *   compensation code MUST handle failures gracefully.
 * - Has `scope()`, `select()`, `forEach()`, `map()` — same closure-based structured
 *   concurrency but failures are always visible in result types.
 * - `childWorkflows` return `CompensationWorkflowCall<T>` → `WorkflowResult<T>`.
 * - No `addCompensation()` (prevents nested compensation chains).
 * - No `foreignWorkflows` accessor (fire-and-forget not needed in compensation).
 *
 * The engine transparently interleaves compensation callbacks from the same
 * scope via a virtual event loop. Each callback looks like normal sequential
 * code — the engine handles concurrency at durable operation yield points.
 */
export interface CompensationContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> extends BaseContext<TState, TChannels, TStreams, TEvents, TPatches, TRng> {
  /**
   * Steps for durable operations.
   * Calling a step returns `CompensationStepCall<T>` — awaits to `CompensationStepResult<T>`.
   * Must handle failures gracefully — compensation cannot crash.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema
    >
      ? (
          ...args: TArgs
        ) => CompensationStepCall<StandardSchemaV1.InferOutput<TResultSchema>>
      : never;
  };

  /**
   * Child workflows.
   * Calling an accessor returns `CompensationWorkflowCall<T>` — awaits to `WorkflowResult<T>`.
   * Must handle all outcomes (complete, failed, terminated).
   */
  readonly childWorkflows: {
    [K in keyof TWorkflows]: CompensationChildWorkflowAccessor<TWorkflows[K]>;
  };

  // ---------------------------------------------------------------------------
  // scope — structured concurrency in compensation (closure-based)
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency in compensation.
   *
   * Entries are async closures (or collections of closures). The engine runs
   * them on a virtual event loop, interleaving at durable yield points.
   *
   * On scope exit, all running branches are awaited to completion.
   * No per-branch compensation — compensation cannot nest.
   */
  scope<R, E extends ScopeEntries>(
    entries: E,
    callback: (handles: ScopeHandles<E>) => Promise<R>,
  ): Promise<R>;

  // ---------------------------------------------------------------------------
  // select — multiplexed waiting
  // ---------------------------------------------------------------------------

  /**
   * Create a selection for concurrent waiting in compensation.
   */
  select<M extends Record<string, SelectableHandle>>(
    handles: M,
  ): CompensationSelection<M>;

  // ---------------------------------------------------------------------------
  // forEach — process all branch results
  // ---------------------------------------------------------------------------

  /**
   * Process all branch results as they arrive.
   * In compensation context, branches return result unions — handle all outcomes.
   * Every handle must have a callback.
   */
  forEach<M extends Record<string, SelectableHandle>>(
    handles: M,
    callbacks: {
      [K in keyof M & string]: CompensationForEachHandlerEntry<M[K]>;
    },
  ): Promise<void>;

  /**
   * Process all branch results with partial callbacks and a default.
   */
  forEach<
    M extends Record<string, SelectableHandle>,
    C extends Partial<{
      [K in keyof M & string]: CompensationForEachHandlerEntry<M[K]>;
    }>,
  >(
    handles: M,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof M & string, keyof C & string>,
      data: any,
    ) => Promise<void> | void,
  ): Promise<void>;

  // ---------------------------------------------------------------------------
  // map — collect transformed results
  // ---------------------------------------------------------------------------

  /**
   * Collect transformed results from all branch handles.
   * Every handle must have a callback.
   */
  map<
    M extends Record<string, SelectableHandle>,
    C extends {
      [K in keyof M & string]: CompensationMapHandlerEntry<M[K]>;
    },
  >(
    handles: M,
    callbacks: C,
  ): Promise<{
    [K in keyof M & string]: Awaited<ReturnType<C[K] extends (...args: any[]) => any ? C[K] : never>> | undefined;
  }>;

  /**
   * Collect transformed results with partial callbacks and a default.
   */
  map<
    M extends Record<string, SelectableHandle>,
    C extends Partial<{
      [K in keyof M & string]: CompensationMapHandlerEntry<M[K]>;
    }>,
    TDefault,
  >(
    handles: M,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof M & string, keyof C & string>,
      data: any,
    ) => Promise<TDefault> | TDefault,
  ): Promise<{
    [K in keyof M & string]: K extends keyof C
      ? Awaited<ReturnType<C[K] extends (...args: any[]) => any ? C[K] : never>> | undefined
      : Awaited<TDefault> | undefined;
  }>;
}

/**
 * Layer 3 compensation callback type (for addCompensation).
 * Receives CompensationContext — no step result, used for general-purpose cleanup.
 */
export type CompensationCallback<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> = (
  ctx: CompensationContext<
    TState,
    TChannels,
    TStreams,
    TEvents,
    TSteps,
    TWorkflows,
    TPatches,
    TRng
  >,
) => Promise<void>;

// =============================================================================
// WORKFLOW CONTEXT
// =============================================================================

/**
 * Workflow context provided to the execute function.
 *
 * Implements the happy-path model: calling a step or child workflow returns a
 * thenable (`StepCall<T>` or `WorkflowCall<T>`) that resolves to T directly.
 * Failure auto-terminates the workflow and triggers LIFO compensation.
 *
 * Builder pattern for explicit control:
 * - `.compensate(cb)` — register compensation callback
 * - `.retry(policy)` — override retry policy
 * - `.failure(cb)` — handle failure without auto-termination
 * - `.complete(cb)` — transform success result
 *
 * Structured concurrency via `ctx.scope()`: every concurrent branch runs inside
 * a closure. Branches with compensated steps are compensated on scope exit.
 *
 * Dynamic fan-out: scope entries accept collections (arrays, Maps) of closures.
 * `ctx.select()`, `ctx.forEach()`, `ctx.map()` accept HandleGroup collections.
 *
 * Child workflow access is split by semantics:
 * - `ctx.childWorkflows.*` — structured invocation (lifecycle managed, compensation supported)
 * - `ctx.foreignWorkflows.*` — message-only access to existing workflow instances
 */
export interface WorkflowContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> extends BaseContext<TState, TChannels, TStreams, TEvents, TPatches, TRng> {
  /**
   * Steps for durable operations.
   * Calling a step returns a `StepCall<T>` thenable — chain builders before awaiting.
   * Without `.failure()`, failure auto-terminates the workflow.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema
    >
      ? (
          ...args: TArgs
        ) => StepCall<
          StandardSchemaV1.InferOutput<TResultSchema>,
          never,
          false,
          CompensationContext<
            TState,
            TChannels,
            TStreams,
            TEvents,
            TSteps,
            TWorkflows,
            TPatches,
            TRng
          >
        >
      : never;
  };

  /**
   * Child workflow accessors — structured invocation (lifecycle managed by parent).
   * Calling an accessor returns a `WorkflowCall<T>` thenable.
   * Supports `.compensate()`, `.failure()`, `.complete()` (result mode)
   * or `.detached()` (detached mode — mutually exclusive).
   */
  readonly childWorkflows: {
    [K in keyof TWorkflows]: ChildWorkflowAccessor<
      TWorkflows[K],
      CompensationContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TWorkflows,
        TPatches,
        TRng
      >
    >;
  };

  /**
   * Foreign workflow accessors — message-only handles to existing workflow instances.
   * Use `.get(workflowId)` to get a `ForeignWorkflowHandle` with `channels.send()` only.
   * No lifecycle, events, streams, or compensation (prevents tight coupling).
   */
  readonly foreignWorkflows: {
    [K in keyof TWorkflows]: ForeignWorkflowAccessor<TWorkflows[K]>;
  };

  /**
   * Create a selection for concurrent waiting.
   * Pass a record of named handles — use `event.key` to discriminate results.
   *
   * Branch failures crash the workflow by default (happy-path model).
   * Use `.match()` with `{ complete, failure }` handlers for recovery.
   */
  select<M extends Record<string, SelectableHandle>>(handles: M): Selection<M>;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency (closure-based)
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency.
   *
   * Entries are async closures (or collections of closures). The engine runs
   * them on a virtual event loop, interleaving at durable yield points.
   * The callback receives `BranchHandle<T>` values (matching the closure structure)
   * which can be directly awaited or passed into select/forEach/map.
   *
   * Scope exit behavior:
   * - Branches with compensated steps that weren't consumed → compensation runs
   * - Branches without compensation that weren't consumed → awaited, result ignored
   * - On error (callback throws): all unresolved compensated branches are compensated
   *
   * Entries can be single closures or collections:
   * - `flight: async () => T` → callback receives `BranchHandle<T>`
   * - `providers: Array<() => Promise<T>>` → callback receives `BranchHandle<T>[]`
   * - `quotes: Map<K, () => Promise<T>>` → callback receives `Map<K, BranchHandle<T>>`
   */
  scope<R, E extends ScopeEntries>(
    entries: E,
    callback: (handles: ScopeHandles<E>) => Promise<R>,
  ): Promise<R>;

  // ---------------------------------------------------------------------------
  // forEach — process all branch results as they arrive
  // ---------------------------------------------------------------------------

  /**
   * Process all branch results as they arrive.
   * Plain callbacks receive successful data (T) and failure auto-terminates.
   * Use `{ complete, failure }` handlers for explicit failure recovery.
   *
   * Accepts `HandleGroup` inputs: single BranchHandles, arrays, and Maps.
   * For collections, callbacks receive `(data, innerKey)`.
   */
  forEach<M extends Record<string, SelectableHandle>>(
    handles: M,
    callbacks: {
      [K in keyof M & string]: ForEachHandlerEntry<M[K]>;
    },
  ): Promise<void>;

  /**
   * Process branch results with partial callbacks and a default.
   * The default only fires for keys NOT explicitly covered.
   */
  forEach<
    M extends Record<string, SelectableHandle>,
    C extends Partial<{
      [K in keyof M & string]: ForEachHandlerEntry<M[K]>;
    }>,
  >(
    handles: M,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof M & string, keyof C & string>,
      data: any,
    ) => Promise<void> | void,
  ): Promise<void>;

  // ---------------------------------------------------------------------------
  // map — collect transformed results from all branches
  // ---------------------------------------------------------------------------

  /**
   * Collect transformed results from all branch handles.
   * Plain callbacks receive successful data and return a transformed value.
   * Use `{ complete, failure }` handlers for explicit failure recovery.
   *
   * The return type mirrors the input structure:
   * - Single BranchHandle → single value
   * - BranchHandle[] → value[]
   * - Map<K, BranchHandle> → Map<K, value>
   */
  map<
    M extends Record<string, SelectableHandle>,
    C extends {
      [K in keyof M & string]: MapHandlerEntry<M[K]>;
    },
  >(
    handles: M,
    callbacks: C,
  ): Promise<{
    [K in keyof M & string]: MapOutputFor<M[K], C[K]>;
  }>;

  /**
   * Collect transformed results with partial callbacks and a default.
   */
  map<
    M extends Record<string, SelectableHandle>,
    C extends Partial<{
      [K in keyof M & string]: MapHandlerEntry<M[K]>;
    }>,
    TDefault,
  >(
    handles: M,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof M & string, keyof C & string>,
      data: any,
    ) => Promise<TDefault> | TDefault,
  ): Promise<{
    [K in keyof M & string]: K extends keyof C
      ? MapOutputFor<M[K], C[K]>
      : Awaited<TDefault> | undefined;
  }>;

  // ---------------------------------------------------------------------------
  // addCompensation — general purpose LIFO registration
  // ---------------------------------------------------------------------------

  /**
   * Register a general-purpose compensation callback on the LIFO stack.
   *
   * Compensations run in reverse registration order when the workflow fails.
   * The callback receives a CompensationContext (no step result — use for
   * non-step cleanup like sending channel messages, writing to streams, etc.).
   *
   * Not available on CompensationContext (no nesting).
   */
  addCompensation(
    callback: CompensationCallback<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TWorkflows,
      TPatches,
      TRng
    >,
  ): void;
}

// =============================================================================
// ENGINE LEVEL — EXTERNAL HANDLES
// =============================================================================

/**
 * Channel accessor at engine level.
 * T is z.input<Schema> for sending (encoded).
 */
export interface ChannelAccessorExternal<T> {
  /**
   * Send a message to this channel.
   * @param data - Message data (z.input type — encoded).
   * @returns Result indicating success or workflow not found.
   */
  send(data: T): Promise<ChannelSendResult>;
}

/**
 * Event accessor at engine level (with "never" support).
 */
export interface EventAccessorExternal {
  /**
   * Wait for the event to be set.
   * Returns "never" if the workflow finished without setting this event.
   */
  wait(options?: ExternalWaitOptions): Promise<EventWaitResult>;

  /**
   * Check if the event is set (non-blocking).
   */
  isSet(): Promise<EventCheckResult>;
}

/**
 * Lifecycle event accessor at engine level.
 * Uses AbortSignal for runtime wait cancellation.
 */
export interface LifecycleEventAccessorExternal {
  /**
   * Wait for the lifecycle event to be set.
   * Returns "never" if the workflow reached a terminal state without this event firing.
   */
  wait(options?: ExternalWaitOptions): Promise<EventWaitResult>;

  /**
   * Check if the lifecycle event is set (non-blocking).
   */
  get(): Promise<EventCheckResult>;
}

/**
 * All lifecycle events available on an external workflow handle.
 */
export interface LifecycleEventsExternal {
  readonly started: LifecycleEventAccessorExternal;
  readonly sigterm: LifecycleEventAccessorExternal;
  readonly compensating: LifecycleEventAccessorExternal;
  readonly compensated: LifecycleEventAccessorExternal;
  readonly complete: LifecycleEventAccessorExternal;
  readonly failed: LifecycleEventAccessorExternal;
}

/**
 * Stream iterator handle at engine level.
 * Uses AbortSignal for runtime wait cancellation.
 * T is the decoded type (z.output<Schema>).
 */
export interface StreamIteratorHandleExternal<T> {
  /**
   * Read the next record from the stream.
   * @param options - Optional wait options with AbortSignal.
   */
  read(options?: ExternalWaitOptions): Promise<StreamIteratorReadResult<T>>;
}

/**
 * Stream reader at engine level.
 * Uses AbortSignal for runtime wait cancellation.
 * T is the decoded type (z.output<Schema>).
 */
export interface StreamReaderAccessorExternal<T> {
  /**
   * Read a record at the given offset (random access).
   * @param offset - The stream offset to read from.
   * @param options - Optional wait options with AbortSignal.
   */
  read(
    offset: number,
    options?: ExternalWaitOptions,
  ): Promise<StreamReadResult<T>>;

  /**
   * Create an iterator starting at the given offset.
   * @param startOffset - Start reading from this offset (default: 0).
   * @param endOffset - Stop reading at this offset (inclusive, default: unbounded).
   */
  iterator(
    startOffset?: number,
    endOffset?: number,
  ): StreamIteratorHandleExternal<T>;

  /**
   * Check if the stream is still open.
   */
  isOpen(): Promise<StreamOpenResult>;
}

/**
 * Handle to a workflow from engine level.
 * Full access to all public APIs: channels, streams, events, lifecycle, signals.
 *
 * Engine-level handles retain `sigterm()` and `sigkill()` — these are
 * operational concerns for engine callers. Workflow code uses scopes instead.
 */
export interface WorkflowHandleExternal<
  TResult,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
> {
  readonly workflowId: string;

  /**
   * Channels for sending messages.
   * Send accepts z.input<Schema> (encoded).
   */
  readonly channels: {
    [K in keyof TChannels]: ChannelAccessorExternal<
      StandardSchemaV1.InferInput<TChannels[K]>
    >;
  };

  /**
   * Streams for reading data.
   * Read returns z.output<Schema> (decoded).
   */
  readonly streams: {
    [K in keyof TStreams]: StreamReaderAccessorExternal<
      StandardSchemaV1.InferOutput<TStreams[K]>
    >;
  };

  /**
   * User-defined events.
   */
  readonly events: {
    [K in keyof TEvents]: EventAccessorExternal;
  };

  /**
   * Engine-managed lifecycle events.
   */
  readonly lifecycle: LifecycleEventsExternal;

  /**
   * Wait for workflow to complete and get result.
   */
  getResult(
    options?: ExternalWaitOptions,
  ): Promise<WorkflowResultExternal<TResult>>;

  /**
   * Send SIGTERM — graceful shutdown with compensation.
   */
  sigterm(): Promise<SignalResult>;

  /**
   * Send SIGKILL — immediate shutdown without compensation or hooks.
   */
  sigkill(): Promise<SignalResult>;

  /**
   * Update the retention policy for this workflow instance.
   */
  setRetention(retention: number | Partial<RetentionSettings>): Promise<void>;
}

// =============================================================================
// RETENTION
// =============================================================================

/**
 * Retention settings for workflow garbage collection.
 * Specifies how long workflows should be kept in the database after reaching
 * terminal states. All durations are in seconds. null means never delete.
 */
export interface RetentionSettings {
  /** Retention period for completed workflows (seconds) */
  readonly complete: number | null;
  /** Retention period for failed workflows (seconds) */
  readonly failed: number | null;
  /** Retention period for terminated workflows (seconds) */
  readonly terminated: number | null;
}

// =============================================================================
// STATE FACTORY
// =============================================================================

/**
 * State factory type for a workflow.
 *
 * Provides the initial state for each workflow instance.
 * State is NOT persisted to the database — it is derived from replay.
 *
 * The factory receives a limited context with only deterministic utilities.
 */
export type StateFactory<
  TState,
  TRng extends RngDefinitions = Record<string, never>,
> = (ctx: { rng: RngAccessors<TRng> }) => TState;

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

/**
 * Workflow definition — the blueprint for workflow instances.
 *
 * Workflows are durable, long-running processes that survive restarts via replay.
 * They communicate via channels, output data via streams, signal milestones via
 * events, and execute durable operations via steps.
 *
 * **Callable thenable model:** Steps and child workflows are called directly and
 * return thenables (`StepCall<T>`, `WorkflowCall<T>`) that can be awaited
 * immediately or chained with builder methods before awaiting.
 *
 * **Compensation:** Register per-step/workflow via `.compensate(cb)` builder.
 * `addCompensation(cb)` provides general-purpose cleanup. Runs LIFO on failure.
 *
 * **Structured concurrency:** All concurrent branches run as closures inside
 * `ctx.scope()`. Collections (Array, Map) are supported for dynamic fan-out.
 */
export interface WorkflowDefinition<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TWorkflows extends WorkflowDefinitions,
  TResultSchema extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TArgs extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> {
  /** Unique workflow name */
  readonly name: string;

  /** State factory — provides initial state for each workflow instance */
  readonly state?: StateFactory<TState, TRng>;

  /** Channel definitions */
  readonly channels?: TChannels;

  /** Stream definitions */
  readonly streams?: TStreams;

  /** Event definitions */
  readonly events?: TEvents;

  /** Step definitions */
  readonly steps?: TSteps;

  /** Child workflow definitions */
  readonly workflows?: TWorkflows;

  /**
   * Patch definitions for safe workflow evolution.
   *
   * - `true`: Active — new workflows will execute the patched code path.
   * - `false`: Deprecated — new workflows skip the patch, but replaying workflows
   *   that already entered it will still run it.
   */
  readonly patches?: TPatches;

  /**
   * RNG definitions for deterministic randomness.
   *
   * - `true`: Simple named RNG stream — accessed as `ctx.rng.name`.
   * - Function: Parametrized RNG stream — accessed as `ctx.rng.name(...args)`.
   */
  readonly rng?: TRng;

  /** Result schema for encoding/decoding workflow result */
  readonly result?: TResultSchema;

  /** Arguments schema (optional) */
  readonly args?: StandardSchemaV1<unknown, unknown>;

  /**
   * Workflow retention policy for garbage collection.
   *
   * - If a number: Same retention for all terminal states (seconds).
   * - If RetentionSettings: Different retention per terminal state (seconds).
   * - If undefined: Workflows are never garbage collected.
   */
  readonly retention?: number | RetentionSettings;

  /**
   * Called before compensations run.
   * Receives CompensationContext — has full structured concurrency capabilities.
   */
  readonly beforeCompensate?: (params: {
    ctx: CompensationContext<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TWorkflows,
      TPatches,
      TRng
    >;
    args: StandardSchemaV1.InferOutput<TArgs>;
  }) => Promise<void>;

  /**
   * Called after all compensations have run.
   * Receives CompensationContext — has full structured concurrency capabilities.
   */
  readonly afterCompensate?: (params: {
    ctx: CompensationContext<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TWorkflows,
      TPatches,
      TRng
    >;
    args: StandardSchemaV1.InferOutput<TArgs>;
  }) => Promise<void>;

  /**
   * Workflow execution function.
   * Must return z.input<ResultSchema> (encoded for DB).
   * Throwing an exception fails the workflow and triggers compensation.
   */
  execute(
    ctx: WorkflowContext<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TWorkflows,
      TPatches,
      TRng
    >,
    args: StandardSchemaV1.InferOutput<TArgs>,
  ): Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}

// =============================================================================
// START WORKFLOW OPTIONS (ENGINE LEVEL)
// =============================================================================

/**
 * Options for starting a workflow at engine level.
 */
export interface StartWorkflowOptions<TArgsInput> {
  /** Unique workflow instance ID */
  workflowId: string;
  /** Timeout in seconds */
  timeoutSeconds?: number;
  /** Workflow arguments — must be z.input<ArgSchema> (encoded) */
  args?: TArgsInput;
  /**
   * Override retention policy for this workflow instance.
   */
  retention?: number | RetentionSettings;
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract result type from workflow definition (decoded — z.output).
 */
export type InferWorkflowResult<W> =
  W extends WorkflowDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    infer TResultSchema,
    any,
    any,
    any
  >
    ? StandardSchemaV1.InferOutput<TResultSchema>
    : never;

/**
 * Extract channels from workflow definition.
 */
export type InferWorkflowChannels<W> =
  W extends WorkflowDefinition<
    any,
    infer TChannels,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >
    ? TChannels
    : never;

/**
 * Extract streams from workflow definition.
 */
export type InferWorkflowStreams<W> =
  W extends WorkflowDefinition<
    any,
    any,
    infer TStreams,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >
    ? TStreams
    : never;

/**
 * Extract events from workflow definition.
 */
export type InferWorkflowEvents<W> =
  W extends WorkflowDefinition<
    any,
    any,
    any,
    infer TEvents,
    any,
    any,
    any,
    any,
    any,
    any
  >
    ? TEvents
    : never;

/**
 * Extract args schema from workflow definition (decoded — z.output).
 */
export type InferWorkflowArgs<W> =
  W extends WorkflowDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    infer TArgs,
    any,
    any
  >
    ? TArgs
    : void;

/**
 * Extract arg input type from workflow definition (encoded — z.input).
 * Used for StartWorkflowOptions.args.
 */
export type InferWorkflowArgsInput<W> = W extends {
  args?: infer TArgSchema;
}
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TArgSchema>
    : void
  : void;

/**
 * Extract state type from workflow definition.
 */
export type InferWorkflowState<W> =
  W extends WorkflowDefinition<
    infer TState,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >
    ? TState
    : never;
