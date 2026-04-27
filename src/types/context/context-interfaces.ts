import type { StandardSchemaV1 } from "../standard-schema";
import type { BranchDefinitions } from "../definitions/branches";
import type { ErrorDefinitions, BranchErrorMode, ExplicitBranchErrorDefinitions } from "../definitions/errors";
import type { PatchAccessor, ChannelDefinitions, EventDefinitions, PatchDefinitions, StreamDefinitions } from "../definitions/primitives";
import type { RequestDefinition, RequestDefinitions } from "../definitions/requests";
import type { RngAccessors, RngDefinitions } from "../definitions/rng";
import type { StepDefinition, StepDefinitions } from "../definitions/steps";
import type { WorkflowDefinitions } from "../definitions/workflow-headers";
import type { ErrorValue, EventCheckResult, ExplicitError, EventWaitResult, EventWaitResultNoTimeout, WorkflowResult } from "../results";
import type { ChildWorkflowAccessor, CompensationChildWorkflowAccessor, CompensationWorkflowCall, ForeignWorkflowAccessor, RequestAccessor } from "./call-builders";
import type { AtomicResult, BlockingResult, CompensationResolver, CompensationRoot, ExecutionResolver, ExecutionRoot } from "./deterministic-handles";
import type { AwaitableEntry, JoinOptions, JoinResult, JoinTimeoutResult, SchemaInvocationInput, StepAccessor } from "./entries";
import type { ChannelHandle, EventAccessor, StreamAccessor } from "./io-accessors";
import type { Listener, ListenableHandle, ScopeSelectableHandle, ScopeSelectableRecordForPath, Selection, CompensationSelection } from "./selection";
import type { ScheduleHandle, ScheduleOptions, WorkflowLogger } from "./schedule-logger";
import type { AppendScopeName, IsJoinableByPath, ScopeNameArg, ScopePath } from "./scope-path";
import type { BranchAccessor, BranchEntry, FirstResult, KeyedSuccess, MatchEvents, NoBranchCompleted, QuorumNotMet, ScopeEntryValidation, ScopeHandles, ScopeSuccessResults, SomeBranchesFailed } from "./scope-results";

export type ErrorFactories<TErrors extends ErrorDefinitions> = {
  [K in keyof TErrors & string]: TErrors[K] extends true
    ? (message: string) => ExplicitError<K, undefined>
    : TErrors[K] extends StandardSchemaV1<unknown, unknown>
      ? (
          message: string,
          details: SchemaInvocationInput<TErrors[K]>,
        ) => ExplicitError<K, StandardSchemaV1.InferOutput<TErrors[K]>>
      : never;
};

export interface BranchContext<
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TErrors extends BranchErrorMode = Record<string, never>,
> {
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema,
      any
    >
      ? StepAccessor<TArgs, StandardSchemaV1.InferOutput<TResultSchema>>
      : never;
  };
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      infer TPayload,
      infer TResponseSchema,
      any
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };
  readonly errors: ErrorFactories<ExplicitBranchErrorDefinitions<TErrors>>;
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
  sleep(seconds: number): BlockingResult<void>;

  /**
   * Durable sleep until a target instant.
   * @param target - Target time as Date or epoch milliseconds.
   */
  sleepUntil(target: Date | number): BlockingResult<void>;

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
 * Context available inside compensation blocks and failed/terminated settle hooks.
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
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
>
  extends
    BaseContext<TState, TChannels, TStreams, TEvents, TPatches, TRng>,
    CompensationResolver {
  /**
   * Steps for durable operations.
   * Calling a step returns `CompensationStepCall<T>` — awaits to `CompensationStepResult<T>`.
   * Must handle failures gracefully — compensation cannot crash.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema,
      any
    >
      ? StepAccessor<TArgs, StandardSchemaV1.InferOutput<TResultSchema>>
      : never;
  };

  /**
   * Requests for external request-response work.
   */
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      infer TPayload,
      infer TResponseSchema,
      any
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
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
   * Resolve a branch handle created in an ancestor scope from within a branch
   * closure of a nested compensation scope.
   *
   * Branch closures receive a path-specialized `CompensationContext` whose
   * `TScopePath` extends the parent scope's path. `join` enforces at compile
   * time that the handle's scope path is a prefix of the current scope path —
   * guaranteeing the handle was created in a scope that is still live (i.e. an
   * ancestor of the current branch).
   *
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles such as steps,
   * child workflows, and `scope()`/`all()`/`first()` results.
   */
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

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
   * Resolve the scope result: `await ctx.scope("Name", entries, callback).resolve(ctx)`.
   *
   * Use `.failure(cb)` to handle scope failures after unwinding.
   */
  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
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
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

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
 * Resolve handles with `handle.resolve(ctx)`. Inside scope callbacks, use
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
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TErrors extends ErrorDefinitions = Record<string, never>,
  TBranches extends BranchDefinitions = Record<string, never>,
>
  extends
    BaseContext<TState, TChannels, TStreams, TEvents, TPatches, TRng>,
    ExecutionResolver {
  /**
   * Steps for durable operations.
   * Calling a step returns a `StepCall<T>` thenable — chain builders before executing.
   * Without `.failure()`, failure auto-terminates the workflow.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema,
      any
    >
      ? StepAccessor<TArgs, StandardSchemaV1.InferOutput<TResultSchema>>
      : never;
  };

  /**
   * Requests for external request-response work.
   */
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      infer TPayload,
      infer TResponseSchema,
      any
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
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
        TRequests,
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

  /** Workflow-local business error factories. */
  readonly errors: ErrorFactories<TErrors>;

  /** Predefined workflow branch accessors. */
  readonly branches: {
    [K in keyof TBranches]: BranchAccessor<
      TBranches[K],
      TScopePath,
      ExecutionRoot
    >;
  };

  // ---------------------------------------------------------------------------
  // execute — resolve a deterministic handle
  // ---------------------------------------------------------------------------

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
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles such as steps,
   * child workflows, and `scope()`/`all()`/`first()` results.
   */
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

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
   * Resolve the scope result: `await ctx.scope("Name", entries, callback).resolve(ctx)`.
   *
   * Use `.failure(cb)` to handle scope failures after unwinding.
   */
  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
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
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

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

// =============================================================================
// WORKFLOW CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in workflow execution.
 *
 * Exposes full branch-aware concurrency primitives (`select`, `match`) and is
 * provided only as the first argument to `WorkflowContext.scope(...)`.
 * Use `handle.resolve(ctx)` for lazy handles (steps, child workflows, scope/all/first)
 * and `ctx.join()` for already-running `BranchHandle`s.
 */
export interface WorkflowConcurrencyContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TErrors extends ErrorDefinitions = Record<string, never>,
  TBranches extends BranchDefinitions = Record<string, never>,
>
  extends
    Omit<
      WorkflowContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        TScopePath,
        TErrors,
        TBranches
      >,
      "scope" | "listen" | "join"
    >,
    ExecutionResolver {
  /**
   * Resolve a branch handle created in this scope or an ancestor scope.
   *
   * For `BranchHandle`s, enforces at compile time that the handle's scope path
   * is a prefix of the current scope path — preventing handles from escaping
   * their intended lifetime.
   *
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles like steps and child workflows.
   */
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
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
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

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
  match<E>(
    handles: E,
    ..._check: ScopeEntryValidation<E>
  ): AsyncIterable<MatchEvents<E>>;
}

// =============================================================================
// COMPENSATION CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in compensation execution.
 *
 * Exposes full branch-aware concurrency primitives (`select`, `match`) and is
 * provided only as the first argument to `CompensationContext.scope(...)`.
 * Use `handle.resolve(ctx)` for lazy handles (steps, child workflows, scope/all/first)
 * and `ctx.join()` for already-running `BranchHandle`s.
 */
export interface CompensationConcurrencyContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
>
  extends
    Omit<
      CompensationContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        TScopePath
      >,
      "scope" | "listen" | "join"
    >,
    CompensationResolver {
  /**
   * Resolve a branch handle created in this scope or an ancestor scope.
   *
   * For `BranchHandle`s, enforces at compile time that the handle's scope path
   * is a prefix of the current scope path.
   *
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles.
   */
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
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
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

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
  match<E>(
    handles: E,
    ..._check: ScopeEntryValidation<E>
  ): AsyncIterable<MatchEvents<E>>;
}
