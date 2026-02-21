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
 *   await ctx.steps.sendLegacyEmail.execute(...);
 * }
 * ```
 *
 * **Callback form** — runs the callback if active, returns default otherwise.
 * Use for adding new code paths (90% of the time):
 * ```typescript
 * const result = await ctx.patches.antifraud(async () => {
 *   return await ctx.steps.fraudCheck.execute(flightId);
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
// RESULT TYPES — STEP JOIN (TIMEOUT OVERLOADS)
// =============================================================================

/**
 * Result of step join with timeout.
 * Timeout is an expected outcome (not a failure), so there's no `ok` field.
 * Used when `.join(timeoutSeconds)` is called on a StepHandle.
 */
export type StepJoinResultWithTimeout<T> =
  | { status: "complete"; data: T }
  | { status: "timeout" };

/**
 * Result of child workflow join with timeout.
 * Timeout is an expected outcome (not a failure), so there's no `ok` field.
 * Used when `.join(timeoutSeconds)` is called on a ChildWorkflowHandle.
 */
export type ChildWorkflowJoinResultWithTimeout<T> =
  | { status: "complete"; data: T }
  | { status: "timeout" };

/**
 * Result of step join with timeout in CompensationContext.
 * Includes all CompensationStepResult outcomes plus timeout.
 */
export type CompensationStepJoinResultWithTimeout<T> =
  | CompensationStepResult<T>
  | { ok: false; status: "timeout" };

/**
 * Result of child workflow join with timeout in CompensationContext.
 * Includes all WorkflowResult outcomes plus timeout.
 */
export type CompensationChildWorkflowJoinResultWithTimeout<T> =
  | WorkflowResult<T>
  | { ok: false; status: "timeout" };

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
// RESULT TYPES — CHANNELS, STREAMS, EVENTS (unchanged)
// =============================================================================

/**
 * Result of receiving a message from a channel (workflow level).
 */
export type ChannelReceiveResult<T> =
  | { ok: true; status: "received"; data: T }
  | { ok: false; status: "timeout" };

/**
 * @deprecated Use T directly — channel receive without timeout returns
 * the decoded value directly since there is no discriminated union.
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
// RUNTIME OPTIONS (BLOCKING PRIMITIVES)
// =============================================================================
//
// Runtime options control suspension behavior at blocking points. Suspension
// evicts the workflow from memory; when the wait condition is satisfied, the
// workflow is replayed from the execution log to resume.
//
// Suspension is only available on primitives whose wait condition can be fully
// described as a single database-level predicate with no in-process
// dependencies:
//   - ctx.sleep()                      — timer expiry
//   - ctx.channels.[name].receive()    — message arrival on a channel
//   - streamIterator.read()            — record written at a stream offset
//   - childWorkflowHandle.join()       — child workflow reaches terminal state
//
// NOT available on:
//   - stepHandle.join()                — steps execute in-process
//   - select.next() / select.match()   — select holds live handle references
// =============================================================================

/**
 * Runtime options for `ctx.sleep()`.
 */
export interface SleepRuntimeOptions {
  /**
   * If true, the workflow is suspended (evicted from memory) for the duration
   * of the sleep. When the timer fires, the workflow is replayed from the
   * execution log to resume.
   *
   * @default false (workflow stays in memory)
   */
  suspend?: boolean;
}

/**
 * Runtime options for `ctx.channels.[name].receive()`.
 */
export interface ChannelReceiveRuntimeOptions {
  /**
   * Controls when the workflow is suspended while waiting for a message.
   *
   * - `"never"` — Never suspend. The workflow stays in memory for the entire
   *   wait. This is the default.
   * - `0` — Suspend immediately. The workflow is evicted as soon as the
   *   receive call blocks.
   * - `number > 0` — Stay in memory for N seconds (the "hot window"), then
   *   suspend if no message has arrived. Use this when the message is likely
   *   to arrive quickly on the hot path but has a long tail timeout.
   *
   * @example
   * ```typescript
   * // Decision timeout is 3 days, but usually arrives within minutes.
   * // Stay hot for 10 minutes. If still waiting after that, suspend.
   * const decision = await ctx.channels.approval.receive(86400 * 3, {
   *   suspendAfter: 600,
   * });
   * ```
   *
   * @default "never"
   */
  suspendAfter?: "never" | 0 | number;
}

/**
 * Runtime options for `streamIterator.read()`.
 */
export interface StreamIteratorReadRuntimeOptions {
  /**
   * Controls when the workflow is suspended while waiting for a stream record.
   *
   * - `"never"` — Never suspend. The workflow stays in memory for the entire
   *   wait. This is the default.
   * - `0` — Suspend immediately. The workflow is evicted as soon as the
   *   read call blocks.
   * - `number > 0` — Stay in memory for N seconds, then suspend if no record
   *   has arrived at the current offset.
   *
   * @default "never"
   */
  suspendAfter?: "never" | 0 | number;
}

/**
 * Runtime options for `childWorkflowHandle.join()`.
 */
export interface ChildWorkflowJoinRuntimeOptions {
  /**
   * Controls when the parent workflow is suspended while waiting for the
   * child workflow to reach a terminal state.
   *
   * - `"never"` — Never suspend. The parent stays in memory for the entire
   *   wait. This is the default.
   * - `0` — Suspend immediately. The parent is evicted as soon as the join
   *   call blocks. Use when the child is expected to be long-running.
   * - `number > 0` — Stay in memory for N seconds (in case the child
   *   finishes quickly), then suspend if the child is still running.
   *
   * @default "never"
   */
  suspendAfter?: "never" | 0 | number;
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
// FAILURE INFO TYPES (for onFailure handlers)
// =============================================================================

/**
 * Failure information for a step, passed to `onFailure` handlers on
 * concurrency primitives (match, forEach, map).
 */
export interface StepFailureInfo {
  readonly reason: "attempts_exhausted" | "timeout";
  readonly errors: StepErrorAccessor;
}

/**
 * Failure information for a child workflow, passed to `onFailure` handlers.
 * Discriminated union — the child may have failed (threw an error) or been
 * terminated externally by an administrator.
 */
export type ChildWorkflowFailureInfo =
  | { readonly status: "failed"; readonly error: WorkflowExecutionError }
  | { readonly status: "terminated" };

/**
 * Augment a failure info type with a `compensate()` handle.
 *
 * `compensate()` invokes the compensation callback defined at `.start()` or
 * `.execute()` / `.tryExecute()` time. Calling it explicitly discharges the
 * SAGA obligation for this handle — the engine will NOT run the compensation
 * again at scope exit.
 *
 * **Context switch:** Calling `compensate()` transparently switches the
 * execution context to compensation mode (SIGTERM-resilient). The compensation
 * callback runs to completion even if SIGTERM arrives mid-execution. Control
 * returns to the `onFailure` handler in normal WorkflowContext after.
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
 * Extract the failure info type for a handle.
 * Steps get StepFailureInfo, child workflows get ChildWorkflowFailureInfo.
 */
export type HandleFailureInfo<H> =
  H extends StepHandle<any, any>
    ? StepFailureInfo
    : H extends ChildWorkflowHandle<any, any, any, any, any>
      ? ChildWorkflowFailureInfo
      : never;

/**
 * Extract the `onFailure` callback parameter type for a handle.
 *
 * If the handle has `HasCompensation = true`, the failure info is augmented
 * with `compensate()`. Otherwise, it's plain failure info.
 *
 * This type is used by `tryJoin()`, `match()`, `forEach()`, and `map()` to
 * provide a unified single-parameter `onFailure` callback.
 */
export type HandleOnFailureParam<H> =
  H extends StepHandle<any, true> | ChildWorkflowHandle<any, any, any, any, true>
    ? WithCompensation<HandleFailureInfo<H>>
    : HandleFailureInfo<H>;

// =============================================================================
// STEP OPTIONS (unified for .execute() and .start())
// =============================================================================

/**
 * Options for step `.execute()` and `.start()` in WorkflowContext.
 *
 * Each handle has exactly one compensation callback, defined here.
 * No override mechanics — this is the only place compensation is specified.
 *
 * @typeParam T - The decoded step result type.
 * @typeParam TCompCtx - The CompensationContext type for this workflow.
 */
export interface StepOptions<T, TCompCtx> {
  /** Override the step's default retry policy */
  retryPolicy?: RetryPolicyOptions;
  /**
   * Compensation callback — runs during LIFO unwinding when the workflow fails.
   * Receives the step's outcome (complete, failed, or terminated) so the
   * callback can decide what to undo.
   *
   * Also invocable explicitly via `tools.compensate()` in `onFailure` handlers.
   * When invoked explicitly, the context switches to compensation mode
   * (SIGTERM-resilient) — the callback runs to completion.
   */
  compensate?: (
    ctx: TCompCtx,
    result: StepCompensationResult<T>,
  ) => Promise<void>;
}

/**
 * Step options with `compensate` required.
 * Used for overload resolution — when `compensate` is present, return types
 * include `compensate()` handles and `HasCompensation` is `true`.
 */
export interface StepOptionsWithCompensation<T, TCompCtx> {
  retryPolicy?: RetryPolicyOptions;
  compensate: (
    ctx: TCompCtx,
    result: StepCompensationResult<T>,
  ) => Promise<void>;
}

/**
 * Step options without `compensate`.
 * Used for overload resolution — explicitly forbids `compensate` so TypeScript
 * selects the correct overload.
 */
export interface StepOptionsWithoutCompensation {
  retryPolicy?: RetryPolicyOptions;
  compensate?: never;
}

// =============================================================================
// CHILD WORKFLOW START & JOIN OPTIONS
// =============================================================================

/**
 * Options for starting a child workflow from within a workflow context.
 */
export interface StartChildWorkflowOptions<TArgsInput> {
  /** Unique workflow instance ID for the child */
  workflowId: string;
  /** Timeout in seconds for the child workflow */
  timeoutSeconds?: number;
  /** Workflow arguments — must be z.input<ArgSchema> */
  args?: TArgsInput;
}

/**
 * Scope start options for a child workflow.
 * Optionally includes a compensation callback. No unjoined strategy —
 * the presence of `compensate` determines scope exit behavior.
 */
export interface ChildWorkflowScopeStartOptions<
  TArgsInput,
  TResult,
  TCompCtx,
> extends StartChildWorkflowOptions<TArgsInput> {
  /**
   * Compensation callback — runs during LIFO unwinding.
   * If present, scope exit compensates unjoined handles.
   * If absent, scope exit settles (waits for completion, ignores result).
   */
  compensate?: (
    ctx: TCompCtx,
    result: ChildWorkflowCompensationResult<TResult>,
  ) => Promise<void>;
}

/**
 * Scope start options with `compensate` required.
 * Used for overload resolution — produces `ChildWorkflowHandle<..., true>`.
 */
export interface ChildWorkflowScopeStartOptionsWithCompensation<
  TArgsInput,
  TResult,
  TCompCtx,
> extends StartChildWorkflowOptions<TArgsInput> {
  compensate: (
    ctx: TCompCtx,
    result: ChildWorkflowCompensationResult<TResult>,
  ) => Promise<void>;
}

/**
 * Scope start options without `compensate`.
 * Used for overload resolution — produces `ChildWorkflowHandle<..., false>`.
 */
export interface ChildWorkflowScopeStartOptionsWithoutCompensation<
  TArgsInput,
> extends StartChildWorkflowOptions<TArgsInput> {
  compensate?: never;
}

/**
 * Options for child workflow `.execute()` in WorkflowContext.
 * Combines start options, runtime options, and compensation.
 */
export interface RunChildWorkflowOptions<TArgsInput, TResult, TCompCtx>
  extends StartChildWorkflowOptions<TArgsInput>,
    ChildWorkflowJoinRuntimeOptions {
  /**
   * Compensation callback — runs during LIFO unwinding.
   */
  compensate?: (
    ctx: TCompCtx,
    result: ChildWorkflowCompensationResult<TResult>,
  ) => Promise<void>;
}

/**
 * Options for `.join()` on a ChildWorkflowHandle.
 * Runtime options only — no compensation (defined at start time).
 */
export type ChildWorkflowJoinOptions = ChildWorkflowJoinRuntimeOptions;

// =============================================================================
// TRY OPTIONS — CALLBACK-BASED EXPLICIT ERROR HANDLING
// =============================================================================

// --- Steps -------------------------------------------------------------------

/**
 * Options for `tryExecute()` on a step WITH a `compensate` callback.
 *
 * The `onFailure` handler receives `tools` with `compensate()` for eager
 * discharge. If `compensate()` is not called within `onFailure`, the engine
 * runs it at scope exit / LIFO unwinding (safe default).
 *
 * Two type parameters allow `onComplete` and `onFailure` to return different
 * types (including async vs sync). The return type is `Awaited<R1> | Awaited<R2>`.
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 * @typeParam R1 - Return type of `onComplete`.
 * @typeParam R2 - Return type of `onFailure`.
 * @typeParam TCompCtx - The CompensationContext type for this workflow.
 */
export interface StepTryOptionsWithCompensation<T, R1, R2, TCompCtx> {
  retryPolicy?: RetryPolicyOptions;
  compensate: (
    ctx: TCompCtx,
    result: StepCompensationResult<T>,
  ) => Promise<void>;
  onComplete: (data: T) => R1;
  onFailure: (failure: WithCompensation<StepFailureInfo>) => R2;
}

/**
 * Options for `tryExecute()` on a step WITHOUT a `compensate` callback.
 *
 * The `onFailure` handler does NOT receive `tools` — there is no compensation
 * to discharge. Full type safety: `tools.compensate()` is not callable.
 *
 * @typeParam T - Decoded step result type.
 * @typeParam R1 - Return type of `onComplete`.
 * @typeParam R2 - Return type of `onFailure`.
 */
export interface StepTryOptionsWithoutCompensation<T, R1, R2> {
  retryPolicy?: RetryPolicyOptions;
  compensate?: never;
  onComplete: (data: T) => R1;
  onFailure: (failure: StepFailureInfo) => R2;
}

// --- Child workflows ---------------------------------------------------------

/**
 * Options for `tryExecute()` on a child workflow WITH a `compensate` callback.
 *
 * Same callback model as step try options. `onFailure` receives
 * `ChildWorkflowFailureInfo` (discriminated: "failed" | "terminated").
 *
 * @typeParam TArgsInput - Workflow argument input type.
 * @typeParam TResult - Decoded workflow result type.
 * @typeParam R1 - Return type of `onComplete`.
 * @typeParam R2 - Return type of `onFailure`.
 * @typeParam TCompCtx - The CompensationContext type for this workflow.
 */
export interface ChildWorkflowTryExecuteOptionsWithCompensation<
  TArgsInput,
  TResult,
  R1,
  R2,
  TCompCtx,
> extends StartChildWorkflowOptions<TArgsInput>,
    ChildWorkflowJoinRuntimeOptions {
  compensate: (
    ctx: TCompCtx,
    result: ChildWorkflowCompensationResult<TResult>,
  ) => Promise<void>;
  onComplete: (data: TResult) => R1;
  onFailure: (failure: WithCompensation<ChildWorkflowFailureInfo>) => R2;
}

/**
 * Options for `tryExecute()` on a child workflow WITHOUT a `compensate` callback.
 *
 * `onFailure` receives plain `ChildWorkflowFailureInfo` — no `compensate()`.
 *
 * @typeParam TArgsInput - Workflow argument input type.
 * @typeParam TResult - Decoded workflow result type.
 * @typeParam R1 - Return type of `onComplete`.
 * @typeParam R2 - Return type of `onFailure`.
 */
export interface ChildWorkflowTryExecuteOptionsWithoutCompensation<
  TArgsInput,
  TResult,
  R1,
  R2,
> extends StartChildWorkflowOptions<TArgsInput>,
    ChildWorkflowJoinRuntimeOptions {
  compensate?: never;
  onComplete: (data: TResult) => R1;
  onFailure: (failure: ChildWorkflowFailureInfo) => R2;
}

// =============================================================================
// SCOPE TYPES
// =============================================================================

/** @internal Brand symbol for ScopeEntry type safety */
declare const scopeEntryBrand: unique symbol;

/**
 * A branded promise representing a pending handle creation within a scope.
 *
 * ScopeEntry can only be produced by `.start()` on step objects or workflow
 * accessors, and can only be consumed by `ctx.scope()`. This enforces that
 * every concurrent handle has a declared lifecycle boundary.
 *
 * At runtime, a ScopeEntry is just a Promise. The brand exists only at the
 * type level for enforcement.
 */
export type ScopeEntry<H> = Promise<H> & {
  readonly [scopeEntryBrand]: true;
};

/**
 * Extract the handle type from a ScopeEntry.
 */
export type InferScopeHandle<E> = E extends ScopeEntry<infer H> ? H : never;

// =============================================================================
// STEP HANDLE (WorkflowContext)
// =============================================================================

/**
 * Handle to a started step execution.
 * Created via `.start()` inside a scope declaration. Used to join or pass into
 * select, forEach, map.
 *
 * Steps are function calls, not processes — they have no lifecycle control.
 * They run to completion based on their retry policy and timeout. The
 * `signal: AbortSignal` in the step's execute function is only aborted by
 * workflow-level SIGTERM/SIGKILL.
 *
 * In the happy-path model, `.join()` returns T directly. If the step fails,
 * the workflow is automatically terminated and compensations run.
 *
 * `.tryJoin()` accepts `{ onComplete, onFailure }` callbacks for explicit
 * error handling without auto-terminating. `onFailure` receives a single
 * failure info object — with `compensate()` merged in when compensation
 * was registered at `.start()` time.
 *
 * @typeParam T - The decoded step result type (z.output<Schema>).
 * @typeParam HasCompensation - Whether a `compensate` callback was registered
 *   at `.start()` time. Controls whether `onFailure`'s parameter includes
 *   `compensate()`.
 */
export interface StepHandle<T, HasCompensation extends boolean = false> {
  /**
   * Wait for the step to complete and return its result directly.
   * If the step fails, the workflow auto-terminates and compensations run.
   */
  join(): Promise<T>;

  /**
   * Wait for the step with a timeout (in seconds).
   * Returns a discriminated union since timeout is an expected outcome.
   * The step continues running — timeout does NOT cancel or fail it.
   *
   * @param timeoutSeconds - Timeout in seconds.
   */
  join(timeoutSeconds: number): Promise<StepJoinResultWithTimeout<T>>;

  /**
   * Wait for the step and handle the result via callbacks.
   * The workflow does NOT auto-terminate on failure — the developer handles
   * both outcomes explicitly.
   *
   * `onFailure` receives a single object with failure info. If the handle
   * was started with `compensate`, the object includes `compensate()` for
   * eager discharge. If not called, the engine runs compensation at scope
   * exit (safe default).
   *
   * Returns the value produced by whichever callback fires.
   */
  tryJoin<R1, R2>(
    options: {
      onComplete: (data: T) => R1;
      onFailure: (
        failure: HasCompensation extends true
          ? WithCompensation<StepFailureInfo>
          : StepFailureInfo,
      ) => R2;
    },
  ): Promise<Awaited<R1> | Awaited<R2>>;

  /**
   * Wait for the step with a timeout and handle all outcomes via callbacks.
   * Adds `onTimeout` for the timeout case — the step continues running.
   *
   * @param timeoutSeconds - Timeout in seconds.
   */
  tryJoin<R1, R2, R3>(
    timeoutSeconds: number,
    options: {
      onComplete: (data: T) => R1;
      onFailure: (
        failure: HasCompensation extends true
          ? WithCompensation<StepFailureInfo>
          : StepFailureInfo,
      ) => R2;
      onTimeout: () => R3;
    },
  ): Promise<Awaited<R1> | Awaited<R2> | Awaited<R3>>;
}

// =============================================================================
// COMPENSATION STEP HANDLE (CompensationContext)
// =============================================================================

/**
 * Handle to a started step execution in CompensationContext.
 * Created via `.start()` inside a compensation scope. Returns Go-style
 * result unions — compensation code must handle failures explicitly.
 *
 * @typeParam T - The decoded step result type.
 */
export interface CompensationStepHandle<T> {
  /**
   * Wait for the step to complete. Returns a result union with `ok` —
   * compensation code must check the result.
   */
  join(): Promise<CompensationStepResult<T>>;

  /**
   * Wait for the step with a timeout (in seconds).
   * Adds `{ ok: false, status: "timeout" }` to the result union.
   */
  join(
    timeoutSeconds: number,
  ): Promise<CompensationStepJoinResultWithTimeout<T>>;
}

// =============================================================================
// STEP OBJECTS (CONTEXT-SPECIFIC)
// =============================================================================

/**
 * Step object on `ctx.steps` in WorkflowContext.
 *
 * - `.execute()` returns T directly (happy path). Failure auto-terminates the workflow.
 * - `.tryExecute()` accepts `{ onComplete, onFailure }` callbacks for explicit
 *   error handling. With `compensate` → `onFailure` includes `compensate()`. Returns R.
 * - `.start()` returns a ScopeEntry — can only be used inside `ctx.scope()`.
 *   With `compensate` → `StepHandle<T, true>`.
 *   Without → `StepHandle<T, false>`.
 *
 * @typeParam TArgs - Step argument types.
 * @typeParam T - Decoded step result type (z.output<Schema>).
 * @typeParam TCompCtx - The CompensationContext type for this workflow.
 */
export interface WorkflowStepObject<
  TArgs extends unknown[],
  T,
  TCompCtx,
> {
  // --- execute (happy path) --------------------------------------------------

  /**
   * Run the step sequentially — start and immediately join.
   * Returns T directly. If the step fails, the workflow auto-terminates.
   */
  execute(...args: TArgs): Promise<T>;

  /**
   * Run the step with options (retry policy override and/or compensation).
   * Returns T directly.
   */
  execute(
    ...args: [...TArgs, options: StepOptions<T, TCompCtx>]
  ): Promise<T>;

  // --- tryExecute (explicit error handling, callback-based) ------------------

  /**
   * Run the step with compensation and handle the result via callbacks.
   * `onFailure` receives failure info with `compensate()` for eager discharge.
   * If `compensate()` is not called, the engine runs it at scope exit.
   *
   * Returns the value produced by whichever callback fires.
   */
  tryExecute<R1, R2>(
    ...args: [
      ...TArgs,
      options: StepTryOptionsWithCompensation<T, R1, R2, TCompCtx>,
    ]
  ): Promise<Awaited<R1> | Awaited<R2>>;

  /**
   * Run the step without compensation and handle the result via callbacks.
   * `onFailure` receives plain failure info — no `compensate()`.
   *
   * Returns the value produced by whichever callback fires.
   */
  tryExecute<R1, R2>(
    ...args: [
      ...TArgs,
      options: StepTryOptionsWithoutCompensation<T, R1, R2>,
    ]
  ): Promise<Awaited<R1> | Awaited<R2>>;

  // --- start (scope-only, concurrent) ----------------------------------------

  /**
   * Start the step with compensation within a scope declaration.
   * Returns a `ScopeEntry<StepHandle<T, true>>` — `tryJoin()`'s `onFailure`
   * will include `compensate()` on the failure object.
   *
   * Unjoined handles with `compensate` are compensated on scope exit.
   */
  start(
    ...args: [
      ...TArgs,
      options: StepOptionsWithCompensation<T, TCompCtx>,
    ]
  ): ScopeEntry<StepHandle<T, true>>;

  /**
   * Start the step concurrently within a scope declaration (no compensation).
   * Returns a `ScopeEntry<StepHandle<T, false>>`.
   *
   * Unjoined handles without `compensate` are settled on scope exit
   * (waited for, result ignored).
   */
  start(...args: TArgs): ScopeEntry<StepHandle<T, false>>;

  /**
   * Start the step with a retry policy override (no compensation).
   */
  start(
    ...args: [
      ...TArgs,
      options: StepOptionsWithoutCompensation,
    ]
  ): ScopeEntry<StepHandle<T, false>>;
}

/**
 * Step object on `ctx.steps` in CompensationContext.
 *
 * - `.execute()` returns CompensationStepResult<T> — compensation code MUST
 *   handle failures gracefully (can't crash the compensation chain).
 * - `.start()` returns a ScopeEntry for use inside `compCtx.scope()`.
 *
 * @typeParam TArgs - Step argument types.
 * @typeParam T - Decoded step result type (z.output<Schema>).
 */
export interface CompensationStepObject<TArgs extends unknown[], T> {
  /**
   * Execute the step sequentially. Returns a result with `ok` for explicit
   * error handling — compensation must not crash.
   */
  execute(...args: TArgs): Promise<CompensationStepResult<T>>;

  /**
   * Execute the step with a retry policy override.
   */
  execute(
    ...args: [...TArgs, options: { retryPolicy?: RetryPolicyOptions }]
  ): Promise<CompensationStepResult<T>>;

  /**
   * Start the step concurrently within a compensation scope.
   * Returns a ScopeEntry that resolves into a CompensationStepHandle.
   */
  start(...args: TArgs): ScopeEntry<CompensationStepHandle<T>>;

  /**
   * Start the step with a retry policy override within a compensation scope.
   */
  start(
    ...args: [...TArgs, options: { retryPolicy?: RetryPolicyOptions }]
  ): ScopeEntry<CompensationStepHandle<T>>;
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
   * Blocks until a message arrives. Returns the decoded value directly —
   * there is no discriminated union since the only possible outcome is
   * receiving a message.
   *
   * @param options - Optional runtime options controlling suspension behavior.
   * @returns Decoded message (z.output type).
   */
  receive(options?: ChannelReceiveRuntimeOptions): Promise<T>;

  /**
   * Receive a message from this channel with a timeout (in seconds).
   * Returns { ok: false, status: 'timeout' } if no message arrives within
   * the timeout.
   * @param timeoutSeconds - Timeout in seconds.
   * @param options - Optional runtime options controlling suspension behavior.
   * @returns Decoded message or timeout result.
   */
  receive(
    timeoutSeconds: number,
    options?: ChannelReceiveRuntimeOptions,
  ): Promise<ChannelReceiveResult<T>>;
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
   * Returns { ok: false, status: 'timeout' } if the event is not set within
   * the timeout.
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
   * Returns { ok: false, status: 'timeout' } if the event is not set within
   * the timeout.
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
// STREAM ITERATOR & READER
// =============================================================================

/**
 * Stream iterator handle — reads records from a stream sequentially.
 * Can be passed into select for multiplexed reading.
 * T is the decoded type (z.output<Schema>).
 */
export interface StreamIteratorHandle<T> {
  /**
   * Read the next record from the stream.
   * Blocks until a record is available or the stream is closed.
   * @param options - Optional runtime options controlling suspension behavior.
   */
  read(
    options?: StreamIteratorReadRuntimeOptions,
  ): Promise<StreamIteratorReadResultNoTimeout<T>>;

  /**
   * Read the next record from the stream with a timeout (in seconds).
   * Returns { ok: false, status: 'timeout' } if no record arrives within
   * the timeout.
   * @param timeoutSeconds - Timeout in seconds.
   * @param options - Optional runtime options controlling suspension behavior.
   */
  read(
    timeoutSeconds: number,
    options?: StreamIteratorReadRuntimeOptions,
  ): Promise<StreamIteratorReadResult<T>>;
}

/**
 * Stream reader on a child workflow handle (workflow-internal).
 * Timeouts are durable execution concerns — specified as seconds.
 * T is the decoded type (z.output<Schema>).
 */
export interface StreamReaderAccessor<T> {
  /**
   * Read a record at the given offset (random access).
   * Blocks until the record is available, the stream is closed, or the
   * workflow is not found.
   * @param offset - The stream offset to read from.
   */
  read(offset: number): Promise<StreamReadResultNoTimeout<T>>;

  /**
   * Read a record at the given offset with a timeout (in seconds).
   * Returns { ok: false, status: 'timeout' } if the record is not available
   * within the timeout.
   * @param offset - The stream offset to read from.
   * @param timeoutSeconds - Timeout in seconds.
   */
  read(offset: number, timeoutSeconds: number): Promise<StreamReadResult<T>>;

  /**
   * Create an iterator starting at the given offset.
   * @param startOffset - Start reading from this offset (default: 0).
   * @param endOffset - Stop reading at this offset (inclusive, default: unbounded).
   */
  iterator(startOffset?: number, endOffset?: number): StreamIteratorHandle<T>;

  /**
   * Check if the stream is still open.
   */
  isOpen(): Promise<StreamOpenResult>;
}

// =============================================================================
// CHILD WORKFLOW HANDLE (INTERNAL — parent-child, WorkflowContext)
// =============================================================================

/**
 * Handle to a child workflow started from within a workflow context.
 * Provides lifecycle observation, channel communication, event watching,
 * and stream reading.
 *
 * **No sigterm/sigkill** — workflow code uses transactional semantics
 * (scopes) instead of non-deterministic signals.
 * Signals are only available on engine-level handles.
 *
 * In the happy-path model, `.join()` returns T directly. If the child fails,
 * the parent workflow auto-terminates and compensations run.
 *
 * @typeParam TResult - Decoded result type.
 * @typeParam TChannels - Channel definitions of the child workflow.
 * @typeParam TStreams - Stream definitions of the child workflow.
 * @typeParam TEvents - Event definitions of the child workflow.
 * @typeParam HasCompensation - Whether a `compensate` callback was registered
 *   at `.start()` time. Controls whether `tryJoin()`'s `onFailure` parameter
 *   includes `compensate()`.
 */
export interface ChildWorkflowHandle<
  TResult,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  HasCompensation extends boolean = false,
> {
  readonly workflowId: string;

  /**
   * Wait for the child workflow to reach a terminal state.
   * Returns TResult directly. If the child fails or is terminated, the parent
   * auto-terminates and compensations run.
   *
   * @param options - Optional runtime options.
   */
  join(options?: ChildWorkflowJoinOptions): Promise<TResult>;

  /**
   * Wait for the child workflow with a timeout (in seconds).
   * Returns a discriminated union since timeout is an expected outcome.
   * Timeout does NOT cancel the child — it continues running in the background.
   *
   * @param timeoutSeconds - Timeout in seconds.
   * @param options - Optional runtime options.
   */
  join(
    timeoutSeconds: number,
    options?: ChildWorkflowJoinOptions,
  ): Promise<ChildWorkflowJoinResultWithTimeout<TResult>>;

  /**
   * Wait for the child workflow and handle the result via callbacks.
   * The workflow does NOT auto-terminate on failure or termination —
   * the developer handles all outcomes explicitly.
   *
   * `onFailure` receives a single object with failure info. If the handle
   * was started with `compensate`, the object includes `compensate()` for
   * eager discharge. If not called, the engine runs compensation at scope
   * exit (safe default).
   *
   * Returns the value produced by whichever callback fires.
   *
   * @param options - Callbacks and optional runtime options.
   */
  tryJoin<R1, R2>(
    options: {
      onComplete: (data: TResult) => R1;
      onFailure: (
        failure: HasCompensation extends true
          ? WithCompensation<ChildWorkflowFailureInfo>
          : ChildWorkflowFailureInfo,
      ) => R2;
    } & ChildWorkflowJoinRuntimeOptions,
  ): Promise<Awaited<R1> | Awaited<R2>>;

  /**
   * Wait for the child workflow with a timeout and handle all outcomes
   * via callbacks. Adds `onTimeout` for the timeout case — the child
   * continues running in the background.
   *
   * @param timeoutSeconds - Timeout in seconds.
   * @param options - Callbacks and optional runtime options.
   */
  tryJoin<R1, R2, R3>(
    timeoutSeconds: number,
    options: {
      onComplete: (data: TResult) => R1;
      onFailure: (
        failure: HasCompensation extends true
          ? WithCompensation<ChildWorkflowFailureInfo>
          : ChildWorkflowFailureInfo,
      ) => R2;
      onTimeout: () => R3;
    } & ChildWorkflowJoinRuntimeOptions,
  ): Promise<Awaited<R1> | Awaited<R2> | Awaited<R3>>;

  /**
   * Channels for sending messages TO the child workflow.
   * Fire-and-forget: returns void, no confirmation of receipt.
   */
  readonly channels: {
    [K in keyof TChannels]: {
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): Promise<void>;
    };
  };

  /**
   * Engine-managed lifecycle events of the child workflow.
   */
  readonly lifecycle: LifecycleEvents;

  /**
   * User-defined events of the child workflow (read-only).
   */
  readonly events: {
    [K in keyof TEvents]: EventAccessorReadonly;
  };

  /**
   * Streams of the child workflow (read-only).
   */
  readonly streams: {
    [K in keyof TStreams]: StreamReaderAccessor<
      StandardSchemaV1.InferOutput<TStreams[K]>
    >;
  };
}

// =============================================================================
// COMPENSATION CHILD WORKFLOW HANDLE (CompensationContext)
// =============================================================================

/**
 * Handle to a child workflow started in CompensationContext.
 * Returns Go-style result unions — compensation code must handle failures.
 *
 * @typeParam TResult - Decoded result type.
 * @typeParam TChannels - Channel definitions of the child workflow.
 * @typeParam TStreams - Stream definitions of the child workflow.
 * @typeParam TEvents - Event definitions of the child workflow.
 */
export interface CompensationChildWorkflowHandle<
  TResult,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
> {
  readonly workflowId: string;

  /**
   * Wait for the child workflow to reach a terminal state.
   * Returns a full result union — compensation code must handle all outcomes.
   */
  join(
    options?: ChildWorkflowJoinRuntimeOptions,
  ): Promise<WorkflowResult<TResult>>;

  /**
   * Wait with a timeout (in seconds).
   */
  join(
    timeoutSeconds: number,
    options?: ChildWorkflowJoinRuntimeOptions,
  ): Promise<CompensationChildWorkflowJoinResultWithTimeout<TResult>>;

  /** Channels for sending messages TO the child workflow. */
  readonly channels: {
    [K in keyof TChannels]: {
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): Promise<void>;
    };
  };

  /** Engine-managed lifecycle events of the child workflow. */
  readonly lifecycle: LifecycleEvents;

  /** User-defined events of the child workflow (read-only). */
  readonly events: {
    [K in keyof TEvents]: EventAccessorReadonly;
  };

  /** Streams of the child workflow (read-only). */
  readonly streams: {
    [K in keyof TStreams]: StreamReaderAccessor<
      StandardSchemaV1.InferOutput<TStreams[K]>
    >;
  };
}

/**
 * Handle to another (non-child) workflow from within a workflow context.
 *
 * SEVERELY LIMITED by design:
 * - Only channels.send() available
 * - No events, streams, lifecycle (prevents tight coupling)
 * - send() is fire-and-forget — returns void
 */
export interface WorkflowHandleInternal<TChannels extends ChannelDefinitions> {
  readonly workflowId: string;

  /**
   * Channels for sending messages to this workflow.
   * Fire-and-forget: returns void, workflow is oblivious to receiver existence.
   */
  readonly channels: {
    [K in keyof TChannels]: {
      /**
       * Send a message to this channel.
       * @param data - Message data (z.input type — encoded).
       */
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): Promise<void>;
    };
  };
}

// =============================================================================
// WORKFLOW ACCESSOR (WorkflowContext)
// =============================================================================

/**
 * Accessor for child workflows on `ctx.workflows` in WorkflowContext.
 * Provides `.start()` (scope-only), `.execute()` (sequential happy-path),
 * `.tryExecute()` (sequential explicit), `.startDetached()` (fire-and-forget),
 * and `.get()`.
 *
 * In the happy-path model, `.execute()` returns T directly. Failure
 * auto-terminates the parent workflow.
 *
 * `.tryExecute()` accepts `{ onComplete, onFailure }` callbacks for explicit
 * error handling without auto-termination. With `compensate`, `onFailure`'s
 * parameter includes `compensate()`. Returns R.
 *
 * @typeParam W - The child workflow definition type.
 * @typeParam TCompCtx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowAccessor<
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
  // --- start (scope-only, concurrent) ----------------------------------------

  /**
   * Start a child workflow with compensation within a scope declaration.
   * Returns a `ScopeEntry<ChildWorkflowHandle<..., true>>` —
   * `tryJoin()`'s `onFailure` will include `compensate()` on the failure object.
   *
   * Unjoined handles with `compensate` are compensated on scope exit.
   */
  start(
    options: ChildWorkflowScopeStartOptionsWithCompensation<
      InferWorkflowArgsInput<W>,
      InferWorkflowResult<W>,
      TCompCtx
    >,
  ): ScopeEntry<
    ChildWorkflowHandle<
      InferWorkflowResult<W>,
      InferWorkflowChannels<W>,
      InferWorkflowStreams<W>,
      InferWorkflowEvents<W>,
      true
    >
  >;

  /**
   * Start a child workflow within a scope declaration (no compensation).
   * Returns a `ScopeEntry<ChildWorkflowHandle<..., false>>`.
   *
   * Unjoined handles without `compensate` are settled on scope exit.
   */
  start(
    options: ChildWorkflowScopeStartOptionsWithoutCompensation<
      InferWorkflowArgsInput<W>
    >,
  ): ScopeEntry<
    ChildWorkflowHandle<
      InferWorkflowResult<W>,
      InferWorkflowChannels<W>,
      InferWorkflowStreams<W>,
      InferWorkflowEvents<W>,
      false
    >
  >;

  // --- execute (happy path) --------------------------------------------------

  /**
   * Start a child workflow and immediately join it (convenience for
   * start + join). Returns T directly — failure auto-terminates the parent.
   *
   * Supports `suspendAfter` to control when the parent workflow is suspended
   * while waiting for the child. Supports compensation callback.
   *
   * @param options - Start options plus runtime options and optional compensation.
   */
  execute(
    options: RunChildWorkflowOptions<
      InferWorkflowArgsInput<W>,
      InferWorkflowResult<W>,
      TCompCtx
    >,
  ): Promise<InferWorkflowResult<W>>;

  // --- tryExecute (explicit error handling, callback-based) ------------------

  /**
   * Start a child workflow and immediately join it, handling the result via
   * callbacks. `onFailure` receives failure info with `compensate()` for
   * eager discharge. If not called, engine runs it at scope exit.
   *
   * Returns the value produced by whichever callback fires.
   */
  tryExecute<R1, R2>(
    options: ChildWorkflowTryExecuteOptionsWithCompensation<
      InferWorkflowArgsInput<W>,
      InferWorkflowResult<W>,
      R1,
      R2,
      TCompCtx
    >,
  ): Promise<Awaited<R1> | Awaited<R2>>;

  /**
   * Start a child workflow and immediately join it, handling the result via
   * callbacks. `onFailure` receives plain failure info — no `compensate()`.
   *
   * Returns the value produced by whichever callback fires.
   */
  tryExecute<R1, R2>(
    options: ChildWorkflowTryExecuteOptionsWithoutCompensation<
      InferWorkflowArgsInput<W>,
      InferWorkflowResult<W>,
      R1,
      R2
    >,
  ): Promise<Awaited<R1> | Awaited<R2>>;

  // --- startDetached, get ----------------------------------------------------

  /**
   * Start a detached child workflow — fire-and-forget.
   *
   * The child runs independently of the parent's lifecycle:
   * - No scope required — the child is not managed by structured concurrency.
   * - No compensation — the parent's LIFO stack does not include this child.
   * - The child is NOT terminated when the parent fails or is signaled.
   *
   * Returns a limited handle for sending messages to the child.
   * This is the ONLY way to start concurrent work without a scope.
   *
   * @param options - Start options (workflowId, args, timeoutSeconds).
   */
  startDetached(
    options: StartChildWorkflowOptions<InferWorkflowArgsInput<W>>,
  ): Promise<WorkflowHandleInternal<InferWorkflowChannels<W>>>;

  /**
   * Get a handle to an existing (non-child) workflow instance.
   * Only channels.send() is available (fire-and-forget).
   *
   * @param workflowId - The workflow instance ID.
   */
  get(workflowId: string): WorkflowHandleInternal<InferWorkflowChannels<W>>;
}

/**
 * Accessor for child workflows on `ctx.workflows` in CompensationContext.
 * Returns full result unions (compensation code must handle all outcomes).
 * Now supports `.start()` for concurrent child workflows in compensation scopes.
 *
 * @typeParam W - The child workflow definition type.
 */
export interface CompensationWorkflowAccessor<
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
   * Start a child workflow and immediately join it.
   * Returns full WorkflowResult — compensation must handle failures gracefully.
   *
   * @param options - Start options plus runtime options.
   */
  execute(
    options: StartChildWorkflowOptions<InferWorkflowArgsInput<W>> &
      ChildWorkflowJoinRuntimeOptions,
  ): Promise<WorkflowResult<InferWorkflowResult<W>>>;

  /**
   * Start a child workflow concurrently within a compensation scope.
   * Returns a ScopeEntry that resolves into a CompensationChildWorkflowHandle.
   *
   * @param options - Start options (workflowId, args, timeoutSeconds).
   */
  start(
    options: StartChildWorkflowOptions<InferWorkflowArgsInput<W>>,
  ): ScopeEntry<
    CompensationChildWorkflowHandle<
      InferWorkflowResult<W>,
      InferWorkflowChannels<W>,
      InferWorkflowStreams<W>,
      InferWorkflowEvents<W>
    >
  >;

  /**
   * Get a handle to an existing (non-child) workflow instance.
   * Only channels.send() is available (fire-and-forget).
   *
   * @param workflowId - The workflow instance ID.
   */
  get(workflowId: string): WorkflowHandleInternal<InferWorkflowChannels<W>>;
}

// =============================================================================
// ONE-SHOT HANDLE HELPERS (for forEach / map)
// =============================================================================

/**
 * Handle types that resolve exactly once (WorkflowContext).
 * Used as constraints for forEach() and map().
 */
export type OneShotHandle =
  | StepHandle<any, any>
  | ChildWorkflowHandle<any, any, any, any, any>;

/**
 * Handle types that resolve exactly once (CompensationContext).
 */
export type CompensationOneShotHandle =
  | CompensationStepHandle<any>
  | CompensationChildWorkflowHandle<any, any, any, any>;

/**
 * Extract the data type from a one-shot handle.
 * In the happy-path model, this is just T (the successful result).
 */
export type HandleData<H> =
  H extends StepHandle<infer T, any>
    ? T
    : H extends ChildWorkflowHandle<infer T, any, any, any, any>
      ? T
      : never;

/**
 * Extract the compensation-context result type from a compensation one-shot handle.
 */
export type CompensationHandleResult<H> =
  H extends CompensationStepHandle<infer T>
    ? CompensationStepResult<T>
    : H extends CompensationChildWorkflowHandle<infer T, any, any, any>
      ? WorkflowResult<T>
      : never;

// =============================================================================
// SELECT — HANDLE TYPES (WorkflowContext)
// =============================================================================

/**
 * Handle types that can be passed into ctx.select() (WorkflowContext).
 */
export type SelectableHandle =
  | StepHandle<any, any>
  | ChildWorkflowHandle<any, any, any, any, any>
  | ChannelHandle<any>
  | StreamIteratorHandle<any>
  | LifecycleEventAccessor
  | EventAccessorReadonly;

/**
 * Handle types that can be passed into compCtx.select() (CompensationContext).
 */
export type CompensationSelectableHandle =
  | CompensationStepHandle<any>
  | CompensationChildWorkflowHandle<any, any, any, any>
  | ChannelHandle<any>
  | StreamIteratorHandle<any>
  | LifecycleEventAccessor
  | EventAccessorReadonly;

// =============================================================================
// SELECT — EVENT TYPES (WorkflowContext, happy-path)
// =============================================================================

/**
 * Map a handle type to its select event result type (WorkflowContext).
 *
 * In the happy-path model:
 * - Step/child handles: only successful data (failures crash the workflow
 *   unless handled by onFailure in match/forEach/map)
 * - Channels: data only (always succeed)
 * - Streams: record or closed
 * - Events: set or never
 *
 * No `ok` field. No `handle` field.
 */
export type HandleSelectEvent<K extends string, H> =
  H extends StepHandle<infer T, any>
    ? { key: K; data: T }
    : H extends ChildWorkflowHandle<infer T, any, any, any, any>
      ? { key: K; data: T }
      : H extends ChannelHandle<infer T>
        ? { key: K; data: T }
        : H extends StreamIteratorHandle<infer T>
          ?
              | { key: K; status: "record"; data: T; offset: number }
              | { key: K; status: "closed" }
          : H extends LifecycleEventAccessor
            ?
                | { key: K; status: "set" }
                | { key: K; status: "never" }
            : H extends EventAccessorReadonly
              ?
                  | { key: K; status: "set" }
                  | { key: K; status: "never" }
              : never;

/**
 * What a match handler receives for a specific key (WorkflowContext).
 *
 * For steps, children, and channels: the data value T directly.
 * For streams: a status-discriminated union (no key field needed in handler).
 * For events: a status-discriminated union.
 */
export type HandleMatchData<H> =
  H extends StepHandle<infer T, any>
    ? T
    : H extends ChildWorkflowHandle<infer T, any, any, any, any>
      ? T
      : H extends ChannelHandle<infer T>
        ? T
        : H extends StreamIteratorHandle<infer T>
          ?
              | { status: "record"; data: T; offset: number }
              | { status: "closed" }
          : H extends LifecycleEventAccessor
            ? { status: "set" } | { status: "never" }
            : H extends EventAccessorReadonly
              ? { status: "set" } | { status: "never" }
              : never;

// =============================================================================
// SELECT — EVENT TYPES (CompensationContext, failures visible)
// =============================================================================

/**
 * Map a handle type to its select event result type (CompensationContext).
 *
 * In compensation context, step/child failures are visible in the event union.
 * Channels, streams, events are unchanged.
 */
export type CompensationHandleSelectEvent<K extends string, H> =
  H extends CompensationStepHandle<infer T>
    ?
        | { key: K; ok: true; status: "complete"; data: T; errors: StepErrorAccessor }
        | { key: K; ok: false; status: "failed"; reason: "attempts_exhausted" | "timeout"; errors: StepErrorAccessor }
    : H extends CompensationChildWorkflowHandle<infer T, any, any, any>
      ?
          | { key: K; ok: true; status: "complete"; data: T }
          | { key: K; ok: false; status: "failed"; error: WorkflowExecutionError }
          | { key: K; ok: false; status: "terminated" }
      : H extends ChannelHandle<infer T>
        ? { key: K; data: T }
        : H extends StreamIteratorHandle<infer T>
          ?
              | { key: K; status: "record"; data: T; offset: number }
              | { key: K; status: "closed" }
          : H extends LifecycleEventAccessor
            ?
                | { key: K; status: "set" }
                | { key: K; status: "never" }
            : H extends EventAccessorReadonly
              ?
                  | { key: K; status: "set" }
                  | { key: K; status: "never" }
              : never;

/**
 * What a compensation match handler receives for a specific key.
 *
 * For steps: CompensationStepResult<T> (must handle failures).
 * For child workflows: WorkflowResult<T> (must handle failures).
 * For channels/streams/events: same as WorkflowContext.
 */
export type CompensationHandleMatchData<H> =
  H extends CompensationStepHandle<infer T>
    ? CompensationStepResult<T>
    : H extends CompensationChildWorkflowHandle<infer T, any, any, any>
      ? WorkflowResult<T>
      : H extends ChannelHandle<infer T>
        ? T
        : H extends StreamIteratorHandle<infer T>
          ?
              | { status: "record"; data: T; offset: number }
              | { status: "closed" }
          : H extends LifecycleEventAccessor
            ? { status: "set" } | { status: "never" }
            : H extends EventAccessorReadonly
              ? { status: "set" } | { status: "never" }
              : never;

// =============================================================================
// SELECT — RESULT UNIONS
// =============================================================================

/**
 * Union of all possible events from a select record (WorkflowContext).
 */
export type SelectEvent<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]: HandleSelectEvent<K, M[K]>;
}[keyof M & string];

/**
 * Union of all possible events from a select record (CompensationContext).
 */
export type CompensationSelectEvent<
  M extends Record<string, CompensationSelectableHandle>,
> = {
  [K in keyof M & string]: CompensationHandleSelectEvent<K, M[K]>;
}[keyof M & string];

/**
 * Result of Selection.next() without a timeout (WorkflowContext).
 */
export type SelectNextResultNoTimeout<
  M extends Record<string, SelectableHandle>,
> = SelectEvent<M> | { key: null; status: "exhausted" };

/**
 * Result of Selection.next() with a timeout (WorkflowContext).
 */
export type SelectNextResult<M extends Record<string, SelectableHandle>> =
  | SelectEvent<M>
  | { key: null; status: "timeout" }
  | { key: null; status: "exhausted" };

/**
 * Result of CompensationSelection.next() without a timeout.
 */
export type CompensationSelectNextResultNoTimeout<
  M extends Record<string, CompensationSelectableHandle>,
> = CompensationSelectEvent<M> | { key: null; status: "exhausted" };

/**
 * Result of CompensationSelection.next() with a timeout.
 */
export type CompensationSelectNextResult<
  M extends Record<string, CompensationSelectableHandle>,
> =
  | CompensationSelectEvent<M>
  | { key: null; status: "timeout" }
  | { key: null; status: "exhausted" };

// =============================================================================
// MATCH HELPERS
// =============================================================================

/**
 * Result of Selection.match().
 * Wraps the handler return value in a discriminated union.
 */
export type SelectMatchResult<T> =
  | { ok: true; status: "matched"; data: T }
  | { ok: false; status: "exhausted" };

/**
 * Result of Selection.match() with a timeout.
 * Includes "timeout" status — distinguishable from any handler return value.
 */
export type SelectMatchResultWithTimeout<T> =
  | SelectMatchResult<T>
  | { ok: false; status: "timeout" };

/**
 * Extract the return type from a handler entry (plain function or { onComplete }).
 */
type ExtractHandlerReturn<H> =
  H extends (...args: any[]) => infer R
    ? Awaited<R>
    : H extends { onComplete: (...args: any[]) => infer R; onFailure: (...args: any[]) => infer R2 }
      ? Awaited<R> | Awaited<R2>
      : H extends { onComplete: (...args: any[]) => infer R }
        ? Awaited<R>
        : never;

/**
 * Extract handler return type for compensation context (plain functions only).
 */
type ExtractCompensationHandlerReturn<H> =
  H extends (...args: any[]) => infer R
    ? Awaited<R>
    : never;

// =============================================================================
// MATCH HANDLER ENTRY TYPES (WorkflowContext)
// =============================================================================

/**
 * A match handler entry for a specific key (WorkflowContext).
 *
 * For compensatable handles (StepHandle, ChildWorkflowHandle), the handler can
 * be either a plain function or an `{ onComplete, onFailure }` object.
 *
 * - Plain function: receives successful data. If the step/child fails,
 *   the workflow crashes (auto-terminates and compensations run).
 * - `{ onComplete, onFailure }`: explicit handling. `onFailure` receives a
 *   single failure info object — with `compensate()` merged in when the
 *   handle was started with compensation.
 *
 * For non-compensatable handles (channels, streams, events), only a plain
 * function is allowed.
 */
export type MatchHandlerEntry<
  H extends SelectableHandle,
> = H extends StepHandle<any, any> | ChildWorkflowHandle<any, any, any, any, any>
  ?
      | ((data: HandleMatchData<H>) => any)
      | {
          onComplete: (data: HandleMatchData<H>) => any;
          onFailure: (failure: HandleOnFailureParam<H>) => any;
        }
  : (data: HandleMatchData<H>) => any;

/**
 * Handler map for Selection.match() (WorkflowContext).
 * Each key's handler type depends on the handle type for that key.
 */
export type MatchHandlers<
  M extends Record<string, SelectableHandle>,
> = {
  [K in keyof M & string]?: MatchHandlerEntry<M[K]>;
};

/**
 * Return type of Selection.match().
 * Union of all provided handler return types (awaited).
 */
export type MatchReturn<
  M extends Record<string, SelectableHandle>,
  H extends MatchHandlers<M>,
> = {
  [K in keyof H & string]: ExtractHandlerReturn<H[K]>;
}[keyof H & string];

/**
 * Union of select events from keys NOT present in the handler map.
 * Used to type the default handler — ensures exhaustive type narrowing.
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
// MATCH HANDLER ENTRY TYPES (CompensationContext)
// =============================================================================

/**
 * A match handler entry for a specific key (CompensationContext).
 * Always a plain function — no onFailure (failures are visible in the data).
 */
export type CompensationMatchHandlerEntry<
  H extends CompensationSelectableHandle,
> = (data: CompensationHandleMatchData<H>) => any;

/**
 * Handler map for CompensationSelection.match().
 */
export type CompensationMatchHandlers<
  M extends Record<string, CompensationSelectableHandle>,
> = {
  [K in keyof M & string]?: CompensationMatchHandlerEntry<M[K]>;
};

/**
 * Return type of CompensationSelection.match().
 */
export type CompensationMatchReturn<
  M extends Record<string, CompensationSelectableHandle>,
  H extends CompensationMatchHandlers<M>,
> = {
  [K in keyof H & string]: ExtractCompensationHandlerReturn<H[K]>;
}[keyof H & string];

/**
 * Union of compensation select events from keys NOT present in the handler map.
 */
export type UnhandledCompensationSelectEvent<
  M extends Record<string, CompensationSelectableHandle>,
  H extends Partial<Record<keyof M & string, any>>,
> = {
  [K in Exclude<keyof M & string, keyof H & string>]: CompensationHandleSelectEvent<
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
 * In the happy-path model, step/child failures crash the workflow by default.
 * Use `.match()` with `{ onComplete, onFailure }` handlers for explicit
 * failure recovery. `.next()` and `for await` only see successful events —
 * a failure triggers workflow termination and LIFO compensation.
 *
 * One-shot handles (StepHandle, ChildWorkflowHandle, events) produce exactly one event.
 * Multi-shot handles (ChannelHandle, StreamIteratorHandle) can produce multiple events.
 *
 * Returns { status: 'exhausted' } when all one-shot handles have resolved and
 * no multi-shot handles remain active.
 *
 * Implements AsyncIterable — can be used with `for await...of`.
 *
 * @typeParam M - The handle record type.
 */
export interface Selection<
  M extends Record<string, SelectableHandle>,
> extends AsyncIterable<SelectEvent<M>> {
  /**
   * Wait for the next event from any handle in the selection.
   * Returns { status: 'exhausted' } when all handles have resolved.
   * If a step/child fails, the workflow auto-terminates.
   */
  next(): Promise<SelectNextResultNoTimeout<M>>;

  /**
   * Wait for the next event with a timeout (in seconds).
   */
  next(timeoutSeconds: number): Promise<SelectNextResult<M>>;

  /**
   * Wait for the first event matching a handler.
   *
   * Handlers can be plain functions (failure crashes workflow) or
   * `{ onComplete, onFailure }` objects for step/child workflow keys.
   * `onFailure` receives a single failure info object with `compensate()`
   * merged in when the handle was started with compensation.
   */
  match<H extends MatchHandlers<M>>(
    handlers: H,
  ): Promise<SelectMatchResult<MatchReturn<M, H>>>;

  /** Handlers + timeout. */
  match<H extends MatchHandlers<M>>(
    handlers: H,
    timeoutSeconds: number,
  ): Promise<SelectMatchResultWithTimeout<MatchReturn<M, H>>>;

  /** Handlers + default for unhandled events. */
  match<H extends MatchHandlers<M>, TDefault>(
    handlers: H,
    defaultHandler: (event: UnhandledSelectEvent<M, H>) => Promise<TDefault> | TDefault,
  ): Promise<SelectMatchResult<MatchReturn<M, H> | Awaited<TDefault>>>;

  /** Handlers + default + timeout. */
  match<H extends MatchHandlers<M>, TDefault>(
    handlers: H,
    defaultHandler: (event: UnhandledSelectEvent<M, H>) => Promise<TDefault> | TDefault,
    timeoutSeconds: number,
  ): Promise<SelectMatchResultWithTimeout<MatchReturn<M, H> | Awaited<TDefault>>>;

  /**
   * Live set of unresolved handle keys.
   */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// SELECTION (CompensationContext)
// =============================================================================

/**
 * A selection in CompensationContext — failures are always visible in events.
 * No `onFailure` handlers — failures appear in the event type directly.
 * Compensation code must handle all outcomes explicitly.
 */
export interface CompensationSelection<
  M extends Record<string, CompensationSelectableHandle>,
> extends AsyncIterable<CompensationSelectEvent<M>> {
  /** Wait for the next event (includes failures). */
  next(): Promise<CompensationSelectNextResultNoTimeout<M>>;

  /** Wait for the next event with a timeout (in seconds). */
  next(timeoutSeconds: number): Promise<CompensationSelectNextResult<M>>;

  /** Pattern-match on events. Handlers receive full result unions for steps/children. */
  match<H extends CompensationMatchHandlers<M>>(
    handlers: H,
  ): Promise<SelectMatchResult<CompensationMatchReturn<M, H>>>;

  /** Handlers + timeout. */
  match<H extends CompensationMatchHandlers<M>>(
    handlers: H,
    timeoutSeconds: number,
  ): Promise<SelectMatchResultWithTimeout<CompensationMatchReturn<M, H>>>;

  /** Handlers + default. */
  match<H extends CompensationMatchHandlers<M>, TDefault>(
    handlers: H,
    defaultHandler: (event: UnhandledCompensationSelectEvent<M, H>) => Promise<TDefault> | TDefault,
  ): Promise<SelectMatchResult<CompensationMatchReturn<M, H> | Awaited<TDefault>>>;

  /** Handlers + default + timeout. */
  match<H extends CompensationMatchHandlers<M>, TDefault>(
    handlers: H,
    defaultHandler: (event: UnhandledCompensationSelectEvent<M, H>) => Promise<TDefault> | TDefault,
    timeoutSeconds: number,
  ): Promise<SelectMatchResultWithTimeout<CompensationMatchReturn<M, H> | Awaited<TDefault>>>;

  /** Live set of unresolved handle keys. */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// forEach / map — HANDLER ENTRY TYPES (WorkflowContext)
// =============================================================================

/**
 * A forEach handler entry for a specific one-shot handle key (WorkflowContext).
 *
 * Can be a plain function (receives data T directly, failure crashes workflow)
 * or an `{ onComplete, onFailure }` object for explicit failure handling.
 * `onFailure` receives a single failure info object — with `compensate()`
 * merged in when the handle was started with compensation.
 */
export type ForEachHandlerEntry<H extends OneShotHandle> =
  | ((data: HandleData<H>) => Promise<void> | void)
  | {
      onComplete: (data: HandleData<H>) => Promise<void> | void;
      onFailure: (failure: HandleOnFailureParam<H>) => Promise<void> | void;
    };

/**
 * A map handler entry for a specific one-shot handle key (WorkflowContext).
 *
 * Can be a plain function (receives data T, returns transformed value,
 * failure crashes workflow) or an `{ onComplete, onFailure }` object.
 * `onFailure` receives a single failure info object — with `compensate()`
 * merged in when the handle was started with compensation. Its return value
 * becomes the fallback in the result map.
 */
export type MapHandlerEntry<H extends OneShotHandle> =
  | ((data: HandleData<H>) => any)
  | {
      onComplete: (data: HandleData<H>) => any;
      onFailure: (failure: HandleOnFailureParam<H>) => any;
    };

// =============================================================================
// forEach / map — HANDLER ENTRY TYPES (CompensationContext)
// =============================================================================

/**
 * A forEach handler entry for CompensationContext.
 * Always a plain function — receives result unions (must handle failures).
 */
export type CompensationForEachHandlerEntry<
  H extends CompensationOneShotHandle,
> = (result: CompensationHandleResult<H>) => Promise<void> | void;

/**
 * A map handler entry for CompensationContext.
 * Always a plain function — receives result unions (must handle failures).
 */
export type CompensationMapHandlerEntry<
  H extends CompensationOneShotHandle,
> = (result: CompensationHandleResult<H>) => any;

// =============================================================================
// BASE CONTEXT (shared between WorkflowContext and CompensationContext)
// =============================================================================

/**
 * Base context shared between WorkflowContext and CompensationContext.
 * Contains all primitives that are identical between the two contexts.
 * Steps and workflows are NOT included — they differ per context.
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
   * @param options - Optional runtime options controlling suspension behavior.
   */
  sleep(seconds: number, options?: SleepRuntimeOptions): Promise<void>;

  /**
   * Deterministic random utilities.
   * Each key corresponds to an RNG stream declared in the workflow definition.
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
 * - Steps return `CompensationStepResult<T>` (must handle failures gracefully)
 * - `.start()` on steps returns `ScopeEntry<CompensationStepHandle<T>>` — for
 *   use inside `compCtx.scope()`
 * - Has `scope()`, `select()`, `forEach()`, `map()` — same structured
 *   concurrency primitives but with failures always visible in result types
 * - No `addCompensation()` (prevents nested compensation chains)
 * - No compensation callbacks on `.start()` or handlers (can't nest compensations)
 * - Workflows return full `WorkflowResult<T>` (must handle all outcomes)
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
   * `.execute()` returns `CompensationStepResult<T>` — must handle failures gracefully.
   * `.start()` returns `ScopeEntry<CompensationStepHandle<T>>` for use in `scope()`.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema
    >
      ? CompensationStepObject<TArgs, StandardSchemaV1.InferOutput<TResultSchema>>
      : never;
  };

  /**
   * Child workflows.
   * `.execute()` returns full `WorkflowResult<T>` — must handle all outcomes.
   * `.start()` returns `ScopeEntry<CompensationChildWorkflowHandle>` for use in `scope()`.
   */
  readonly workflows: {
    [K in keyof TWorkflows]: CompensationWorkflowAccessor<TWorkflows[K]>;
  };

  // ---------------------------------------------------------------------------
  // scope — structured concurrency in compensation
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency in compensation.
   *
   * On scope exit, all unjoined handles are settled (waited for, result ignored).
   * No per-handle compensation — compensation cannot nest.
   */
  scope<R, E extends Record<string, ScopeEntry<any>>>(
    entries: E,
    callback: (
      handles: {
        [K in keyof E]: E[K] extends ScopeEntry<infer H> ? H : never;
      },
    ) => Promise<R>,
  ): Promise<R>;

  // ---------------------------------------------------------------------------
  // select — multiplexed waiting with failures visible
  // ---------------------------------------------------------------------------

  /**
   * Create a selection for concurrent waiting in compensation.
   * Events include failure outcomes — compensation code must handle them.
   */
  select<M extends Record<string, CompensationSelectableHandle>>(
    handles: M,
  ): CompensationSelection<M>;

  // ---------------------------------------------------------------------------
  // forEach — process all one-shot handle results
  // ---------------------------------------------------------------------------

  /**
   * Process all one-shot handle results as they arrive.
   * Callbacks receive full result unions (CompensationStepResult / WorkflowResult).
   * Every handle must have a callback.
   */
  forEach<H extends Record<string, CompensationOneShotHandle>>(
    handles: H,
    callbacks: {
      [K in keyof H & string]: CompensationForEachHandlerEntry<H[K]>;
    },
  ): Promise<void>;

  /**
   * Process all one-shot handle results with partial callbacks and a default.
   */
  forEach<
    H extends Record<string, CompensationOneShotHandle>,
    C extends Partial<{
      [K in keyof H & string]: CompensationForEachHandlerEntry<H[K]>;
    }>,
  >(
    handles: H,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof H & string, keyof C & string>,
      result: CompensationHandleResult<H[Exclude<keyof H & string, keyof C & string>]>,
    ) => Promise<void> | void,
  ): Promise<void>;

  // ---------------------------------------------------------------------------
  // map — collect transformed results from all one-shot handles
  // ---------------------------------------------------------------------------

  /**
   * Collect transformed results from all one-shot handles.
   * Callbacks receive full result unions. Every handle must have a callback.
   */
  map<
    H extends Record<string, CompensationOneShotHandle>,
    C extends {
      [K in keyof H & string]: CompensationMapHandlerEntry<H[K]>;
    },
  >(
    handles: H,
    callbacks: C,
  ): Promise<{
    [K in keyof H & string]: ExtractCompensationHandlerReturn<C[K]> | undefined;
  }>;

  /**
   * Collect transformed results with partial callbacks and a default.
   */
  map<
    H extends Record<string, CompensationOneShotHandle>,
    C extends Partial<{
      [K in keyof H & string]: CompensationMapHandlerEntry<H[K]>;
    }>,
    TDefault,
  >(
    handles: H,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof H & string, keyof C & string>,
      result: CompensationHandleResult<H[Exclude<keyof H & string, keyof C & string>]>,
    ) => Promise<TDefault> | TDefault,
  ): Promise<{
    [K in keyof H & string]: K extends keyof C
      ? ExtractCompensationHandlerReturn<C[K]> | undefined
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
 * Implements the happy-path model: step/child `.execute()` returns T directly.
 * If a step or child workflow fails, the workflow auto-terminates and
 * compensations run in LIFO order.
 *
 * Structured concurrency via `ctx.scope()`: every concurrent handle has a
 * declared lifecycle boundary. On scope exit, handles with `compensate` are
 * compensated; handles without are settled.
 *
 * Compensation is defined once per handle at `.start()` or `.execute()` time.
 * No override mechanics. `onFailure` on concurrency primitive handlers provides
 * explicit failure recovery with access to the `compensate()` tool.
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
   * `.execute()` returns T directly (happy path). Failure auto-terminates.
   * `.start()` returns a ScopeEntry — must be used inside `ctx.scope()`.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema
    >
      ? WorkflowStepObject<
          TArgs,
          StandardSchemaV1.InferOutput<TResultSchema>,
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
   * Child workflows.
   * `.execute()` returns T directly (happy path). Failure auto-terminates.
   * `.start()` returns a ScopeEntry — must be used inside `ctx.scope()`.
   */
  readonly workflows: {
    [K in keyof TWorkflows]: WorkflowAccessor<
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
   * Create a selection for concurrent waiting.
   * Pass a record of named handles — use `event.key` to discriminate results.
   *
   * Step/child failures crash the workflow by default (happy-path model).
   * Use `.match()` with `{ onComplete, onFailure }` handlers for recovery.
   */
  select<M extends Record<string, SelectableHandle>>(
    handles: M,
  ): Selection<M>;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency primitive
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency.
   *
   * Every concurrent handle (step or child workflow) must exist within a scope.
   * `.start()` returns ScopeEntry values that the scope resolves into handles.
   * The callback receives the materialized handles.
   *
   * When the callback exits:
   * - Handles with a `compensate` callback that weren't consumed → compensation runs
   * - Handles without `compensate` that weren't consumed → settled (wait, ignore result)
   * - On error (callback throws): all unjoined handles with `compensate` are compensated
   *
   * The scope resolves to whatever the callback returns. Cleanup happens
   * after the callback returns but before the scope's promise resolves.
   */
  scope<R, E extends Record<string, ScopeEntry<any>>>(
    entries: E,
    callback: (
      handles: {
        [K in keyof E]: E[K] extends ScopeEntry<infer H> ? H : never;
      },
    ) => Promise<R>,
  ): Promise<R>;

  // ---------------------------------------------------------------------------
  // forEach — process all one-shot handle results as they arrive
  // ---------------------------------------------------------------------------

  /**
   * Process all one-shot handle results as they arrive.
   * In the happy-path model, plain callbacks receive successful data (T).
   * If a step/child fails and the handler is a plain function, the workflow
   * auto-terminates (failure crashes workflow).
   *
   * Use `{ onComplete, onFailure }` handlers for explicit failure recovery.
   *
   * Only accepts StepHandle and ChildWorkflowHandle.
   */
  forEach<H extends Record<string, OneShotHandle>>(
    handles: H,
    callbacks: {
      [K in keyof H & string]: ForEachHandlerEntry<H[K]>;
    },
  ): Promise<void>;

  /**
   * Process all one-shot handle results with partial callbacks and a default.
   * The default only receives keys NOT explicitly covered by callbacks.
   */
  forEach<
    H extends Record<string, OneShotHandle>,
    C extends Partial<{
      [K in keyof H & string]: ForEachHandlerEntry<H[K]>;
    }>,
  >(
    handles: H,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof H & string, keyof C & string>,
      data: HandleData<H[Exclude<keyof H & string, keyof C & string>]>,
    ) => Promise<void> | void,
  ): Promise<void>;

  // ---------------------------------------------------------------------------
  // map — collect transformed results from all one-shot handles
  // ---------------------------------------------------------------------------

  /**
   * Collect transformed results from all one-shot handles.
   * Plain callbacks receive successful data (T) and return a transformed value.
   * If a step/child fails and the handler is a plain function, the workflow
   * auto-terminates (failure crashes workflow).
   *
   * Use `{ onComplete, onFailure }` handlers for explicit failure recovery.
   * `onFailure` return value becomes the fallback in the result.
   *
   * Only accepts StepHandle and ChildWorkflowHandle.
   */
  map<
    H extends Record<string, OneShotHandle>,
    C extends {
      [K in keyof H & string]: MapHandlerEntry<H[K]>;
    },
  >(
    handles: H,
    callbacks: C,
  ): Promise<{
    [K in keyof H & string]: ExtractHandlerReturn<C[K]> | undefined;
  }>;

  /**
   * Collect transformed results with partial callbacks and a default.
   */
  map<
    H extends Record<string, OneShotHandle>,
    C extends Partial<{
      [K in keyof H & string]: MapHandlerEntry<H[K]>;
    }>,
    TDefault,
  >(
    handles: H,
    callbacks: C,
    defaultCallback: (
      key: Exclude<keyof H & string, keyof C & string>,
      data: HandleData<H[Exclude<keyof H & string, keyof C & string>]>,
    ) => Promise<TDefault> | TDefault,
  ): Promise<{
    [K in keyof H & string]: K extends keyof C
      ? ExtractHandlerReturn<C[K]> | undefined
      : Awaited<TDefault> | undefined;
  }>;

  // ---------------------------------------------------------------------------
  // addCompensation — Layer 3: general purpose
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
 * In the happy-path model, the workflow author writes the happy path.
 * Step/child failures auto-terminate the workflow and trigger compensation.
 * Compensation runs in LIFO order. Each handle has at most one compensation
 * callback, defined at `.start()` or `.execute()` time.
 *
 * The engine interleaves compensation callbacks from the same scope via a
 * virtual event loop for concurrent execution. The developer writes normal
 * sequential code inside each compensation callback.
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
