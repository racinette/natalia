import type { ErrorDefinitions } from "./definitions/errors";
import type { RequestCompensationDefinition } from "./definitions/requests";
import type { JsonSchemaConstraint } from "./json-input";
import type { StandardSchemaV1 } from "./standard-schema";
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
  DeadLetterId,
  DeadLetterRow,
  DeadLetterWhereTemplate,
  RequestId,
  RequestRow,
  RequestStatus,
  RequestCompensationStatus,
  RequestWhereTemplate,
  RequestCompensationRow,
  RequestCompensationWhereTemplate,
  WorkflowWhereTemplate,
  WorkflowRow,
  WorkflowId,
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
  StreamReadNowaitResult,
  StreamReadResult,
  WorkflowOperatorActions,
  WorkflowResult,
  QueueHandlerAttempt,
  RequestHandlerAttempt,
  SkipOutcome,
  SkipOptions,
  RequestManualEscalationInput,
} from "./results";
import type { HaltWhereTemplate } from "./results";
import type {
  InferSessionRaw,
  OperatorSession,
  StorageDriver,
} from "./session";
import type { RequestCompensationInstanceId } from "./schema";
import type {
  QueueDefinition,
  QueueDefinitions,
  QueueHandlerRegistrationOptions,
} from "./definitions/messaging";
import type {
  QueueHandlerContext,
  RequestHandlerContext,
  RequestHandlerRegistrationOptions,
  Unsubscribe,
} from "./definitions/handlers";
import type {
  FetchableHandle,
  FindOptions,
  HaltHandle,
  OperatorAttemptsNamespaceExternal,
  QueryableNamespace,
} from "./introspection";
import type {
  HasIdempotencyFactory,
  InferWorkflowArgs,
  InferWorkflowArgsInput,
  InferWorkflowChildren,
  InferWorkflowChannels,
  InferWorkflowErrors,
  InferWorkflowExternal,
  InferWorkflowEvents,
  InferWorkflowMetadata,
  InferWorkflowMetadataInput,
  InferWorkflowQueues,
  InferWorkflowRequests,
  InferWorkflowResult,
  InferQueueErrors,
  InferRequestCompensationDef,
  InferRequestCompensationErrors,
  InferRequestErrors,
  InferWorkflowSteps,
  InferWorkflowStreams,
  InferStepCompensationStreams,
} from "./helpers";
import type { StepCompensationDefinition, StepDefinition } from "./definitions/steps";
import type {
  RequestCompensationConfig,
  RequestDefinition,
  RequestDefinitions,
} from "./definitions/requests";
import type { IsHeaderAuthoringKind } from "./definitions/authoring-kind";

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
  send<TRaw>(
    session: OperatorSession<TRaw>,
    data: T,
  ): Promise<ChannelSendResult>;
}

/**
 * Event accessor at engine level (with "never" support).
 */
export interface EventAccessorExternal {
  wait(options?: ExternalWaitOptions): Promise<EventWaitResultNoTimeout>;
  isSet<TRaw>(session: OperatorSession<TRaw>): Promise<EventCheckResult>;
}

/**
 * External stream reader on a workflow or compensation block handle.
 *
 * Sequential consumption is caller-owned: loop over offsets with
 * {@link StreamReaderAccessorExternal.read} (watch) or
 * {@link StreamReaderAccessorExternal.readNowait} (snapshot).
 */
export interface StreamReaderAccessorExternal<T> {
  /**
   * Read the record at `offset`, waiting until it is committed.
   * Resolves `{ status: "never" }` when the instance is terminal and the
   * offset will not appear. Signal abort rejects with `AbortError`.
   *
   * Watch IO — no session (does not hold a transactional scope while waiting).
   */
  read(
    offset: number,
    options?: ExternalWaitOptions,
  ): Promise<StreamReadResult<T>>;

  /**
   * Non-blocking read at `offset`. When `defaultValue` is supplied, that
   * value is returned instead of `{ status: "not_found" }`.
   */
  readNowait<TRaw>(
    session: OperatorSession<TRaw>,
    offset: number,
  ): Promise<StreamReadNowaitResult<T>>;
  readNowait<TRaw, D>(
    session: OperatorSession<TRaw>,
    offset: number,
    defaultValue: D,
  ): Promise<
    | { ok: true; status: "read"; data: T; offset: number }
    | { ok: false; status: "never" }
    | D
  >;
}

// =============================================================================
// HALTS NAMESPACE — read-only halt observation on a workflow handle.
//
// Per `REFACTOR.MD` Part 3, execution-workflow halts are not skippable
// directly — resolution is patch + replay (automatic on worker restart) or
// `skip(...)` on the workflow handle (which transitions the workflow to
// `'skipped'` and its pending halts to `'skipped'` along with it).
// =============================================================================

export type HaltsNamespaceExternal = QueryableNamespace<
  HaltHandle,
  HaltWhereTemplate,
  HaltRecord,
  number
>;

// =============================================================================
// COMPENSATION BLOCK INSTANCE HANDLE
// =============================================================================

/**
 * Per-instance primitive plane on a compensation block handle.
 *
 * Step 12 publishes typed {@link StreamReaderAccessorExternal} on
 * `streams`; `attributes`, `events`, and `channels` placeholders land in
 * step 16 alongside their per-instance primitive declarations on
 * `StepCompensationDefinition` (step 08).
 */
export interface CompensationBlockPrimitivePlane {
  readonly attributes: Record<string, unknown>;
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

  readonly streams: {
    [K in keyof InferStepCompensationStreams<TStep>]: StreamReaderAccessorExternal<
      StandardSchemaV1.InferOutput<
        InferStepCompensationStreams<TStep>[K]
      >
    >;
  };
}

/**
 * Per-parent compensation block instance namespace, keyed by step name on
 * `workflowInstance.compensations.steps.<step>`.
 */
export type CompensationBlockNamespaceExternal<
  TStep,
  TArgs = unknown,
  TResult = unknown,
> = QueryableNamespace<
  CompensationBlockUniqueHandleExternal<TStep, TArgs, TResult>,
  CompensationBlockWhereTemplate<TStep, TArgs, TResult>,
  CompensationBlockRow<TStep, TArgs, TResult>,
  CompensationId<TStep>
>;

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
 *   - `attempts` — parent-scoped query namespace over compensation-handler
 *     attempt rows;
 *   - `skip(result, opts?)` — operator completion with compensation metadata;
 *   - `escalateToManual(escalation, opts?)` — park for external resolution.
 */
export type RequestCompensationEscalateToManualOutcome =
  | { readonly status: "manual" }
  | { readonly status: "already_terminal"; readonly current: RequestCompensationStatus };

export interface RequestCompensationUniqueHandleExternal<
  TPayload = unknown,
  TCompResult = unknown,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> extends FetchableHandle<RequestCompensationRow<TPayload, TCompResult>> {
  readonly id: RequestCompensationInstanceId;

  readonly attempts: OperatorAttemptsNamespaceExternal<
    RequestHandlerAttempt<TCompensationErrors>
  >;

  skip<TRaw>(
    session: OperatorSession<TRaw>,
    ...args: [TCompResult] extends [void]
      ? []
      : [result: TCompResult]
  ): Promise<SkipOutcome>;

  escalateToManual<TRaw>(
    session: OperatorSession<TRaw>,
    escalation: RequestManualEscalationInput<TCompensationErrors>,
  ): Promise<RequestCompensationEscalateToManualOutcome>;
}

/**
 * Per-parent request compensation namespace, keyed by request name on
 * `workflowInstance.compensations.requests.<request>`.
 */
export type RequestCompensationNamespaceExternal<
  TPayload = unknown,
  TCompResult = unknown,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> = QueryableNamespace<
  RequestCompensationUniqueHandleExternal<
    TPayload,
    TCompResult,
    TCompensationErrors
  >,
  RequestCompensationWhereTemplate<TPayload, TCompResult>,
  RequestCompensationRow<TPayload, TCompResult>,
  RequestCompensationInstanceId
>;

// =============================================================================
// FORWARD REQUEST HANDLE
// =============================================================================

export type RequestCompensationResultFromBlock<
  TCompensation extends true | RequestCompensationConfig<any, any> | undefined,
> = TCompensation extends RequestCompensationConfig<infer TResultSchema>
  ? TResultSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TResultSchema>
    : void
  : TCompensation extends true
    ? void
    : unknown;

type WithRequestCompensationHandle<
  TCompensation extends true | RequestCompensationConfig<any, any> | undefined,
  TPayload,
  TCompResult,
  TCompensationErrors extends ErrorDefinitions,
> = undefined extends TCompensation
  ? {}
  : TCompensation extends undefined
    ? {}
    : {
        readonly compensation: RequestCompensationUniqueHandleExternal<
          TPayload,
          TCompResult,
          TCompensationErrors
        >;
      };

export interface RequestResolveOutcome {
  readonly status: "resolved";
}

export type RequestEscalateToManualOutcome =
  | { readonly status: "manual" }
  | { readonly status: "already_terminal"; readonly current: RequestStatus };

interface RequestHandleExternalBase<
  TRequestName extends string = string,
  TPayload = unknown,
  TResponse = unknown,
  TResponseInput = TResponse,
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends FetchableHandle<RequestRow<TRequestName, TPayload, TResponse>> {
  readonly id: RequestId<TRequestName>;

  readonly attempts: OperatorAttemptsNamespaceExternal<
    RequestHandlerAttempt<TErrors>
  >;

  resolve<TRaw>(
    session: OperatorSession<TRaw>,
    response: TResponseInput,
  ): Promise<RequestResolveOutcome>;

  escalateToManual<TRaw>(
    session: OperatorSession<TRaw>,
    escalation: RequestManualEscalationInput<TErrors>,
  ): Promise<RequestEscalateToManualOutcome>;
}

/**
 * Operator-facing handle for a forward request invocation.
 *
 * Request namespaces are queryable through the same `get` / `find` / `count`
 * surface as workflows and compensation instances.
 * Individual request actions live on the handle.
 *
 * Compensable definitions expose a synchronous `.compensation` handle ref;
 * row existence is surfaced lazily via `compensation.fetchRow(...)`.
 *
 * `resolve` and `escalateToManual` both abort an in-flight handler attempt via
 * `AbortSignal`. Only `resolve` records a typed response and unblocks the
 * workflow.
 */
export type RequestHandleExternal<
  TRequestName extends string = string,
  TPayload = unknown,
  TResponse = unknown,
  TResponseInput = TResponse,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TCompensation extends true | RequestCompensationConfig<any, any> | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
  TCompResult = unknown,
> = RequestHandleExternalBase<
  TRequestName,
  TPayload,
  TResponse,
  TResponseInput,
  TErrors
> &
  WithRequestCompensationHandle<
    TCompensation,
    TPayload,
    TCompResult,
    TCompensationErrors
  >;

export type RequestNamespaceExternal<
  TRequestName extends string = string,
  TPayload = unknown,
  TResponse = unknown,
  TResponseInput = TResponse,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TCompensation extends true | RequestCompensationConfig<any, any> | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> = QueryableNamespace<
  RequestHandleExternal<
    TRequestName,
    TPayload,
    TResponse,
    TResponseInput,
    TErrors,
    TCompensation,
    TCompensationErrors,
    RequestCompensationResultFromBlock<TCompensation>
  >,
  RequestWhereTemplate<TRequestName, TPayload, TResponse>,
  RequestRow<TRequestName, TPayload, TResponse>,
  RequestId<TRequestName>
> & {
  registerHandler(
    handler: (
      payload: TPayload,
      opts: RequestHandlerContext<TErrors>,
    ) => Promise<TResponseInput>,
    options?: RequestHandlerRegistrationOptions<
      TErrors,
      TPayload,
      TResponseInput,
      TCompensation,
      TCompensationErrors
    >,
  ): Unsubscribe;
};

// =============================================================================
// QUEUE DEAD-LETTER HANDLE
// =============================================================================

export interface DeadLetterRetryOutcome {
  readonly status: "retried";
}

export interface DeadLetterPurgeOutcome {
  readonly status: "purged";
}

/**
 * Operator-facing handle for a dead-lettered queue message.
 */
export interface DeadLetterHandleExternal<
  TQueueName extends string = string,
  TMessage = unknown,
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends FetchableHandle<DeadLetterRow<TQueueName, TMessage>> {
  readonly id: DeadLetterId<TQueueName>;

  /**
   * Parent-scoped query namespace over handler attempt records for this
   * message (failed tries only). Declared errors carry `code`, `message`, and
   * optional schema-backed `details`.
   */
  readonly attempts: OperatorAttemptsNamespaceExternal<
    QueueHandlerAttempt<TErrors>
  >;

  retry<TRaw>(session: OperatorSession<TRaw>): Promise<DeadLetterRetryOutcome>;

  purge<TRaw>(session: OperatorSession<TRaw>): Promise<DeadLetterPurgeOutcome>;
}

export type DeadLetterNamespaceExternal<
  TQueueName extends string = string,
  TMessage = unknown,
  TErrors extends ErrorDefinitions = Record<string, never>,
> = QueryableNamespace<
  DeadLetterHandleExternal<TQueueName, TMessage, TErrors>,
  DeadLetterWhereTemplate<TQueueName, TMessage>,
  DeadLetterRow<TQueueName, TMessage>,
  DeadLetterId<TQueueName>
>;

/**
 * Client/engine namespace for a globally registered queue definition.
 */
export interface QueueNamespaceExternal<
  TQueueName extends string = string,
  TMessage = unknown,
  TErrors extends ErrorDefinitions = Record<string, never>,
> {
  registerHandler(
    handler: (
      message: TMessage,
      opts: QueueHandlerContext<TErrors>,
    ) => Promise<void>,
    options: QueueHandlerRegistrationOptions<TErrors, TMessage>,
  ): Unsubscribe;

  readonly deadLetters: DeadLetterNamespaceExternal<TQueueName, TMessage, TErrors>;
}

// =============================================================================
// CHILD WORKFLOW OPERATOR NAMESPACE
//
// Per-parent introspection of owned child workflows. Child workflows are
// parent-scoped, non-lifecycle handles: no `sigkill` / `sigterm` / `skip`, no
// `idempotencyKey`. Independent roots started or referenced by this instance
// appear under `externalWorkflows` instead.
// =============================================================================

/**
 * Operator handle for a child workflow row (**non-lifecycle**).
 *
 * Child workflows are subordinate to the parent's lifecycle — operators do
 * not drive terminal actions on them. There is no `idempotencyKey` (not
 * globally addressable). Introspection and messaging surfaces (`channels`,
 * streams, events, `fetchRow`) follow the declared child workflow where the
 * type exposes them — this is not a blanket "read-only" surface; it excludes
 * lifecycle verbs, not channel send when present on the type.
 */
interface AttachedChildWorkflowExternalHandleBase<W extends AnyPublicWorkflowHeader>
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

type HeaderOnlyExtendForAttachedChildHandle<W extends AnyPublicWorkflowHeader> =
  IsHeaderAuthoringKind<W> extends true
    ? {
        /**
         * Widen static knowledge when the child handle type parameter is a graph-minimal
         * `WorkflowHeader` from `defineWorkflowHeader`.
         *
         * Same compatibility rules as {@link WorkflowHandleExternalBase.extend}.
         */
        extend<const TW extends AnyPublicWorkflowHeader>(
          contract: TW & ExtendPublicContract<W, TW>,
        ): AttachedChildWorkflowExternalHandleBase<TW> & HeaderOnlyExtendForAttachedChildHandle<TW>;
      }
    : { extend?: never };

export type AttachedChildWorkflowExternalHandle<W extends AnyPublicWorkflowHeader> =
  AttachedChildWorkflowExternalHandleBase<W> & HeaderOnlyExtendForAttachedChildHandle<W>;

/**
 * Per-parent child workflow namespace, keyed by child workflow name on
 * `workflowInstance.childWorkflows.<name>`.
 */
export type AttachedChildWorkflowNamespaceExternal<
  W extends AnyPublicWorkflowHeader,
> = QueryableNamespace<
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
>;

type IsAny<T> = 0 extends (1 & T) ? true : false;

type WorkflowClientLooseRequests = Record<string, RequestNamespaceExternal>;

type WorkflowClientLooseQueues = Record<string, QueueNamespaceExternal>;

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous request definitions; schema slots stay top-like */
type RequestPayloadForNamespace<TRequest> =
  TRequest extends RequestDefinition<string, infer TPayloadSchema, any, any, any>
    ? StandardSchemaV1.InferOutput<TPayloadSchema>
    : unknown;

type RequestResponseForNamespace<TRequest> =
  TRequest extends RequestDefinition<string, any, infer TResponseSchema, any, any>
    ? StandardSchemaV1.InferOutput<TResponseSchema>
    : unknown;

type RequestResponseInputForNamespace<TRequest> =
  TRequest extends RequestDefinition<string, any, infer TResponseSchema, any, any>
    ? StandardSchemaV1.InferInput<TResponseSchema>
    : unknown;

type RequestErrorsForNamespace<TRequest> = InferRequestErrors<TRequest>;

type RequestCompensationDefForNamespace<TRequest> =
  InferRequestCompensationDef<TRequest>;

type RequestCompensationErrorsForNamespace<TRequest> =
  InferRequestCompensationErrors<TRequest>;

type RequestDefinitionUnionFromWorkflow<W> =
  InferWorkflowRequests<W> extends infer TRequests
    ? [TRequests] extends [never]
      ? never
      : IsAny<TRequests> extends true
        ? RequestDefinition<string, any, any, any, any>
        : TRequests extends RequestDefinitions
          ? TRequests[keyof TRequests & string]
          : never
    : never;

type RequestDefinitionUnionFromWorkflows<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> = {
  [K in keyof TWfs & string]: RequestDefinitionUnionFromWorkflow<TWfs[K]>;
}[keyof TWfs & string];

type WorkflowClientRequestNamespacesFromUnion<TRequestUnion> = {
  [TRequest in TRequestUnion as TRequest extends RequestDefinition<
    infer TName,
    any,
    any,
    any,
    any
  >
    ? TName
    : never]: TRequest extends RequestDefinition<infer TName, any, any, any, any>
    ? RequestNamespaceExternal<
        TName,
        RequestPayloadForNamespace<TRequest>,
        RequestResponseForNamespace<TRequest>,
        RequestResponseInputForNamespace<TRequest>,
        RequestErrorsForNamespace<TRequest>,
        RequestCompensationDefForNamespace<TRequest>,
        RequestCompensationErrorsForNamespace<TRequest>
      >
    : never;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

type WorkflowClientRequestNamespaces<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> =
  IsAny<TWfs> extends true
    ? WorkflowClientLooseRequests
    : RequestDefinitionUnionFromWorkflows<TWfs> extends infer TRequestUnion
      ? [TRequestUnion] extends [never]
        ? Record<string, never>
        : WorkflowClientRequestNamespacesFromUnion<TRequestUnion>
      : Record<string, never>;

type QueueMessageForNamespace<TQueue> =
  TQueue extends QueueDefinition<string, infer TMessageSchema, infer _E, infer _D>
    ? StandardSchemaV1.InferOutput<TMessageSchema>
    : unknown;

type QueueErrorsForNamespace<TQueue> = InferQueueErrors<TQueue>;

type QueueDefinitionUnionFromWorkflow<W> =
  InferWorkflowQueues<W> extends infer TQueues
    ? [TQueues] extends [never]
      ? never
      : IsAny<TQueues> extends true
        ? QueueDefinition<string, JsonSchemaConstraint, ErrorDefinitions, undefined>
        : TQueues extends QueueDefinitions
          ? TQueues[keyof TQueues & string]
          : never
    : never;

type QueueDefinitionUnionFromWorkflows<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> = {
  [K in keyof TWfs & string]: QueueDefinitionUnionFromWorkflow<TWfs[K]>;
}[keyof TWfs & string];

type WorkflowClientQueueNamespacesFromUnion<TQueueUnion> = {
  [TQueue in TQueueUnion as TQueue extends QueueDefinition<
    infer TName,
    infer _M,
    infer _E,
    infer _D
  >
    ? TName
    : never]: TQueue extends QueueDefinition<infer TName, infer _M, infer _E, infer _D>
    ? QueueNamespaceExternal<
        TName,
        QueueMessageForNamespace<TQueue>,
        QueueErrorsForNamespace<TQueue>
      >
    : never;
};

type WorkflowClientQueueNamespaces<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> =
  IsAny<TWfs> extends true
    ? WorkflowClientLooseQueues
    : QueueDefinitionUnionFromWorkflows<TWfs> extends infer TQueueUnion
      ? [TQueueUnion] extends [never]
        ? Record<string, never>
        : WorkflowClientQueueNamespacesFromUnion<TQueueUnion>
      : Record<string, never>;

type WorkflowClientLooseCompensationSteps = Record<
  string,
  CompensationBlockNamespaceExternal<unknown>
>;

type WorkflowClientLooseCompensationRequests = Record<
  string,
  RequestCompensationNamespaceExternal
>;

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous step definitions */
type StepDefinitionUnionFromWorkflow<W> =
  InferWorkflowSteps<W> extends infer TSteps
    ? [TSteps] extends [never]
      ? never
      : IsAny<TSteps> extends true
        ? StepDefinition<string, any, any, any>
        : TSteps extends Record<string, unknown>
          ? TSteps[keyof TSteps & string]
          : never
    : never;

type StepDefinitionUnionFromWorkflows<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> = {
  [K in keyof TWfs & string]: StepDefinitionUnionFromWorkflow<TWfs[K]>;
}[keyof TWfs & string];

type WorkflowClientCompensationStepNamespacesFromUnion<TStepUnion> = {
  [TStep in TStepUnion as TStep extends StepDefinition<
    infer TName,
    any,
    any,
    any
  >
    ? TStep extends { compensation: unknown }
      ? TName
      : never
    : never]: TStep extends StepDefinition<infer _TName, any, any, any>
    ? CompensationBlockNamespaceExternal<
        TStep,
        StepArgsForCompensationNamespace<TStep>,
        StepCompensationResultForNamespace<TStep>
      >
    : never;
};

type WorkflowClientCompensationRequestNamespacesFromUnion<TRequestUnion> = {
  [TRequest in TRequestUnion as TRequest extends RequestDefinition<
    infer TName,
    any,
    any,
    any,
    any
  >
    ? InferRequestCompensationDef<TRequest> extends undefined
      ? never
      : TName
    : never]: TRequest extends RequestDefinition<infer TName, any, any, any, any>
    ? RequestCompensationNamespaceExternal<
        RequestPayloadForCompensationNamespace<TRequest>,
        RequestCompensationResultForNamespace<TRequest>,
        InferRequestCompensationErrors<TRequest>
      >
    : never;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

type WorkflowClientCompensationStepNamespaces<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> =
  IsAny<TWfs> extends true
    ? WorkflowClientLooseCompensationSteps
    : StepDefinitionUnionFromWorkflows<TWfs> extends infer TStepUnion
      ? [TStepUnion] extends [never]
        ? Record<string, never>
        : WorkflowClientCompensationStepNamespacesFromUnion<TStepUnion>
      : Record<string, never>;

type WorkflowClientCompensationRequestNamespaces<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> =
  IsAny<TWfs> extends true
    ? WorkflowClientLooseCompensationRequests
    : RequestDefinitionUnionFromWorkflows<TWfs> extends infer TRequestUnion
      ? [TRequestUnion] extends [never]
        ? Record<string, never>
        : WorkflowClientCompensationRequestNamespacesFromUnion<TRequestUnion>
      : Record<string, never>;

/**
 * Client-level global compensation search namespaces.
 *
 * Keyed by definition `name` (`defineRequest.name` / `defineStep.name`),
 * aggregated across all workflows registered on the client. Workflow-scoped
 * bulk search remains on `workflowHandle.compensations.{requests,steps}` keyed
 * by workflow slot.
 */
export type WorkflowClientCompensationsTree<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> = {
  readonly requests: WorkflowClientCompensationRequestNamespaces<TWfs>;
  readonly steps: WorkflowClientCompensationStepNamespaces<TWfs>;
};

type WorkflowHandleLooseChildWorkflows = Record<
  string,
  AttachedChildWorkflowNamespaceExternal<AnyPublicWorkflowHeader>
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

/* eslint-disable @typescript-eslint/no-explicit-any -- schema slots unconstrained so compensation namespaces match concrete steps */
type StepArgsForCompensationNamespace<TStep> =
  TStep extends StepDefinition<string, infer TArgsSchema, any, infer _Comp>
    ? StandardSchemaV1.InferOutput<TArgsSchema>
    : unknown;

type StepCompensationResultForNamespace<TStep> =
  TStep extends StepDefinition<string, any, any, infer TCompensation>
    ? TCompensation extends StepCompensationDefinition<
        infer _A,
        infer _FR,
        infer _Ch,
        infer _St,
        infer _Ev,
        infer _At,
        infer _Stp,
        infer _Req,
        infer _Qu,
        infer _To,
        infer _Children,
        infer _Ext,
        infer TResultSchema
      >
      ? TResultSchema extends StandardSchemaV1<unknown, unknown>
        ? StandardSchemaV1.InferOutput<TResultSchema>
        : void
      : never
    : unknown;

type WorkflowHandleCompensationNamespaces<TSteps extends Record<string, unknown>> = {
  [K in CompensableStepKeys<TSteps>]: CompensationBlockNamespaceExternal<
    TSteps[K],
    StepArgsForCompensationNamespace<TSteps[K]>,
    StepCompensationResultForNamespace<TSteps[K]>
  >;
};

type CompensableRequestKeys<TRequests extends Record<string, unknown>> = {
  [K in keyof TRequests & string]: InferRequestCompensationDef<
    TRequests[K]
  > extends undefined
    ? never
    : K;
}[keyof TRequests & string];

type RequestPayloadForCompensationNamespace<TRequest> =
  TRequest extends RequestDefinition<string, infer TPayloadSchema, any, any, infer _Comp>
    ? StandardSchemaV1.InferOutput<TPayloadSchema>
    : unknown;

type RequestCompensationResultForNamespace<TRequest> =
  TRequest extends RequestDefinition<string, any, any, any, infer TCompensation>
    ? TCompensation extends RequestCompensationConfig<infer TResultSchema>
      ? TResultSchema extends StandardSchemaV1<unknown, unknown>
        ? StandardSchemaV1.InferOutput<TResultSchema>
        : void
      : TCompensation extends true
        ? void
        : never
    : unknown;
/* eslint-enable @typescript-eslint/no-explicit-any */

type WorkflowHandleRequestCompensationNamespaces<
  TRequests extends Record<string, unknown>,
> = {
  [K in CompensableRequestKeys<TRequests>]: RequestCompensationNamespaceExternal<
    RequestPayloadForCompensationNamespace<TRequests[K]>,
    RequestCompensationResultForNamespace<TRequests[K]>,
    InferRequestCompensationErrors<TRequests[K]>
  >;
};

type WorkflowHandleChildWorkflowNamespaces<
  TChildren extends Record<string, unknown>,
> = {
  [K in keyof TChildren & string]: AttachedChildWorkflowNamespaceExternal<
    TChildren[K] extends AnyPublicWorkflowHeader
      ? TChildren[K]
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
  InferWorkflowChildren<W> extends infer TChildren
    ? [TChildren] extends [never]
      ? WorkflowHandleLooseChildWorkflows
      : IsAny<TChildren> extends true
        ? WorkflowHandleLooseChildWorkflows
        : TChildren extends Record<string, unknown>
          ? WorkflowHandleChildWorkflowNamespaces<TChildren>
          : WorkflowHandleLooseChildWorkflows
    : WorkflowHandleLooseChildWorkflows;


type WorkflowHandleExternalNamespaces<W extends AnyPublicWorkflowHeader> =
  InferWorkflowExternal<W> extends infer TExternalWorkflows
    ? [TExternalWorkflows] extends [never]
      ? Record<string, WorkflowHandleExternal<AnyPublicWorkflowHeader>>
      : IsAny<TExternalWorkflows> extends true
        ? Record<string, WorkflowHandleExternal<AnyPublicWorkflowHeader>>
        : TExternalWorkflows extends Record<string, unknown>
          ? {
              [K in keyof TExternalWorkflows & string]: WorkflowHandleExternal<
                TExternalWorkflows[K] extends AnyPublicWorkflowHeader
                  ? TExternalWorkflows[K]
                  : AnyPublicWorkflowHeader
              >;
            }
          : Record<string, WorkflowHandleExternal<AnyPublicWorkflowHeader>>
    : Record<string, WorkflowHandleExternal<AnyPublicWorkflowHeader>>;

// =============================================================================
// WORKFLOW HANDLE — globally addressable workflows.
//
// `WorkflowHandleExternal<W>` is parameterised over a workflow header so all
// the per-workflow types (channels, streams, events, args, result, metadata,
// errors) flow from one source. Replaces the earlier 5-generic shape.
// =============================================================================

interface WorkflowHandleExternalBase<W extends AnyPublicWorkflowHeader>
  extends FetchableHandle<
      WorkflowRow<
        InferWorkflowArgs<W>,
        InferWorkflowResult<W>,
        InferWorkflowMetadata<W>
      >
    >,
    WorkflowOperatorActions<InferWorkflowResult<W>> {
  readonly id: WorkflowId;

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

  // Per-parent introspection namespaces. One shape each: childWorkflows are
  // the attached (owned) children; externalWorkflows are the independent roots
  // this instance started or references.
  readonly childWorkflows: WorkflowHandleChildWorkflows<W>;
  readonly externalWorkflows: WorkflowHandleExternalNamespaces<W>;
  readonly compensations: WorkflowHandleCompensationsRoot<W>;

  /**
   * Wait for the workflow to reach a terminal state. Resolves to a typed
   * `WorkflowResult` carrying the success / failure / terminated outcome.
   *
   * Useful for already-started workflows. `client.workflows.<def>.execute(opts)`
   * is the equivalent start+wait one-shot.
   */
  wait(
    options?: ExternalWaitOptions,
  ): Promise<WorkflowResult<InferWorkflowResult<W>, ErrorValue<InferWorkflowErrors<W>>>>;

  /**
   * Update the retention policy for this workflow instance.
   */
  setRetention<TRaw>(
    session: OperatorSession<TRaw>,
    retention: number | RetentionSetter<"complete" | "failed" | "terminated">,
  ): Promise<void>;
}

/** JSON-ish maps keyed by string (channels, streams, …). */
type WorkflowPrimitiveSchemaMap = Record<string, unknown>;

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type SameWorkflowIdentityName<
  W extends AnyPublicWorkflowHeader,
  TW extends AnyPublicWorkflowHeader,
> = W extends { readonly name: infer NW }
  ? TW extends { readonly name: infer NTW }
    ? [NW] extends [NTW]
      ? [NTW] extends [NW]
        ? true
        : false
      : false
    : false
  : false;

/** True when the map carries at least one concrete string key (not `Record<string, never>`). */
type HasConcreteStringKeys<M extends WorkflowPrimitiveSchemaMap> = string extends keyof M
  ? false
  : [keyof M] extends [never]
    ? false
    : true;

/** Every **concrete** key on `narrower` exists on `wider`. */
type KeysAreSubsetOf<
  Narrower extends WorkflowPrimitiveSchemaMap,
  Wider extends WorkflowPrimitiveSchemaMap,
> = HasConcreteStringKeys<Narrower> extends false
  ? true
  : Exclude<keyof Narrower, keyof Wider> extends never
    ? true
    : false;

/** For each **concrete** key in `narrower`, schema slots must be mutually assignable. */
type SchemaSlotsMutuallyCompatible<
  Narrower extends WorkflowPrimitiveSchemaMap,
  Wider extends WorkflowPrimitiveSchemaMap,
> = HasConcreteStringKeys<Narrower> extends false
  ? true
  : {
      [K in keyof Narrower]: Narrower[K] extends Wider[K & keyof Wider]
        ? Wider[K & keyof Wider] extends Narrower[K]
          ? true
          : false
        : false;
    }[keyof Narrower] extends true
    ? true
    : false;

type ChannelsCompatibleForExtend<
  W extends AnyPublicWorkflowHeader,
  TW extends AnyPublicWorkflowHeader,
> =
  KeysAreSubsetOf<InferWorkflowChannels<W>, InferWorkflowChannels<TW>> extends true
    ? SchemaSlotsMutuallyCompatible<
        InferWorkflowChannels<W>,
        InferWorkflowChannels<TW>
      > extends true
      ? true
      : false
    : false;

type StreamsCompatibleForExtend<
  W extends AnyPublicWorkflowHeader,
  TW extends AnyPublicWorkflowHeader,
> =
  KeysAreSubsetOf<InferWorkflowStreams<W>, InferWorkflowStreams<TW>> extends true
    ? SchemaSlotsMutuallyCompatible<InferWorkflowStreams<W>, InferWorkflowStreams<TW>> extends true
      ? true
      : false
    : false;

type EventsKeysSubsetForExtend<
  W extends AnyPublicWorkflowHeader,
  TW extends AnyPublicWorkflowHeader,
> = HasConcreteStringKeys<InferWorkflowEvents<W>> extends false
  ? true
  : Exclude<keyof InferWorkflowEvents<W>, keyof InferWorkflowEvents<TW>> extends never
    ? true
    : false;

type MetadataCompatibleForExtend<
  W extends AnyPublicWorkflowHeader,
  TW extends AnyPublicWorkflowHeader,
> = [InferWorkflowMetadata<W>] extends [void]
  ? true
  : MutuallyAssignable<InferWorkflowMetadata<W>, InferWorkflowMetadata<TW>>;

/**
 * True when `TW` is a safe static widen of the graph-minimal header `W`
 * (same `name`, mutually assignable args/result/metadata where present, and
 * every channel/stream key on `W` exists on `TW` with mutually assignable schemas).
 */
type VerifyExtendPublicContract<
  W extends AnyPublicWorkflowHeader,
  TW extends AnyPublicWorkflowHeader,
> = SameWorkflowIdentityName<W, TW> extends true
  ? MutuallyAssignable<InferWorkflowArgs<W>, InferWorkflowArgs<TW>> extends true
    ? MutuallyAssignable<InferWorkflowResult<W>, InferWorkflowResult<TW>> extends true
      ? MetadataCompatibleForExtend<W, TW> extends true
        ? ChannelsCompatibleForExtend<W, TW> extends true
          ? StreamsCompatibleForExtend<W, TW> extends true
            ? EventsKeysSubsetForExtend<W, TW> extends true
              ? true
              : false
            : false
          : false
        : false
      : false
    : false
  : false;

type ExtendPublicContract<W extends AnyPublicWorkflowHeader, TW extends AnyPublicWorkflowHeader> =
  VerifyExtendPublicContract<W, TW> extends true ? unknown : never;

type HeaderOnlyExtendForWorkflowHandle<W extends AnyPublicWorkflowHeader> =
  IsHeaderAuthoringKind<W> extends true
    ? {
        /**
         * Widen static knowledge when the handle type parameter is a graph-minimal
         * `WorkflowHeader` from `defineWorkflowHeader`. Pass a `WorkflowInterface` or
         * full `WorkflowDefinition` for the same workflow identity.
         *
         * `TW` must match `W` on **`name`**, decoded **`args` / `result` / `metadata`**
         * (when the header carries metadata), and every **`channels` / `streams` /
         * `events`** key on `W` must exist on `TW` with mutually assignable schemas.
         */
        extend<const TW extends AnyPublicWorkflowHeader>(
          contract: TW & ExtendPublicContract<W, TW>,
        ): WorkflowHandleExternalBase<TW> & HeaderOnlyExtendForWorkflowHandle<TW>;
      }
    : { extend?: never };

export type WorkflowHandleExternal<W extends AnyPublicWorkflowHeader> =
  WorkflowHandleExternalBase<W> & HeaderOnlyExtendForWorkflowHandle<W>;

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
} & DeadlineOptions;

/**
 * The `idempotencyKey` slot on a start call, conditional on whether the
 * workflow declares an `idempotencyKeyFactory`:
 * - factory present → identity is derived from args; the key is **not passable**.
 * - factory absent  → the caller **must** supply an explicit `idempotencyKey`.
 */
export type IdempotencyKeyStartOption<W extends AnyPublicWorkflowHeader> =
  HasIdempotencyFactory<W> extends true
    ? { readonly idempotencyKey?: never }
    : { readonly idempotencyKey: string };

/**
 * Factory-aware start options for `client.workflows.<def>.start` / `.execute`.
 */
export type WorkflowStartOptions<W extends AnyPublicWorkflowHeader> = Omit<
  StartWorkflowOptions<InferWorkflowArgsInput<W>, InferWorkflowMetadataInput<W>>,
  "idempotencyKey"
> &
  IdempotencyKeyStartOption<W>;

/**
 * Identity lookup arguments for `.get(...)`, conditional on the factory:
 * by `args` (the engine derives the key) when a factory is declared, by an
 * explicit `idempotencyKey` otherwise.
 */
export type WorkflowGetArgs<W extends AnyPublicWorkflowHeader> =
  HasIdempotencyFactory<W> extends true
    ? [args: InferWorkflowArgsInput<W>]
    : [idempotencyKey: string];

// =============================================================================
// CLIENT-LEVEL WORKFLOW ACCESSOR
//
// Per `REFACTOR.MD` Part 5 §"`client.workflows.<def>` surface" — gain the
// unified queryable namespace surface alongside `start` / `execute` / `get`.
//
// `find` automatically excludes attached child workflows (Part 5 §"Global
// queries filter out attached child workflows" — the filter is a runtime guarantee;
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
   * Start a new instance of this workflow and return a typed externalWorkflows handle.
   */
  start<TRaw>(
    session: OperatorSession<TRaw>,
    options: WorkflowStartOptions<W>,
  ): Promise<WorkflowHandleExternal<W>>;

  /**
   * Start and wait for the workflow's terminal outcome (start + handle.wait()
   * one-shot convenience).
   */
  execute<TRaw>(
    session: OperatorSession<TRaw>,
    options: WorkflowStartOptions<W>,
  ): Promise<
    WorkflowResult<InferWorkflowResult<W>, ErrorValue<InferWorkflowErrors<W>>>
  >;

  /**
   * Get an externalWorkflows handle to an existing workflow instance by its identity:
   * by `args` when the workflow declares an `idempotencyKeyFactory` (the engine
   * derives the same key), otherwise by an explicit `idempotencyKey`.
   * Synchronous; no I/O.
   */
  get(...lookup: WorkflowGetArgs<W>): WorkflowHandleExternal<W>;
}

/**
 * Client-facing workflow API surface shared by dedicated clients and the engine.
 */
export interface WorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader> = Record<string, never>,
  TDriver extends StorageDriver<any> = StorageDriver<any>,
> {
  readonly driver: TDriver;

  session<R>(
    fn: (session: OperatorSession<InferSessionRaw<TDriver>, "engine">) => Promise<R>,
  ): Promise<R>;

  adoptSession(
    raw: InferSessionRaw<TDriver>,
  ): OperatorSession<InferSessionRaw<TDriver>, "adopted">;

  readonly workflows: {
    [K in keyof TWfs]: WorkflowClientAccessor<TWfs[K]>;
  };
  readonly requests: WorkflowClientRequestNamespaces<TWfs>;
  readonly queues: WorkflowClientQueueNamespaces<TWfs>;
  readonly compensations: WorkflowClientCompensationsTree<TWfs>;
}

/**
 * Workflow accessor specialization used by the executable engine.
 * Restricts registrations to full workflow definitions.
 */
export type EngineWorkflowAccessor<W extends AnyWorkflowDefinition> =
  WorkflowClientAccessor<W>;
