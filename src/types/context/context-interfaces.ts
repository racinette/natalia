import type { HasDefaultTtl } from "../helpers";
import type { JsonSchemaConstraint } from "../json-input";
import type { StandardSchemaV1 } from "../standard-schema";
import type { ErrorDefinitions } from "../definitions/errors";
import type { PatchAccessor, AttributeDefinitions, ChannelDefinitions, EventDefinitions, PatchDefinitions, StreamDefinitions } from "../definitions/primitives";
import type { QueueDefinition, QueueDefinitions, TopicDefinition, TopicDefinitions } from "../definitions/messaging";
import type { RequestDefinition, RequestDefinitions } from "../definitions/requests";
import type { RngAccessors, RngDefinitions } from "../definitions/rng";
import type {
  CompensationInfo,
  StepDefinition,
  StepDefinitions,
} from "../definitions/steps";
import type { WorkflowDefinitions } from "../definitions/workflow-headers";
import type { ExplicitError } from "../results";
import type {
  ChildWorkflowUnifiedAccessor,
  CompensationChildWorkflowAccessor,
  ExternalWorkflowAccessor,
  QueueAccessor,
  RequestAccessor,
  TopicAccessor,
} from "./call-builders";
import type { BlockingResult, CompensationResolver, ExecutionResolver } from "./deterministic-handles";
import type { AwaitableEntry, JoinOptions, JoinResult, JoinTimeoutResult, SchemaInvocationInput, StepAccessor } from "./entries";
import type { ChannelHandle, EventAccessor, StreamAccessor, AttributeAccessor } from "./io-accessors";
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
  TAttributes extends AttributeDefinitions = Record<string, never>,
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
   * Observable single current values (set-only from inside the body).
   */
  readonly attributes: {
    [K in keyof TAttributes]: AttributeAccessor<
      StandardSchemaV1.InferInput<TAttributes[K]>
    >;
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
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TTopics extends TopicDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TForwardResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
>
  extends
    BaseContext<TChannels, TStreams, TEvents, TPatches, TRng, TAttributes>,
    CompensationResolver {
  /** Original forward step args (decoded). */
  readonly args: StandardSchemaV1.InferOutput<TArgsSchema>;
  /** Forward step settlement snapshot. */
  readonly info: CompensationInfo<
    StandardSchemaV1.InferOutput<TForwardResultSchema>
  >;
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
   * Requests for externalWorkflows request-response work.
   */
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      any,
      infer TPayload,
      infer TResponseSchema,
      any,
      any
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };

  /**
   * Queues for durable enqueue from compensation undo paths.
   */
  readonly queues: {
    [K in keyof TQueues]: TQueues[K] extends QueueDefinition<
      any,
      infer TMessageSchema,
      any,
      any
    >
      ? HasDefaultTtl<TQueues[K]> extends true
        ? QueueAccessor<TMessageSchema, true>
        : QueueAccessor<TMessageSchema, false>
      : never;
  };
   

  /**
   * Topics for durable publish from compensation undo paths.
   */
  readonly topics: {
    [K in keyof TTopics]: TTopics[K] extends TopicDefinition<
      any,
      infer TRecordSchema,
      infer TMetadataSchema
    >
      ? TopicAccessor<TRecordSchema, TMetadataSchema>
      : never;
  };

  /**
   * Child workflows. One accessor per declared child — the call runs it
   * attached under the parent (full `WorkflowResult` awaited in compensation).
   */
  readonly childWorkflows: {
    [K in keyof TChildren]: CompensationChildWorkflowAccessor<TChildren[K]>;
  };

  /**
   * External workflow accessors — independent roots to reference (`.get`) or
   * create (`.start`).
   */
  readonly externalWorkflows: {
    [K in keyof TExternalWorkflows]: ExternalWorkflowAccessor<
      TExternalWorkflows[K]
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
        TAttributes,
        TSteps,
        TRequests,
        TQueues,
        TTopics,
        TChildren,
        TExternalWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>,
        TArgsSchema,
        TForwardResultSchema
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
 * entries (steps, requests, child workflows) which the body may
 * directly `await` or pass through `ctx.scope` / `ctx.all` / `ctx.first` /
 * `ctx.atLeast` / `ctx.atMost` / `ctx.some` for structured-concurrency
 * orchestration.
 *
 * Child workflow calls (`ctx.childWorkflows.<name>(...)`) return an await-only
 * entry in the body; use `ctx.scope` + `ctx.join` when the parent must
 * `channels.*.send` while the child runs (see `AttachedChildWorkflowScopeHandle`
 * in `call-builders.ts`).
 */
export interface WorkflowContext<
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TTopics extends TopicDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TErrors extends ErrorDefinitions = Record<string, never>,
  TArgsSchema extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
>
  extends
    BaseContext<TChannels, TStreams, TEvents, TPatches, TRng, TAttributes>,
    ExecutionResolver {
  /** Decoded workflow args (from the workflow's declared `args` schema). */
  readonly args: StandardSchemaV1.InferOutput<TArgsSchema>;

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
   * Requests for externalWorkflows request-response work.
   */
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      any,
      infer TPayload,
      infer TResponseSchema,
      any,
      any
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };

  /**
   * Queues for durable enqueue from workflow bodies and compensation undo paths.
   */
  readonly queues: {
    [K in keyof TQueues]: TQueues[K] extends QueueDefinition<
      any,
      infer TMessageSchema,
      any,
      any
    >
      ? HasDefaultTtl<TQueues[K]> extends true
        ? QueueAccessor<TMessageSchema, true>
        : QueueAccessor<TMessageSchema, false>
      : never;
  };
   

  /**
   * Topics for durable publish from workflow bodies.
   */
  readonly topics: {
    [K in keyof TTopics]: TTopics[K] extends TopicDefinition<
      any,
      infer TRecordSchema,
      infer TMetadataSchema
    >
      ? TopicAccessor<TRecordSchema, TMetadataSchema>
      : never;
  };

  /**
   * Child workflow accessors. One accessor per declared child — the call
   * runs it parent-owned and awaitable.
   */
  readonly childWorkflows: {
    [K in keyof TChildren]: ChildWorkflowUnifiedAccessor<TChildren[K]>;
  };

  /**
   * External workflow accessors — independent roots to reference (`.get`) or
   * create (`.start`).
   */
  readonly externalWorkflows: {
    [K in keyof TExternalWorkflows]: ExternalWorkflowAccessor<
      TExternalWorkflows[K]
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
        TAttributes,
        TSteps,
        TRequests,
        TQueues,
        TTopics,
        TChildren,
        TExternalWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>,
        TErrors,
        TArgsSchema
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

/**
 * Scope-local context — {@link WorkflowContext} minus `schedule`.
 *
 * Nesting only extends `TScopePath`; definition generics and `args` are unchanged.
 */
export type WorkflowConcurrencyContext<
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TTopics extends TopicDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TErrors extends ErrorDefinitions = Record<string, never>,
  TArgsSchema extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
> = Omit<
  WorkflowContext<
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
    TSteps,
    TRequests,
    TQueues,
    TTopics,
    TChildren,
    TExternalWorkflows,
    TPatches,
    TRng,
    TScopePath,
    TErrors,
    TArgsSchema
  >,
  "schedule"
>;

/**
 * Workflow context for the `execute` callback — root scope path (`[]`), includes `schedule`.
 */
export type WorkflowExecuteContext<
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TTopics extends TopicDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TArgsSchema extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
> = WorkflowContext<
  TChannels,
  TStreams,
  TEvents,
  TAttributes,
  TSteps,
  TRequests,
  TQueues,
  TTopics,
  TChildren,
  TExternalWorkflows,
  TPatches,
  TRng,
  [],
  TErrors,
  TArgsSchema
>;

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
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TTopics extends TopicDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TForwardResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
>
  extends
    CompensationContext<
      TChannels,
      TStreams,
      TEvents,
      TAttributes,
      TSteps,
      TRequests,
      TQueues,
      TTopics,
      TChildren,
      TExternalWorkflows,
      TPatches,
      TRng,
      TScopePath,
      TArgsSchema,
      TForwardResultSchema
    > {
  /**
   * Iterate over scope entry completions, yielding `{ key, ... }` events.
   */
  match<E>(
    handles: E,
    ..._check: ScopeEntryValidation<E>
  ): AsyncIterable<MatchEvents<E>>;
}

/**
 * Compensation context for the `undo` callback — root scope path (`[]`),
 * includes forward `args` and settlement `info`.
 */
export type StepCompensationUndoContext<
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TTopics extends TopicDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TForwardResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
> = CompensationContext<
  TChannels,
  TStreams,
  TEvents,
  TAttributes,
  TSteps,
  TRequests,
  TQueues,
  TTopics,
  TChildren,
  TExternalWorkflows,
  TPatches,
  TRng,
  [],
  TArgsSchema,
  TForwardResultSchema
>;
