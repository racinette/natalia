import type { StandardSchemaV1 } from "./standard-schema";
import type {
  ChannelDefinitions,
  EventDefinitions,
  StreamDefinitions,
} from "./definitions/primitives";
import type {
  DeadlineOptions,
  RetentionSetter,
  WorkflowInvocationBaseOptions,
} from "./definitions/policies";
import type { AnyPublicWorkflowHeader } from "./definitions/workflow-headers";
import type { AnyWorkflowDefinition } from "./definitions/workflow-definition";
import type {
  AttachedChildWorkflowId,
  CompensationBlockRow,
  CompensationBlockWhereTemplate,
  RequestCompensationRow,
  RequestCompensationWhereTemplate,
  WorkflowWhereTemplate,
  WorkflowRow,
} from "./schema";
import type {
  ChannelSendResult,
  CompensationBlockOperatorActions,
  CompensationId,
  ErrorValue,
  EventCheckResult,
  EventWaitResultNoTimeout,
  ExternalWaitOptions,
  HaltRecord,
  IWorkflowConnection,
  IWorkflowTransaction,
  StreamIteratorReadResult,
  StreamOpenResult,
  StreamReadResult,
  WorkflowOperatorActions,
  WorkflowResult,
  AttemptAccessor,
  SkipOutcome,
  OperatorActionOptions,
} from "./results";
import type { RequestCompensationInfo } from "./definitions/steps";
import type { RequestCompensationInstanceId } from "./schema";
import type {
  CountOptions,
  FetchableHandle,
  FetchOptions,
  FieldsMask,
  FindManyOptions,
  FindManyResult,
  FindUniqueOptions,
  FindUniqueResult,
  HandleWithRow,
  ProjectedKeys,
  QueryableNamespace,
  QueryPredicate,
} from "./introspection";
import type {
  InferWorkflowArgs,
  InferWorkflowArgsInput,
  InferWorkflowChildWorkflows,
  InferWorkflowChannels,
  InferWorkflowErrors,
  InferWorkflowEvents,
  InferWorkflowMetadata,
  InferWorkflowMetadataInput,
  InferWorkflowRequests,
  InferWorkflowResult,
  InferWorkflowSteps,
  InferWorkflowStreams,
} from "./helpers";
import type { StepCompensationDefinition, StepDefinition } from "./definitions/steps";
import type {
  RequestCompensationConfig,
  RequestDefinition,
} from "./definitions/requests";

// =============================================================================
// PRIMITIVE PLANE — channel/stream/event/attribute accessors at engine level.
//
// Step 12 keeps the existing primitive-plane shapes intact. Step 16
// (attributes + streams) refines them and introduces `attributes.X.get` /
// `getNowait` / `set` accessors. Channel send and stream read remain unchanged.
// =============================================================================

/**
 * Channel accessor at engine level.
 * T is z.input<Schema> for sending (encoded).
 */
export interface ChannelAccessorExternal<T> {
  send(
    data: T,
    opts?: { txOrConn?: IWorkflowConnection | IWorkflowTransaction },
  ): Promise<ChannelSendResult>;
}

/**
 * Event accessor at engine level (with "never" support).
 */
export interface EventAccessorExternal {
  wait(
    options?: ExternalWaitOptions & {
      txOrConn?: IWorkflowConnection | IWorkflowTransaction;
    },
  ): Promise<EventWaitResultNoTimeout>;
  isSet(opts?: {
    txOrConn?: IWorkflowConnection | IWorkflowTransaction;
  }): Promise<EventCheckResult>;
}

/**
 * Stream iterator handle at engine level.
 */
export interface StreamIteratorHandleExternal<T> extends AsyncIterable<T> {
  read(options?: ExternalWaitOptions): Promise<StreamIteratorReadResult<T>>;
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

/**
 * Stream reader at engine level.
 */
export interface StreamReaderAccessorExternal<T> extends AsyncIterable<T> {
  read(
    offset: number,
    options?: ExternalWaitOptions,
  ): Promise<StreamReadResult<T>>;
  iterator(
    startOffset?: number,
    endOffset?: number,
  ): StreamIteratorHandleExternal<T>;
  isOpen(opts?: {
    txOrConn?: IWorkflowConnection | IWorkflowTransaction;
  }): Promise<StreamOpenResult>;
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

// =============================================================================
// HALTS NAMESPACE — read-only halt observation on a workflow handle.
//
// Per `REFACTOR.MD` Part 3, execution-workflow halts are not skippable
// directly — resolution is patch + replay (automatic on worker restart) or
// `skip(...)` on the workflow handle (which transitions the workflow to
// `'skipped'` and its pending halts to `'skipped'` along with it).
// =============================================================================

export interface HaltsNamespaceExternal {
  list(opts?: FetchOptions): Promise<readonly HaltRecord[]>;
}

// =============================================================================
// COMPENSATION BLOCK INSTANCE HANDLE
// =============================================================================

/**
 * Per-instance primitive plane on a compensation block handle.
 *
 * Step 12 publishes the namespace placeholders. The full accessor surfaces
 * (`attributes.X.get`, `streams.X.read`, `events.X.wait`, `channels.X.send`)
 * land in steps 13/15/16 alongside their per-instance primitive
 * declarations on `StepCompensationDefinition` (step 08).
 *
 * Each accessor read returns `FindUniqueResult<T>` to surface row-level
 * absence and ambiguity, mirroring how the parent compensation block row is
 * looked up.
 */
export interface CompensationBlockPrimitivePlane {
  readonly attributes: Record<string, unknown>;
  readonly streams: Record<string, unknown>;
  readonly events: Record<string, unknown>;
  readonly channels: Record<string, unknown>;
}

/**
 * Operator-facing handle for a compensation block instance row.
 */
export interface CompensationBlockUniqueHandleExternal<
  TStep,
  TArgs = unknown,
  TResult = unknown,
> extends FetchableHandle<CompensationBlockRow<TStep, TArgs, TResult>>,
    CompensationBlockOperatorActions<TResult>,
    CompensationBlockPrimitivePlane {
  readonly id: CompensationId<TStep>;
}

/**
 * Per-parent compensation block instance namespace, keyed by step name on
 * `workflowInstance.compensations.steps.<step>`.
 */
export interface CompensationBlockNamespaceExternal<
  TStep,
  TArgs = unknown,
  TResult = unknown,
> extends QueryableNamespace<
    CompensationBlockUniqueHandleExternal<TStep, TArgs, TResult>,
    CompensationBlockWhereTemplate<TStep, TArgs, TResult>,
    CompensationBlockRow<TStep, TArgs, TResult>,
    CompensationId<TStep>
  > {}

// =============================================================================
// REQUEST COMPENSATION INSTANCE HANDLE
// =============================================================================

/**
 * Operator-facing handle for a request compensation invocation.
 *
 * Request compensations are lightweight — no per-instance primitives, no
 * halt records (`REFACTOR.MD` Part 11). The handle exposes:
 *   - `fetchRow` (the row scalar columns + JSONB-as-opaque `payload` /
 *     `result` columns);
 *   - `attempts()` — async accessor over the retried-handler attempt log;
 *   - `skip(result, opts?)` — operator skip with the operator-supplied
 *     compensation result.
 */
export interface RequestCompensationUniqueHandleExternal<
  TPayload = unknown,
  TCompResult = unknown,
> extends FetchableHandle<RequestCompensationRow<TPayload, TCompResult>> {
  readonly id: RequestCompensationInstanceId;

  attempts(opts?: FetchOptions): Promise<FindUniqueResult<AttemptAccessor>>;

  skip(
    ...args: [TCompResult] extends [void]
      ? [opts?: OperatorActionOptions]
      : [result: TCompResult, opts?: OperatorActionOptions]
  ): Promise<SkipOutcome>;
}

/**
 * Per-parent request compensation namespace, keyed by request name on
 * `workflowInstance.compensations.requests.<request>`.
 */
export interface RequestCompensationNamespaceExternal<
  TPayload = unknown,
  TCompResult = unknown,
> extends QueryableNamespace<
    RequestCompensationUniqueHandleExternal<TPayload, TCompResult>,
    RequestCompensationWhereTemplate<TPayload, TCompResult>,
    RequestCompensationRow<TPayload, TCompResult>,
    RequestCompensationInstanceId
  > {}

// =============================================================================
// ATTACHED / DETACHED CHILD WORKFLOW NAMESPACES
//
// Per `REFACTOR.MD` Part 5 §"External introspection of children" — operators
// inspect a parent's children through two namespaces. Attached children are
// queryable only via the parent (parent-scoped) and have a read-only handle
// (no terminal-action verbs). Detached children are real root workflows
// addressable globally; the parent-scoped namespace is a convenience filter
// that returns the standard `WorkflowHandleExternal<W>`.
// =============================================================================

/**
 * Read-only external handle for an attached child workflow row.
 *
 * Attached children are subordinate to the parent's lifecycle — operators
 * inspect them but do not terminate them. `idempotencyKey` is absent because
 * attached children are not globally addressable.
 */
export interface AttachedChildWorkflowExternalHandle<W extends AnyPublicWorkflowHeader>
  extends FetchableHandle<
    WorkflowRow<
      InferWorkflowArgs<W>,
      InferWorkflowResult<W>,
      InferWorkflowMetadata<W>
    >
  > {
  readonly id: AttachedChildWorkflowId<W>;

  readonly attributes: Record<string, unknown>;
  readonly streams: {
    [K in keyof InferWorkflowStreams<W>]: StreamReaderAccessorExternal<
      StandardSchemaV1.InferOutput<InferWorkflowStreams<W>[K]>
    >;
  };
  readonly events: {
    [K in keyof InferWorkflowEvents<W>]: EventAccessorExternal;
  };
  readonly channels: {
    [K in keyof InferWorkflowChannels<W>]: ChannelAccessorExternal<
      StandardSchemaV1.InferInput<InferWorkflowChannels<W>[K]>
    >;
  };
}

/**
 * Per-parent attached child workflow namespace, keyed by child workflow name
 * on `workflowInstance.attachedChildWorkflows.<name>`.
 */
export interface AttachedChildWorkflowNamespaceExternal<
  W extends AnyPublicWorkflowHeader,
> extends QueryableNamespace<
    AttachedChildWorkflowExternalHandle<W>,
    WorkflowWhereTemplate<
      InferWorkflowArgs<W>,
      InferWorkflowResult<W>,
      InferWorkflowMetadata<W>
    >,
    WorkflowRow<
      InferWorkflowArgs<W>,
      InferWorkflowResult<W>,
      InferWorkflowMetadata<W>
    >,
    AttachedChildWorkflowId<W>
  > {}

/**
 * Per-parent detached child workflow namespace.
 *
 * Detached children are globally addressable root workflows; the parent-scoped
 * namespace is a convenience filter that returns the standard
 * `WorkflowHandleExternal<W>`.
 */
export interface DetachedChildWorkflowNamespaceExternal<
  W extends AnyPublicWorkflowHeader,
> extends QueryableNamespace<
    WorkflowHandleExternal<W>,
    WorkflowWhereTemplate<
      InferWorkflowArgs<W>,
      InferWorkflowResult<W>,
      InferWorkflowMetadata<W>
    >,
    WorkflowRow<
      InferWorkflowArgs<W>,
      InferWorkflowResult<W>,
      InferWorkflowMetadata<W>
    >,
    AttachedChildWorkflowId<W>
  > {}

type IsAny<T> = 0 extends (1 & T) ? true : false;

type WorkflowHandleLooseChildWorkflows = Record<
  string,
  AttachedChildWorkflowNamespaceExternal<AnyPublicWorkflowHeader>
>;

type WorkflowHandleLooseDetachedChildWorkflows = Record<
  string,
  DetachedChildWorkflowNamespaceExternal<AnyPublicWorkflowHeader>
>;

type WorkflowHandleLooseCompensations = Record<
  string,
  CompensationBlockNamespaceExternal<unknown>
>;

type WorkflowHandleLooseRequestCompensations = Record<
  string,
  RequestCompensationNamespaceExternal
>;

type CompensableStepKeys<TSteps extends Record<string, unknown>> = {
  [K in keyof TSteps & string]: TSteps[K] extends { compensation: unknown } ? K : never;
}[keyof TSteps & string];

type StepArgsForCompensationNamespace<TStep> =
  TStep extends StepDefinition<any, infer TArgsSchema, any, any>
    ? StandardSchemaV1.InferOutput<TArgsSchema>
    : unknown;

type StepCompensationResultForNamespace<TStep> =
  TStep extends StepDefinition<any, any, any, infer TCompensation>
    ? TCompensation extends StepCompensationDefinition<
        any,
        any,
        any,
        any,
        any,
        any,
        any,
        any,
        any,
        any,
        any,
        infer TResultSchema
      >
      ? TResultSchema extends StandardSchemaV1<unknown, unknown>
        ? StandardSchemaV1.InferOutput<TResultSchema>
        : void
      : never
    : unknown;

type WorkflowHandleCompensationNamespaces<TSteps extends Record<string, unknown>> = {
  [K in CompensableStepKeys<TSteps>]: CompensationBlockNamespaceExternal<
    K,
    StepArgsForCompensationNamespace<TSteps[K]>,
    StepCompensationResultForNamespace<TSteps[K]>
  >;
};

type CompensableRequestKeys<TRequests extends Record<string, unknown>> = {
  [K in keyof TRequests & string]: TRequests[K] extends { compensation: unknown }
    ? K
    : never;
}[keyof TRequests & string];

type RequestPayloadForCompensationNamespace<TRequest> =
  TRequest extends RequestDefinition<any, infer TPayloadSchema, any, any>
    ? StandardSchemaV1.InferOutput<TPayloadSchema>
    : unknown;

type RequestCompensationResultForNamespace<TRequest> =
  TRequest extends RequestDefinition<any, any, any, infer TCompensation>
    ? TCompensation extends RequestCompensationConfig<infer TResultSchema>
      ? TResultSchema extends StandardSchemaV1<unknown, unknown>
        ? StandardSchemaV1.InferOutput<TResultSchema>
        : void
      : TCompensation extends true
        ? void
        : never
    : unknown;

type WorkflowHandleRequestCompensationNamespaces<
  TRequests extends Record<string, unknown>,
> = {
  [K in CompensableRequestKeys<TRequests>]: RequestCompensationNamespaceExternal<
    RequestPayloadForCompensationNamespace<TRequests[K]>,
    RequestCompensationResultForNamespace<TRequests[K]>
  >;
};

type WorkflowHandleChildWorkflowNamespaces<
  TChildWorkflows extends Record<string, unknown>,
> = {
  [K in keyof TChildWorkflows & string]: AttachedChildWorkflowNamespaceExternal<
    TChildWorkflows[K] extends AnyPublicWorkflowHeader
      ? TChildWorkflows[K]
      : AnyPublicWorkflowHeader
  >;
};

type WorkflowHandleDetachedChildWorkflowNamespaces<
  TChildWorkflows extends Record<string, unknown>,
> = {
  [K in keyof TChildWorkflows & string]: DetachedChildWorkflowNamespaceExternal<
    TChildWorkflows[K] extends AnyPublicWorkflowHeader
      ? TChildWorkflows[K]
      : AnyPublicWorkflowHeader
  >;
};

type WorkflowHandleCompensations<W extends AnyPublicWorkflowHeader> =
  InferWorkflowSteps<W> extends infer TSteps
    ? [TSteps] extends [never]
      ? WorkflowHandleLooseCompensations
      : IsAny<TSteps> extends true
        ? WorkflowHandleLooseCompensations
        : TSteps extends Record<string, unknown>
          ? WorkflowHandleCompensationNamespaces<TSteps>
          : WorkflowHandleLooseCompensations
    : WorkflowHandleLooseCompensations;

type WorkflowHandleRequestCompensations<W extends AnyPublicWorkflowHeader> =
  InferWorkflowRequests<W> extends infer TRequests
    ? [TRequests] extends [never]
      ? WorkflowHandleLooseRequestCompensations
      : IsAny<TRequests> extends true
        ? WorkflowHandleLooseRequestCompensations
        : TRequests extends Record<string, unknown>
          ? WorkflowHandleRequestCompensationNamespaces<TRequests>
          : WorkflowHandleLooseRequestCompensations
    : WorkflowHandleLooseRequestCompensations;

type WorkflowHandleCompensationsTree<W extends AnyPublicWorkflowHeader> = {
  readonly steps: WorkflowHandleCompensations<W>;
  readonly requests: WorkflowHandleRequestCompensations<W>;
};

type WorkflowHandleCompensationsRoot<W extends AnyPublicWorkflowHeader> =
  WorkflowHandleCompensationsTree<W>;

type WorkflowHandleChildWorkflows<W extends AnyPublicWorkflowHeader> =
  InferWorkflowChildWorkflows<W> extends infer TChildWorkflows
    ? [TChildWorkflows] extends [never]
      ? WorkflowHandleLooseChildWorkflows
      : IsAny<TChildWorkflows> extends true
        ? WorkflowHandleLooseChildWorkflows
        : TChildWorkflows extends Record<string, unknown>
          ? WorkflowHandleChildWorkflowNamespaces<TChildWorkflows>
          : WorkflowHandleLooseChildWorkflows
    : WorkflowHandleLooseChildWorkflows;

type WorkflowHandleDetachedChildWorkflows<W extends AnyPublicWorkflowHeader> =
  InferWorkflowChildWorkflows<W> extends infer TChildWorkflows
    ? [TChildWorkflows] extends [never]
      ? WorkflowHandleLooseDetachedChildWorkflows
      : IsAny<TChildWorkflows> extends true
        ? WorkflowHandleLooseDetachedChildWorkflows
        : TChildWorkflows extends Record<string, unknown>
          ? WorkflowHandleDetachedChildWorkflowNamespaces<TChildWorkflows>
          : WorkflowHandleLooseDetachedChildWorkflows
    : WorkflowHandleLooseDetachedChildWorkflows;

// =============================================================================
// WORKFLOW HANDLE — globally addressable workflows.
//
// `WorkflowHandleExternal<W>` is parameterised over a workflow header so all
// the per-workflow types (channels, streams, events, args, result, metadata,
// errors) flow from one source. Replaces the earlier 5-generic shape.
// =============================================================================

export interface WorkflowHandleExternal<W extends AnyPublicWorkflowHeader>
  extends FetchableHandle<
      WorkflowRow<
        InferWorkflowArgs<W>,
        InferWorkflowResult<W>,
        InferWorkflowMetadata<W>
      >
    >,
    WorkflowOperatorActions<InferWorkflowResult<W>> {
  readonly id: import("./schema").WorkflowId;

  readonly idempotencyKey: string;

  // Primitive plane.
  readonly attributes: Record<string, unknown>;
  readonly streams: {
    [K in keyof InferWorkflowStreams<W>]: StreamReaderAccessorExternal<
      StandardSchemaV1.InferOutput<InferWorkflowStreams<W>[K]>
    >;
  };
  readonly events: {
    [K in keyof InferWorkflowEvents<W>]: EventAccessorExternal;
  };
  readonly channels: {
    [K in keyof InferWorkflowChannels<W>]: ChannelAccessorExternal<
      StandardSchemaV1.InferInput<InferWorkflowChannels<W>[K]>
    >;
  };

  // Halts.
  readonly halts: HaltsNamespaceExternal;

  // Per-parent introspection namespaces.
  readonly attachedChildWorkflows: WorkflowHandleChildWorkflows<W>;
  readonly detachedChildWorkflows: WorkflowHandleDetachedChildWorkflows<W>;
  readonly compensations: WorkflowHandleCompensationsRoot<W>;

  /**
   * Wait for the workflow to reach a terminal state. Resolves to a typed
   * `WorkflowResult` carrying the success / failure / terminated outcome.
   *
   * Useful for already-started workflows. `client.workflows.<def>.execute(opts)`
   * is the equivalent start+wait one-shot.
   */
  wait(
    options?: ExternalWaitOptions & {
      txOrConn?: IWorkflowConnection | IWorkflowTransaction;
    },
  ): Promise<WorkflowResult<InferWorkflowResult<W>, ErrorValue<InferWorkflowErrors<W>>>>;

  /**
   * Update the retention policy for this workflow instance.
   */
  setRetention(
    retention: number | RetentionSetter<"complete" | "failed" | "terminated">,
    opts?: { txOrConn?: IWorkflowConnection | IWorkflowTransaction },
  ): Promise<void>;
}

// =============================================================================
// START WORKFLOW OPTIONS
// =============================================================================

/**
 * Options for starting a workflow at engine / client level.
 */
export type StartWorkflowOptions<
  TArgsInput,
  TMetadataInput = void,
> = WorkflowInvocationBaseOptions<TArgsInput, TMetadataInput> & {
  retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
  txOrConn?: IWorkflowConnection | IWorkflowTransaction;
} & DeadlineOptions;

// =============================================================================
// CLIENT-LEVEL WORKFLOW ACCESSOR
//
// Per `REFACTOR.MD` Part 5 §"`client.workflows.<def>` surface" — gain the
// unified queryable namespace surface alongside `start` / `execute` / `get`.
//
// `findMany` automatically excludes attached children (Part 5 §"Global
// queries filter out attached children" — the filter is a runtime guarantee;
// the type-level surface returns the same `WorkflowHandleExternal<W>` shape
// regardless).
// =============================================================================

export interface WorkflowClientAccessor<W extends AnyPublicWorkflowHeader>
  extends Omit<
    QueryableNamespace<
      WorkflowHandleExternal<W>,
      WorkflowWhereTemplate<
        InferWorkflowArgs<W>,
        InferWorkflowResult<W>,
        InferWorkflowMetadata<W>
      >,
      WorkflowRow<
        InferWorkflowArgs<W>,
        InferWorkflowResult<W>,
        InferWorkflowMetadata<W>
      >,
      never
    >,
    "get"
  > {
  /**
   * Start a new instance of this workflow and return a typed external handle.
   */
  start(
    options: StartWorkflowOptions<
      InferWorkflowArgsInput<W>,
      InferWorkflowMetadataInput<W>
    >,
  ): Promise<WorkflowHandleExternal<W>>;

  /**
   * Start and wait for the workflow's terminal outcome (start + handle.wait()
   * one-shot convenience).
   */
  execute(
    options: StartWorkflowOptions<
      InferWorkflowArgsInput<W>,
      InferWorkflowMetadataInput<W>
    >,
  ): Promise<
    WorkflowResult<InferWorkflowResult<W>, ErrorValue<InferWorkflowErrors<W>>>
  >;

  /**
   * Get an external handle to an existing workflow instance by its
   * idempotency key. Synchronous; no I/O.
   */
  get(idempotencyKey: string): WorkflowHandleExternal<W>;
}

/**
 * Client-facing workflow API surface shared by dedicated clients and the engine.
 */
export interface WorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader> = Record<string, never>,
> {
  readonly workflows: {
    [K in keyof TWfs]: WorkflowClientAccessor<TWfs[K]>;
  };
}

/**
 * Workflow accessor specialization used by the executable engine.
 * Restricts registrations to full workflow definitions.
 */
export interface EngineWorkflowAccessor<W extends AnyWorkflowDefinition>
  extends WorkflowClientAccessor<W> {}
