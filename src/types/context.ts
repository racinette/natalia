import type { StandardSchemaV1 } from "./standard-schema";
import type {
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  PatchDefinitions,
  RngDefinitions,
  StepDefinition,
  StepDefinitions,
  WorkflowDefinitions,
  AnyWorkflowHeader,
  PatchAccessor,
  RngAccessors,
  RetryPolicyOptions,
  DeadlineOptions,
  RetentionSettings,
  WorkflowInvocationBaseOptions,
} from "./definitions";
import type {
  StepCompensationResult,
  CompensationStepResult,
  ChildWorkflowCompensationResult,
  WorkflowResult,
  EventWaitResult,
  EventWaitResultNoTimeout,
  EventCheckResult,
} from "./results";
import type {
  DeterministicAwaitable,
  DirectAwaitable,
  WorkflowAwaitable,
  ChannelHandle,
  StreamAccessor,
  EventAccessor,
  BranchHandle,
  ScopeHandles,
  FirstResult,
  ScopePath,
  AppendScopeName,
  AppendBranchKey,
  ScopeNameArg,
  ListenableHandle,
  Listener,
  ScopeSelectableHandle,
  ScopeSelectableRecordForPath,
  Selection,
  CompensationSelection,
  SelectDataKeyedUnion,
  MatchHandlers,
  MatchReturn,
  StepFailureInfo,
  ChildWorkflowFailureInfo,
  ExecutionRoot,
  CompensationRoot,
  IsJoinableByPath,
} from "./concurrency";

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
  sleep(): WorkflowAwaitable<ScheduleTick>;
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
 * Await the call via `ctx.execute(stepCall)` to resolve to `T | TFail`.
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for this workflow.
 */
export interface StepCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DeterministicAwaitable<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback for this step.
   * Runs during LIFO unwinding when the workflow fails.
   */
  compensate(
    cb: (ctx: Tctx, result: StepCompensationResult<T>) => Promise<void>,
  ): StepCall<T, TFail, true, Tctx>;

  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): StepCall<T, TFail, HasCompensation, Tctx>;

  /**
   * Handle step failure explicitly — the workflow does NOT auto-terminate.
   * The callback return value becomes TFail in the resolved union.
   */
  failure<R>(
    cb: (failure: StepFailureInfo) => R,
  ): StepCall<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the success result.
   * The callback return value replaces T in the resolved type.
   */
  complete<R>(
    cb: (data: T) => R,
  ): StepCall<Awaited<R>, TFail, HasCompensation, Tctx>;
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
export interface CompensationStepCall<T> extends DeterministicAwaitable<
  CompensationStepResult<T>,
  CompensationRoot
> {
  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): CompensationStepCall<T>;
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
  readonly idempotencyKey: string;

  /**
   * Channels for sending messages to this workflow.
   * Fire-and-forget: returns void.
   */
  readonly channels: {
    [K in keyof TChannels]: {
      send(
        data: StandardSchemaV1.InferInput<TChannels[K]>,
      ): DirectAwaitable<void>;
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
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowCallResult<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DeterministicAwaitable<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback for this child workflow invocation.
   * Runs during LIFO unwinding when the parent workflow fails.
   */
  compensate(
    cb: (
      ctx: Tctx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, Tctx>;

  /**
   * Handle child workflow failure explicitly — the parent does NOT auto-terminate.
   */
  failure<R>(
    cb: (failure: ChildWorkflowFailureInfo) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the child workflow's success result.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, Tctx>;
}

/**
 * Thenable returned by calling a child workflow accessor in WorkflowContext.
 *
 * Structured result mode for child workflow calls.
 *
 * Call the accessor with `{ detached: true }` to use detached messaging mode instead,
 * which returns a `ForeignWorkflowHandle` directly from the accessor call.
 *
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DeterministicAwaitable<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback.
   */
  compensate(
    cb: (
      ctx: Tctx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, Tctx>;

  /**
   * Handle child workflow failure explicitly.
   */
  failure<R>(
    cb: (failure: ChildWorkflowFailureInfo) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the child workflow's success result — enters result mode.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, Tctx>;
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
export interface CompensationWorkflowCall<T> extends DeterministicAwaitable<
  WorkflowResult<T>,
  CompensationRoot
> {}

// =============================================================================
// WORKFLOW ACCESSORS (CONTEXT-SPECIFIC)
// =============================================================================

/**
 * Base start options for a child workflow call.
 */
export type ChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  WorkflowInvocationBaseOptions<
    InferWorkflowArgsInput<W>,
    InferWorkflowMetadataInput<W>
  > &
    DeadlineOptions;

/**
 * Child workflow start options in attached mode.
 * Retention is inherited from the parent workflow.
 */
export type AttachedChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W>;

/**
 * Child workflow start options in detached mode.
 * Detached children may override retention independently from the parent.
 * The `detached: true` flag is implied by calling `.startDetached()`.
 */
export type DetachedStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W> & {
    retention?: number | RetentionSettings;
  };

/**
 * Start options for child workflow calls in compensation context.
 */
export type CompensationChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  WorkflowInvocationBaseOptions<
    InferWorkflowArgsInput<W>,
    InferWorkflowMetadataInput<W>
  >;

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in WorkflowContext.
 *
 * @typeParam W - The child workflow definition.
 * @typeParam Tctx - The parent workflow's CompensationContext type.
 */
export interface ChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
  Tctx = unknown,
> {
  (
    options: AttachedChildWorkflowStartOptions<W>,
  ): WorkflowCall<InferWorkflowResult<W>, never, false, Tctx>;

  /**
   * Start this child workflow in detached mode.
   *
   * The child runs independently — the parent does not wait for its result and
   * lifecycle is not managed. Returns a `ForeignWorkflowHandle` for fire-and-forget
   * channel messaging.
   *
   * This is an atomic, synchronous-at-engine-level operation — directly awaitable.
   */
  startDetached(
    options: DetachedStartOptions<W>,
  ): DirectAwaitable<ForeignWorkflowHandle<InferWorkflowChannels<W>>>;
}

/**
 * Foreign workflow accessor on `ctx.foreignWorkflows` in WorkflowContext.
 *
 * Use `.get(idempotencyKey)` to obtain a `ForeignWorkflowHandle` for an existing
 * (non-child) workflow instance. Only `channels.send()` is available — no
 * events, streams, or lifecycle (prevents tight coupling).
 *
 * @typeParam W - The workflow definition (for channel type inference).
 */
export interface ForeignWorkflowAccessor<W extends AnyWorkflowHeader> {
  /**
   * Get a limited handle to an existing workflow instance.
   * Only channels.send() is available (fire-and-forget).
   *
   * @param idempotencyKey - The workflow idempotency key.
   */
  get(idempotencyKey: string): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in CompensationContext.
 * Returns full `WorkflowResult<T>` — compensation code must handle all outcomes.
 *
 * @typeParam W - The child workflow definition.
 */
export interface CompensationChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
> {
  (
    options: CompensationChildWorkflowStartOptions<W>,
  ): CompensationWorkflowCall<InferWorkflowResult<W>>;
}

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
  wait(): WorkflowAwaitable<EventWaitResultNoTimeout>;

  /**
   * Wait for the lifecycle event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): WorkflowAwaitable<EventWaitResult>;

  /**
   * Check if the lifecycle event is set (non-blocking).
   */
  get(): DirectAwaitable<EventCheckResult>;
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
  wait(): WorkflowAwaitable<EventWaitResultNoTimeout>;

  /**
   * Wait for the event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): WorkflowAwaitable<EventWaitResult>;

  /**
   * Check if the event is set (non-blocking).
   */
  get(): DirectAwaitable<EventCheckResult>;
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
  /** Unique internal workflow instance identifier (not the idempotency key). */
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
  sleep(seconds: number): WorkflowAwaitable<void>;

  /**
   * Durable sleep until a target instant.
   * @param target - Target time as Date or epoch milliseconds.
   */
  sleepUntil(target: Date | number): WorkflowAwaitable<void>;

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
 * afterCompensate, and beforeSettle when status is failed/terminated).
 *
 * Key differences from WorkflowContext:
 * - Steps return `CompensationStepResult<T>` via `CompensationStepCall<T>` —
 *   compensation code MUST handle failures gracefully.
 * - Has `scope(name, ...)`, `all(...)`, `first(...)`, and `listen()`.
 * - Full structured-concurrency primitives (`select` with branch handles, `match`)
 *   are available only inside `scope(name, ...)` via `CompensationConcurrencyContext`.
 * - `childWorkflows` return `CompensationWorkflowCall<T>` → `WorkflowResult<T>`.
 * - No `addCompensation()` (prevents nested compensation chains).
 * - No `foreignWorkflows` accessor (fire-and-forget not needed in compensation).
 *
 * The engine transparently interleaves compensation callbacks from the same
 * scope via a virtual event loop. Each callback looks like normal sequential
 * code — the engine handles concurrency at durable operation yield points.
 *
 * @typeParam TScopePath - The scope path of this context instance. Defaults to `[]`
 *   for the root compensation context; branch closures receive a path-specialized
 *   instance with `AppendBranchKey<AppendScopeName<...>, K>`.
 */
export interface CompensationContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
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
    [K in keyof TChildWorkflows]: CompensationChildWorkflowAccessor<
      TChildWorkflows[K]
    >;
  };

  /**
   * Foreign workflow accessors — message-only handles to existing workflow instances.
   * Use `.get(idempotencyKey)` to get a `ForeignWorkflowHandle` with `channels.send()` only.
   * No lifecycle, events, streams, or compensation (prevents tight coupling).
   */
  readonly foreignWorkflows: {
    [K in keyof TForeignWorkflows]: ForeignWorkflowAccessor<
      TForeignWorkflows[K]
    >;
  };

  // ---------------------------------------------------------------------------
  // execute — resolve a deterministic handle
  // ---------------------------------------------------------------------------

  /**
   * Execute (resolve) a lazy deterministic handle created in this compensation context.
   *
   * Use `ctx.execute()` for steps, child workflows, `scope()`, `all()`, and `first()`.
   * Use `ctx.join()` for already-running `BranchHandle`s from an ancestor scope.
   */
  execute<H extends DeterministicAwaitable<any, CompensationRoot>>(
    handle: H,
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  /**
   * Resolve a branch handle created in an ancestor scope from within a branch
   * closure of a nested compensation scope.
   *
   * Branch closures receive a path-specialized `CompensationContext` whose
   * `TScopePath` extends the parent scope's path. `join` enforces at compile
   * time that the handle's scope path is a prefix of the current scope path —
   * guaranteeing the handle was created in a scope that is still live (i.e. an
   * ancestor of the current branch).
   *
   * Use `ctx.execute()` for lazy (not-yet-running) handles such as steps,
   * child workflows, and `scope()`/`all()`/`first()` results.
   */
  join<H extends DeterministicAwaitable<any, CompensationRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency in compensation (closure-based)
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency in compensation.
   *
   * Each entry is an async closure `(ctx: CompensationContext<..., BranchPath>) => Promise<T>`.
   * The `ctx` argument is a path-specialized `CompensationContext` with the branch's
   * exact scope path, enabling compile-time lifetime tracking.
   *
   * On scope exit, all running branches are awaited to completion.
   * No per-branch compensation — compensation cannot nest.
   *
   * Resolve the scope result: `await ctx.execute(ctx.scope("Name", entries, callback))`.
   *
   * Providing `defaultValue` makes the scope fail-safe: if the callback throws, all
   * registered compensations within the scope run (LIFO), then `defaultValue` is
   * returned instead of propagating the failure.
   */
  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        CompensationRoot
      >,
    ) => Promise<R>,
  ): DeterministicAwaitable<R, CompensationRoot>;

  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
    TDefault,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        CompensationRoot
      >,
    ) => Promise<R>,
    defaultValue: TDefault,
  ): DeterministicAwaitable<R | TDefault, CompensationRoot>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.execute(ctx.all(entries))`.
   */
  all<
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
  >(
    entries: E,
  ): DeterministicAwaitable<
    { [K in keyof E]: Awaited<ReturnType<E[K]>> },
    CompensationRoot
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.execute(ctx.first(entries))`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the workflow is terminated unless `defaultValue` is provided.
   * On `CompensationContext`, `defaultValue` is required — compensation must always
   * produce a meaningful result even if all branches fail.
   */
  first<
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
    TDefault,
  >(
    entries: E,
    defaultValue: TDefault,
  ): DeterministicAwaitable<FirstResult<E> | TDefault, CompensationRoot>;

  // ---------------------------------------------------------------------------
  // listen — channel-only multiplexed waiting (all contexts)
  // ---------------------------------------------------------------------------

  /**
   * Create a listener for concurrent channel waiting.
   *
   * Accepts only channel handles (`ChannelHandle` and `ChannelReceiveCall`).
   * Directly iterable: `for await (const { key, message } of listener) { ... }`.
   *
   * - `ChannelHandle` — streaming; never removed from `remaining`.
   * - `ChannelReceiveCall` — one-shot; removed from `remaining` after resolving.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;
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
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> = (
  ctx: CompensationContext<
    TState,
    TChannels,
    TStreams,
    TEvents,
    TSteps,
    TChildWorkflows,
    TForeignWorkflows,
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
 * Structured concurrency via `ctx.scope(name, entries, callback)`:
 * every concurrent branch runs as a closure `(ctx) => Promise<T>`.
 * Branches with compensated steps are compensated on scope exit.
 *
 * Resolve handles with `ctx.execute(handle)`. Inside scope callbacks, use
 * `ctx.join(handle)` on the `WorkflowConcurrencyContext` for branch handle coordination.
 *
 * Base `ctx.listen()` is channel-only.
 * Full concurrency primitives (`select` with branch handles and `match`) are
 * available only inside `ctx.scope(name, ...)` via `WorkflowConcurrencyContext`.
 *
 * @typeParam TScopePath - The scope path of this context instance. Defaults to `[]`
 *   for the root execution context; branch closures receive a path-specialized
 *   instance with `AppendBranchKey<AppendScopeName<...>, K>`.
 */
export interface WorkflowContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
> extends BaseContext<TState, TChannels, TStreams, TEvents, TPatches, TRng> {
  /**
   * Steps for durable operations.
   * Calling a step returns a `StepCall<T>` thenable — chain builders before executing.
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
            TChildWorkflows,
            TForeignWorkflows,
            TPatches,
            TRng
          >
        >
      : never;
  };

  /**
   * Child workflow accessors — structured invocation (lifecycle managed by parent).
   * Calling an accessor returns a `WorkflowCall<T>` (result mode with builders).
   * Use `.startDetached(opts)` to start without lifecycle management.
   */
  readonly childWorkflows: {
    [K in keyof TChildWorkflows]: ChildWorkflowAccessor<
      TChildWorkflows[K],
      CompensationContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng
      >
    >;
  };

  /**
   * Foreign workflow accessors — message-only handles to existing workflow instances.
   * Use `.get(idempotencyKey)` to get a `ForeignWorkflowHandle` with `channels.send()` only.
   * No lifecycle, events, streams, or compensation (prevents tight coupling).
   */
  readonly foreignWorkflows: {
    [K in keyof TForeignWorkflows]: ForeignWorkflowAccessor<
      TForeignWorkflows[K]
    >;
  };

  // ---------------------------------------------------------------------------
  // execute — resolve a deterministic handle
  // ---------------------------------------------------------------------------

  /**
   * Execute (resolve) a lazy deterministic handle created in this execution context.
   *
   * Use `ctx.execute()` for steps, child workflows, `scope()`, `all()`, and `first()`.
   * Use `ctx.join()` for already-running `BranchHandle`s from an ancestor scope.
   */
  execute<H extends DeterministicAwaitable<any, ExecutionRoot>>(
    handle: H,
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  /**
   * Resolve a branch handle created in an ancestor scope from within a branch
   * closure of a nested scope.
   *
   * Branch closures receive a path-specialized `WorkflowContext` whose
   * `TScopePath` extends the parent scope's path. `join` enforces at compile
   * time that the handle's scope path is a prefix of the current scope path —
   * guaranteeing the handle was created in a scope that is still live (i.e. an
   * ancestor of the current branch).
   *
   * Use `ctx.execute()` for lazy (not-yet-running) handles such as steps,
   * child workflows, and `scope()`/`all()`/`first()` results.
   */
  join<H extends DeterministicAwaitable<any, ExecutionRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  /**
   * Create a cron-like schedule handle for recurring execution.
   *
   * The first tick is computed from `ctx.timestamp` (workflow creation time),
   * unless `options.resumeAt` is provided. With `options.resumeAt`, the first
   * tick is the first schedule point strictly after the anchor instant (never
   * equal), then subsequent ticks advance from previous schedule points via
   * pure schedule math. No wall-clock access is required in workflow code.
   */
  schedule(expression: string, options?: ScheduleOptions): ScheduleHandle;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency (closure-based)
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency.
   *
   * Each entry is an async closure `(ctx: WorkflowContext<..., BranchPath>) => Promise<T>`.
   * The `ctx` argument is a path-specialized `WorkflowContext` with the branch's
   * exact scope path, enabling compile-time lifetime tracking.
   *
   * Scope exit behavior:
   * - Branches with compensated steps that weren't consumed → compensation runs
   * - Branches without compensation that weren't consumed → awaited, result ignored
   * - On error (callback throws): all unresolved compensated branches are compensated
   *
   * Resolve the scope result: `await ctx.execute(ctx.scope("Name", entries, callback))`.
   *
   * Providing `defaultValue` makes the scope fail-safe: if the callback throws, all
   * registered compensations within the scope run (LIFO), then `defaultValue` is
   * returned instead of propagating the failure.
   */
  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        ExecutionRoot
      >,
    ) => Promise<R>,
  ): DeterministicAwaitable<R, ExecutionRoot>;

  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
    TDefault,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        ExecutionRoot
      >,
    ) => Promise<R>,
    defaultValue: TDefault,
  ): DeterministicAwaitable<R | TDefault, ExecutionRoot>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.execute(ctx.all(entries))`.
   */
  all<
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
  >(
    entries: E,
  ): DeterministicAwaitable<
    { [K in keyof E]: Awaited<ReturnType<E[K]>> },
    ExecutionRoot
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.execute(ctx.first(entries))`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail without a `defaultValue`, the workflow is terminated.
   * Providing `defaultValue` returns it instead of terminating.
   */
  first<
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
  >(
    entries: E,
  ): DeterministicAwaitable<FirstResult<E>, ExecutionRoot>;

  first<
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
    TDefault,
  >(
    entries: E,
    defaultValue: TDefault,
  ): DeterministicAwaitable<FirstResult<E> | TDefault, ExecutionRoot>;

  // ---------------------------------------------------------------------------
  // listen — channel-only multiplexed waiting (all contexts)
  // ---------------------------------------------------------------------------

  /**
   * Create a listener for concurrent channel waiting.
   *
   * Accepts only channel handles (`ChannelHandle` and `ChannelReceiveCall`).
   * Directly iterable: `for await (const { key, message } of listener) { ... }`.
   *
   * - `ChannelHandle` — streaming; never removed from `remaining`.
   * - `ChannelReceiveCall` — one-shot; removed from `remaining` after resolving.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;

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
      TChildWorkflows,
      TForeignWorkflows,
      TPatches,
      TRng
    >,
  ): void;
}

// =============================================================================
// WORKFLOW CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in workflow execution.
 *
 * Exposes full branch-aware concurrency primitives (`select`, `match`) and is
 * provided only as the first argument to `WorkflowContext.scope(...)`.
 * Use `ctx.execute()` for lazy handles (steps, child workflows, scope/all/first)
 * and `ctx.join()` for already-running `BranchHandle`s.
 */
export interface WorkflowConcurrencyContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
> extends Omit<
  WorkflowContext<
    TState,
    TChannels,
    TStreams,
    TEvents,
    TSteps,
    TChildWorkflows,
    TForeignWorkflows,
    TPatches,
    TRng,
    TScopePath
  >,
  "scope" | "listen" | "execute"
> {
  /**
   * Execute (resolve) a deterministic handle created in this execution context.
   *
   * Use for steps, child workflows, `scope()`, `all()`, `first()`.
   */
  execute<H extends DeterministicAwaitable<any, ExecutionRoot>>(
    handle: H,
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  /**
   * Resolve a branch handle created in this scope or an ancestor scope.
   *
   * For `BranchHandle`s, enforces at compile time that the handle's scope path
   * is a prefix of the current scope path — preventing handles from escaping
   * their intended lifetime.
   *
   * Use `ctx.execute()` for lazy (not-yet-running) handles like steps and child workflows.
   */
  join<H extends DeterministicAwaitable<any, ExecutionRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        ExecutionRoot
      >,
    ) => Promise<R>,
  ): DeterministicAwaitable<R, ExecutionRoot>;

  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
    TDefault,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        ExecutionRoot
      >,
    ) => Promise<R>,
    defaultValue: TDefault,
  ): DeterministicAwaitable<R | TDefault, ExecutionRoot>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.execute(ctx.all(entries))`.
   */
  all<
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
  >(
    entries: E,
  ): DeterministicAwaitable<
    { [K in keyof E]: Awaited<ReturnType<E[K]>> },
    ExecutionRoot
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Resolve: `await ctx.execute(ctx.first(entries))`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail without a `defaultValue`, the workflow is terminated.
   * Providing `defaultValue` returns it instead of terminating.
   */
  first<
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
  >(
    entries: E,
  ): DeterministicAwaitable<FirstResult<E>, ExecutionRoot>;

  first<
    E extends Record<
      string,
      (
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
    TDefault,
  >(
    entries: E,
    defaultValue: TDefault,
  ): DeterministicAwaitable<FirstResult<E> | TDefault, ExecutionRoot>;

  /**
   * Create a listener for concurrent channel waiting.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;

  /**
   * Create a selection for concurrent waiting over scope branch handles and
   * channels.
   */
  select<M extends Record<string, ScopeSelectableHandle>>(
    handles: ScopeSelectableRecordForPath<M, TScopePath>,
  ): Selection<ScopeSelectableRecordForPath<M, TScopePath>>;

  /**
   * Iterate over a selection, yielding `{ key, result }` for each event.
   * Branch failures auto-terminate the workflow.
   */
  match<M extends Record<string, ScopeSelectableHandle>>(
    sel: Selection<M>,
  ): AsyncIterable<SelectDataKeyedUnion<M>>;

  /**
   * Iterate over a selection with a default failure handler.
   * Failures on keys without an explicit handler call `onFailure`.
   */
  match<
    M extends Record<string, ScopeSelectableHandle>,
    DF extends () => any,
  >(
    sel: Selection<M>,
    onFailure: DF,
  ): AsyncIterable<
    MatchReturn<M, Record<never, never>, Awaited<ReturnType<DF>>>
  >;

  /**
   * Iterate over a selection with per-key handlers.
   * Unhandled keys yield data unchanged (identity) on complete; failure auto-terminates.
   */
  match<
    M extends Record<string, ScopeSelectableHandle>,
    H extends MatchHandlers<M>,
  >(
    sel: Selection<M>,
    handlers: H,
  ): AsyncIterable<MatchReturn<M, H>>;

  /**
   * Iterate over a selection with per-key handlers and a default failure handler.
   * `onFailure` applies to keys without an explicit `failure` handler.
   */
  match<
    M extends Record<string, ScopeSelectableHandle>,
    H extends MatchHandlers<M>,
    DF extends () => any,
  >(
    sel: Selection<M>,
    handlers: H,
    onFailure: DF,
  ): AsyncIterable<MatchReturn<M, H, Awaited<ReturnType<DF>>>>;
}

// =============================================================================
// COMPENSATION CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in compensation execution.
 *
 * Exposes full branch-aware concurrency primitives (`select`, `match`) and is
 * provided only as the first argument to `CompensationContext.scope(...)`.
 * Use `ctx.execute()` for lazy handles (steps, child workflows, scope/all/first)
 * and `ctx.join()` for already-running `BranchHandle`s.
 */
export interface CompensationConcurrencyContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
> extends Omit<
  CompensationContext<
    TState,
    TChannels,
    TStreams,
    TEvents,
    TSteps,
    TChildWorkflows,
    TForeignWorkflows,
    TPatches,
    TRng,
    TScopePath
  >,
  "scope" | "listen" | "execute"
> {
  /**
   * Execute (resolve) a deterministic handle created in this compensation context.
   *
   * Use for steps, child workflows, `scope()`, `all()`, `first()`.
   */
  execute<H extends DeterministicAwaitable<any, CompensationRoot>>(
    handle: H,
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  /**
   * Resolve a branch handle created in this scope or an ancestor scope.
   *
   * For `BranchHandle`s, enforces at compile time that the handle's scope path
   * is a prefix of the current scope path.
   *
   * Use `ctx.execute()` for lazy (not-yet-running) handles.
   */
  join<H extends DeterministicAwaitable<any, CompensationRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): H extends DeterministicAwaitable<infer T, any>
    ? Promise<T>
    : Promise<never>;

  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        CompensationRoot
      >,
    ) => Promise<R>,
  ): DeterministicAwaitable<R, CompensationRoot>;

  scope<
    Name extends string,
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          AppendBranchKey<AppendScopeName<TScopePath, Name>, string>
        >,
      ) => Promise<unknown>
    >,
    R,
    TDefault,
  >(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        CompensationRoot
      >,
    ) => Promise<R>,
    defaultValue: TDefault,
  ): DeterministicAwaitable<R | TDefault, CompensationRoot>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.execute(ctx.all(entries))`.
   */
  all<
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
  >(
    entries: E,
  ): DeterministicAwaitable<
    { [K in keyof E]: Awaited<ReturnType<E[K]>> },
    CompensationRoot
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Resolve: `await ctx.execute(ctx.first(entries))`.
   * Returns `{ key, result }` discriminated union.
   *
   * On `CompensationConcurrencyContext`, `defaultValue` is required — compensation
   * must always produce a meaningful result even if all branches fail.
   */
  first<
    E extends Record<
      string,
      (
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          any
        >,
      ) => Promise<unknown>
    >,
    TDefault,
  >(
    entries: E,
    defaultValue: TDefault,
  ): DeterministicAwaitable<FirstResult<E> | TDefault, CompensationRoot>;

  /**
   * Create a listener for concurrent channel waiting.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;

  /**
   * Create a selection for concurrent waiting over scope branch handles and
   * channels.
   */
  select<M extends Record<string, ScopeSelectableHandle>>(
    handles: ScopeSelectableRecordForPath<M, TScopePath>,
  ): CompensationSelection<ScopeSelectableRecordForPath<M, TScopePath>>;

  /**
   * Iterate over a compensation selection, yielding `{ key, result }` for each event.
   * Branch failures auto-terminate the compensation scope.
   */
  match<M extends Record<string, ScopeSelectableHandle>>(
    sel: CompensationSelection<M>,
  ): AsyncIterable<SelectDataKeyedUnion<M>>;

  /**
   * Iterate over a compensation selection with a default failure handler.
   */
  match<
    M extends Record<string, ScopeSelectableHandle>,
    DF extends () => any,
  >(
    sel: CompensationSelection<M>,
    onFailure: DF,
  ): AsyncIterable<
    MatchReturn<M, Record<never, never>, Awaited<ReturnType<DF>>>
  >;

  /**
   * Iterate over a compensation selection with per-key handlers.
   */
  match<
    M extends Record<string, ScopeSelectableHandle>,
    H extends MatchHandlers<M>,
  >(
    sel: CompensationSelection<M>,
    handlers: H,
  ): AsyncIterable<MatchReturn<M, H>>;

  /**
   * Iterate over a compensation selection with per-key handlers and a default failure handler.
   */
  match<
    M extends Record<string, ScopeSelectableHandle>,
    H extends MatchHandlers<M>,
    DF extends () => any,
  >(
    sel: CompensationSelection<M>,
    handlers: H,
    onFailure: DF,
  ): AsyncIterable<MatchReturn<M, H, Awaited<ReturnType<DF>>>>;
}

// =============================================================================
// TYPE HELPERS (workflow inference — used by context accessors above)
// =============================================================================

/**
 * Extract result type from a workflow definition or header (decoded — z.output).
 */
type InferWorkflowResult<W> = W extends {
  result?: infer TResultSchema;
}
  ? TResultSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TResultSchema>
    : void
  : void;

/**
 * Extract channels from a workflow definition or header.
 */
type InferWorkflowChannels<W> = W extends {
  channels?: infer TChannels;
}
  ? TChannels extends ChannelDefinitions
    ? TChannels
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract arg input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.args.
 */
type InferWorkflowArgsInput<W> = W extends { args?: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TArgSchema>
    : void
  : void;

/**
 * Extract metadata input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.metadata.
 */
type InferWorkflowMetadataInput<W> = W extends {
  metadata?: infer TMetadataSchema;
}
  ? TMetadataSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TMetadataSchema>
    : void
  : void;
