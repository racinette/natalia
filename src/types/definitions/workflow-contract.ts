import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { WorkflowContext } from "../context/context-interfaces";
import type { ErrorDefinitions, WorkflowErrorDefinitions } from "./errors";
import type {
  AttributeDefinitions,
  PatchDefinitions,
  ChannelDefinitions,
  EventDefinitions,
  StreamDefinitions,
} from "./primitives";
import type { QueueDefinition, QueueDefinitions, TopicDefinitions } from "./messaging";
import type {
  RequestCompensationDefinition,
  RequestDefinition,
  NonCompensableRequestDefinitions,
  RequestDefinitions,
} from "./requests";
import type { RetryPolicyOptions } from "./policies";
import type { RngDefinitions } from "./rng";
import type { NonCompensableStepDefinitions, StepCompensationDefinition, StepDefinition, StepDefinitions } from "./steps";
import type { PublicWorkflowHeader, WorkflowDefinitions } from "./workflow-headers";

/**
 * Step compensation contract without `undo` or `externalWorkflows` (declarative slice only).
 *
 * Dependency maps default to their **definition upper bounds** (not `Record<string, never>`)
 * so authoring literals with real `channels`, `steps`, etc. type-check without casts.
 *
 * Declare **`externalWorkflows`** on **`.implement({ compensation: { externalWorkflows, undo } })`** only.
 */
export type StepCompensationInterface<
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TForwardResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TChannels extends ChannelDefinitions = ChannelDefinitions,
  TStreams extends StreamDefinitions = StreamDefinitions,
  TEvents extends EventDefinitions = EventDefinitions,
  TAttributes extends AttributeDefinitions = AttributeDefinitions,
  TSteps extends NonCompensableStepDefinitions = NonCompensableStepDefinitions,
  TRequests extends NonCompensableRequestDefinitions = NonCompensableRequestDefinitions,
  TQueues extends QueueDefinitions = QueueDefinitions,
  TTopics extends TopicDefinitions = TopicDefinitions,
  TChildren extends WorkflowDefinitions = WorkflowDefinitions,
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
> = Omit<
  StepCompensationDefinition<
    TArgsSchema,
    TForwardResultSchema,
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
    TSteps,
    TRequests,
    TQueues,
    TTopics,
    TChildren,
    WorkflowDefinitions,
    TResultSchema
  >,
  "undo" | "externalWorkflows"
>;

/**
 * Step contract without `execute` / `undo` (see `defineStepInterface`).
 */
export interface StepInterface<
  TName extends string = string,
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TCompensation extends StepCompensationInterface | undefined = undefined,
> {
  readonly name: TName;
  readonly args: TArgsSchema;
  readonly result: TResultSchema;
  readonly retryPolicy?: RetryPolicyOptions;
  readonly compensation?: TCompensation;
}

/** Map of step interfaces used on `WorkflowInterface`. */
export type StepInterfaces = Record<
  string,
  StepInterface<string, JsonSchemaConstraint, JsonSchemaConstraint, StepCompensationInterface | undefined>
>;

/** Request contract (declarative slice only). */
export type RequestInterface<
  TName extends string = string,
  TPayloadSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TCompensation extends
    | RequestCompensationDefinition<
        JsonSchemaConstraint | undefined,
        ErrorDefinitions
      >
    | undefined = undefined,
> = RequestDefinition<TName, TPayloadSchema, TResponseSchema, TErrors, TCompensation>;

export type RequestInterfaces = Record<
  string,
  RequestInterface<
    string,
    JsonSchemaConstraint,
    JsonSchemaConstraint,
    Record<string, never>,
    RequestCompensationDefinition<JsonSchemaConstraint | undefined, ErrorDefinitions> | undefined
  >
>;

/**
 * Queue contract (declarative slice only).
 *
 * Handler registration lives on `client.queues.<definitionName>`.
 */
export type QueueInterface<
  TName extends string = string,
  TMessageSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TDefaultTtl extends number | Date | null | undefined = undefined,
> = QueueDefinition<TName, TMessageSchema, TErrors, TDefaultTtl>;

export type QueueInterfaces = Record<
  string,
  QueueInterface<
    string,
    JsonSchemaConstraint,
    ErrorDefinitions,
    number | Date | null | undefined
  >
>;

export type StepsFromInterfaces<T extends StepInterfaces> = {
  [K in keyof T]: T[K] extends StepInterface<infer N, infer A, infer R, infer C>
    ? StepDefinition<
        N,
        A,
        R,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- compensation slot is heterogeneous across the map; nominal `StepDefinition` still constrains each key at `implement` time
        C extends StepCompensationInterface ? any : undefined
      >
    : never;
};

type RequestErrorsFromInterfaceSlice<T> = T extends { readonly errors: infer E }
  ? E extends ErrorDefinitions
    ? E
    : Record<string, never>
  : Record<string, never>;

export type RequestsFromInterfaces<T extends RequestInterfaces> = {
  [K in keyof T]: T[K] extends RequestInterface<
    infer N,
    infer P,
    infer R,
    any,
    infer Comp
  >
    ? RequestDefinition<
        N,
        P,
        R,
        RequestErrorsFromInterfaceSlice<T[K]>,
        Comp
      >
    : never;
};

export type QueuesFromInterfaces<T extends QueueInterfaces> = {
  [K in keyof T]: T[K];
};

export type WorkflowImplementInput<
  _TName extends string,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepInterfaces,
  TRequests extends RequestInterfaces,
  TQueues extends QueueInterfaces,
  TChildren extends WorkflowDefinitions,
  TExternalWorkflows extends WorkflowDefinitions,
  TResultSchema extends JsonSchemaConstraint,
  TArgs extends JsonSchemaConstraint,
  _TMetadata extends JsonObjectSchemaConstraint,
  TErrors extends WorkflowErrorDefinitions,
  TPatches extends PatchDefinitions,
  TRng extends RngDefinitions,
> = {
  /** Other workflows reachable from `execute` via `ctx.externalWorkflows` — implementation-only, not part of `WorkflowInterface`. */
  readonly externalWorkflows?: TExternalWorkflows;
  execute: (
    ctx: WorkflowContextForInterface<
      TChannels,
      TStreams,
      TEvents,
      StepsFromInterfaces<TSteps>,
      RequestsFromInterfaces<TRequests>,
      QueuesFromInterfaces<TQueues>,
      TChildren,
      TExternalWorkflows,
      TPatches,
      TRng,
      TErrors
    >,
    args: StandardSchemaV1.InferOutput<TArgs>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
} & ([TSteps] extends [Record<string, never>]
  ? { steps?: StepsFromInterfaces<TSteps> }
  : { steps: StepsFromInterfaces<TSteps> }) &
  ([TRequests] extends [Record<string, never>]
    ? { requests?: RequestsFromInterfaces<TRequests> }
    : { requests: RequestsFromInterfaces<TRequests> });


/**
 * Full declarative workflow contract without `execute` or step bodies.
 *
 * Prefer `defineWorkflowHeader(...).extend({ ... })` for the header → interface
 * transition so header fields cannot be overridden. Additive fields (streams,
 * events, childWorkflows, requests, step interfaces, …) complete the public contract.
 *
 * Declaring **`externalWorkflows`** workflows belongs on **`.implement({ externalWorkflows, … })`** only
 * — they wire `ctx.externalWorkflows` for the implementation and are not part of this public surface.
 */
export interface WorkflowInterface<
  TName extends string = string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TSteps extends StepInterfaces = Record<string, never>,
  TRequests extends RequestInterfaces = Record<string, never>,
  TQueues extends QueueInterfaces = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<void, void>,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> extends PublicWorkflowHeader<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TArgs,
    TMetadata,
    TResultSchema,
    TErrors
  > {
  readonly steps?: TSteps;
  readonly requests?: TRequests;
  readonly queues?: TQueues;
  readonly childWorkflows?: TChildren;
  readonly patches?: TPatches;
  readonly rng?: TRng;
  readonly retention?:
    | number
    | {
        readonly complete: number | null;
        readonly failed: number | null;
        readonly terminated: number | null;
      };
  readonly evictAfterSeconds?: number | null;
}

/**
 * Header-locked keys: not allowed on `defineWorkflowHeader(...).extend({ ... })` so
 * callers cannot override the header slice when moving to a `WorkflowInterface`.
 */
export type WorkflowHeaderLockedForExtend =
  | "name"
  | "channels"
  | "args"
  | "metadata"
  | "result"
  | "errors";

/**
 * Additive interface fields layered on top of an existing `WorkflowHeader` (streams,
 * events, steps, childWorkflows, …). Header-locked keys are omitted from this shape.
 */
export type WorkflowInterfaceExtendFromHeader<
  TName extends string,
  TChannels extends ChannelDefinitions,
  TArgs extends JsonSchemaConstraint,
  TMetadata extends JsonObjectSchemaConstraint,
  TResult extends JsonSchemaConstraint,
  TErrors extends WorkflowErrorDefinitions,
> = Pick<
  WorkflowInterface<
    TName,
    TChannels,
    StreamDefinitions,
    EventDefinitions,
    StepInterfaces,
    RequestInterfaces,
    QueueInterfaces,
    WorkflowDefinitions,
    TResult,
    TArgs,
    TMetadata,
    TErrors,
    PatchDefinitions,
    RngDefinitions
  >,
  | "streams"
  | "events"
  | "steps"
  | "requests"
  | "queues"
  | "childWorkflows"
  | "patches"
  | "rng"
  | "retention"
  | "evictAfterSeconds"
>;

export type AnyWorkflowInterface = WorkflowInterface<
  string,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  StepInterfaces,
  RequestInterfaces,
  QueueInterfaces,
  WorkflowDefinitions,
  JsonSchemaConstraint,
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  WorkflowErrorDefinitions,
  PatchDefinitions,
  RngDefinitions
>;

/**
 * Context parameter type for `execute` on a workflow whose shape matches `WorkflowInterface`.
 */
export type WorkflowContextForInterface<
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions,
  TQueues extends QueueDefinitions,
  TChildren extends WorkflowDefinitions,
  TExternalWorkflows extends WorkflowDefinitions,
  TPatches extends PatchDefinitions,
  TRng extends RngDefinitions,
  TErrors extends WorkflowErrorDefinitions,
> = WorkflowContext<
  TChannels,
  TStreams,
  TEvents,
  TSteps,
  TRequests,
  TQueues,
  TChildren,
  TExternalWorkflows,
  TPatches,
  TRng,
  [],
  TErrors
>;
