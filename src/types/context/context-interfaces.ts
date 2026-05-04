import type { StandardSchemaV1 } from "../standard-schema";
import type { ErrorDefinitions } from "../definitions/errors";
import type { PatchAccessor, ChannelDefinitions, EventDefinitions, PatchDefinitions, StreamDefinitions } from "../definitions/primitives";
import type { RequestDefinition, RequestDefinitions } from "../definitions/requests";
import type { RngAccessors, RngDefinitions } from "../definitions/rng";
import type { StepDefinition, StepDefinitions } from "../definitions/steps";
import type { WorkflowDefinitions } from "../definitions/workflow-headers";
import type { ExplicitError } from "../results";
import type { ChildWorkflowAccessor, CompensationChildWorkflowAccessor, ForeignWorkflowAccessor, RequestAccessor } from "./call-builders";
import type { BlockingResult, CompensationResolver, ExecutionResolver } from "./deterministic-handles";
import type { AwaitableEntry, JoinOptions, JoinResult, JoinTimeoutResult, SchemaInvocationInput, StepAccessor } from "./entries";
import type { ChannelHandle, EventAccessor, StreamAccessor } from "./io-accessors";
import type { Listener, ListenableHandle } from "./selection";
import type { ScheduleHandle, ScheduleOptions, WorkflowLogger } from "./schedule-logger";
import type { AppendScopeName, ScopeNameArg, ScopePath } from "./scope-path";
import type { FirstResult, KeyedSuccess, MatchEvents, NoEntryCompleted, QuorumNotMet, ScopeEntryValidation, ScopeHandles, ScopeSuccessResults, SomeEntriesFailed } from "./scope-results";

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

// =============================================================================
// BASE CONTEXT (shared between WorkflowContext and CompensationContext)
// =============================================================================

/**
 * Base context shared between WorkflowContext and CompensationContext.
 * Contains primitives that are identical between the two contexts.
 */
export interface BaseContext<
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
 * Context available inside compensation `undo` callbacks.
 *
 * Compensation has no `ctx.errors` — outcomes are reported via the optional
 * `result` schema declared on the compensation definition. Compensation's
 * dispatched dependencies are non-compensable steps and requests, queues,
 * topics, and child workflows.
 */
export interface CompensationContext<
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
    BaseContext<TChannels, TStreams, TEvents, TPatches, TRng>,
    CompensationResolver {
  /**
   * Steps for durable operations.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      any,
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
      any,
      infer TPayload,
      infer TResponseSchema,
      any
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };

  /**
   * Child workflows.
   */
  readonly childWorkflows: {
    [K in keyof TChildWorkflows]: CompensationChildWorkflowAccessor<
      TChildWorkflows[K]
    >;
  };

  /**
   * Foreign workflow accessors — message-only handles to existing workflow instances.
   */
  readonly foreignWorkflows: {
    [K in keyof TForeignWorkflows]: ForeignWorkflowAccessor<
      TForeignWorkflows[K]
    >;
  };

  // ---------------------------------------------------------------------------
  // join — observe a single dispatched entry
  // ---------------------------------------------------------------------------

  join<H extends AwaitableEntry<any>>(handle: H): Promise<JoinResult<H>>;
  join<H extends AwaitableEntry<any>>(
    handle: H,
    opts: JoinOptions,
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency
  // ---------------------------------------------------------------------------

  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
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
      handles: ScopeHandles<E>,
    ) => Promise<R>,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeEntriesFailed<E> }
  >;

  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoEntryCompleted<E> }
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

  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;
}

// =============================================================================
// WORKFLOW CONTEXT
// =============================================================================

/**
 * Workflow context provided to the execute function.
 *
 * The body is a single sequential program. Concurrency comes from dispatched
 * entries (steps, requests, attached child workflows) which the body may
 * directly `await` or pass through `ctx.scope` / `ctx.all` / `ctx.first` /
 * `ctx.atLeast` / `ctx.atMost` / `ctx.some` for structured-concurrency
 * orchestration.
 */
export interface WorkflowContext<
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
>
  extends
    BaseContext<TChannels, TStreams, TEvents, TPatches, TRng>,
    ExecutionResolver {
  /**
   * Steps for durable operations.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      any,
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
      any,
      infer TPayload,
      infer TResponseSchema,
      any
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };

  /**
   * Child workflow accessors — structured invocation (lifecycle managed by parent).
   */
  readonly childWorkflows: {
    [K in keyof TChildWorkflows]: ChildWorkflowAccessor<
      TChildWorkflows[K],
      CompensationContext<
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
   */
  readonly foreignWorkflows: {
    [K in keyof TForeignWorkflows]: ForeignWorkflowAccessor<
      TForeignWorkflows[K]
    >;
  };

  /** Workflow-local business error factories. */
  readonly errors: ErrorFactories<TErrors>;

  // ---------------------------------------------------------------------------
  // join — observe a single dispatched entry
  // ---------------------------------------------------------------------------

  join<H extends AwaitableEntry<any>>(handle: H): Promise<JoinResult<H>>;
  join<H extends AwaitableEntry<any>>(
    handle: H,
    opts: JoinOptions,
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  /**
   * Create a cron-like schedule handle for recurring execution.
   */
  schedule(expression: string, options?: ScheduleOptions): ScheduleHandle;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency
  // ---------------------------------------------------------------------------

  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>,
        TErrors
      >,
      handles: ScopeHandles<E>,
    ) => Promise<R>,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeEntriesFailed<E> }
  >;

  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoEntryCompleted<E> }
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

  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;

  /**
   * Iterate over scope entry completions, yielding `{ key, ... }` events per
   * top-level object property. Tuples add `index`; maps add `mapKey`.
   */
  match<E>(
    handles: E,
    ..._check: ScopeEntryValidation<E>
  ): AsyncIterable<MatchEvents<E>>;
}

// =============================================================================
// WORKFLOW CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in workflow execution.
 *
 * Provided as the first argument to `WorkflowContext.scope(...)`. Same surface
 * as `WorkflowContext` minus `schedule`; the scope path is extended by the
 * scope name.
 */
export interface WorkflowConcurrencyContext<
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
>
  extends
    Omit<
      WorkflowContext<
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
        TErrors
      >,
      "schedule"
    > {}

// =============================================================================
// COMPENSATION CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in compensation execution.
 *
 * Same surface as `CompensationContext`; the scope path is extended by the
 * scope name.
 */
export interface CompensationConcurrencyContext<
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
    CompensationContext<
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
    > {
  /**
   * Iterate over scope entry completions, yielding `{ key, ... }` events.
   */
  match<E>(
    handles: E,
    ..._check: ScopeEntryValidation<E>
  ): AsyncIterable<MatchEvents<E>>;
}
