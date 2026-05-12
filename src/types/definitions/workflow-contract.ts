import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { WorkflowContext } from "../context/context-interfaces";
import type { WorkflowErrorDefinitions } from "./errors";
import type {
  AttributeDefinitions,
  PatchDefinitions,
  ChannelDefinitions,
  EventDefinitions,
  StreamDefinitions,
} from "./primitives";
import type { QueueDefinitions, TopicDefinitions } from "./messaging";
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
 * Step compensation contract without `undo` or `external` (declarative slice only).
 *
 * Dependency maps default to their **definition upper bounds** (not `Record<string, never>`)
 * so authoring literals with real `channels`, `steps`, etc. type-check without casts.
 *
 * Declare **`external`** on **`.implement({ compensation: { external, undo } })`** only.
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
  TAttachedChildren extends WorkflowDefinitions = WorkflowDefinitions,
  TDetachedChildren extends WorkflowDefinitions = WorkflowDefinitions,
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
    TAttachedChildren,
    TDetachedChildren,
    WorkflowDefinitions,
    TResultSchema
  >,
  "undo" | "external"
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

/**
 * Request contract without `registerHandler` (declarative slice only).
 */
export type RequestInterface<
  TName extends string = string,
  TPayloadSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TCompensation extends
    | RequestCompensationDefinition<JsonSchemaConstraint | undefined>
    | undefined = undefined,
> = Omit<RequestDefinition<TName, TPayloadSchema, TResponseSchema, TCompensation>, "registerHandler">;

export type RequestInterfaces = Record<
  string,
  RequestInterface<
    string,
    JsonSchemaConstraint,
    JsonSchemaConstraint,
    RequestCompensationDefinition<JsonSchemaConstraint | undefined> | undefined
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

export type RequestsFromInterfaces<T extends RequestInterfaces> = {
  [K in keyof T]: T[K] extends RequestInterface<infer N, infer P, infer R, infer Comp>
    ? RequestDefinition<N, P, R, Comp>
    : never;
};

export type WorkflowImplementInput<
  _TName extends string,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepInterfaces,
  TRequests extends RequestInterfaces,
  TAttachedChildren extends WorkflowDefinitions,
  TDetachedChildren extends WorkflowDefinitions,
  TExternalWorkflows extends WorkflowDefinitions,
  TResultSchema extends JsonSchemaConstraint,
  TArgs extends JsonSchemaConstraint,
  _TMetadata extends JsonObjectSchemaConstraint,
  TErrors extends WorkflowErrorDefinitions,
  TPatches extends PatchDefinitions,
  TRng extends RngDefinitions,
> = {
  /** Other workflows reachable from `execute` via `ctx.external` — implementation-only, not part of `WorkflowInterface`. */
  readonly external?: TExternalWorkflows;
  execute: (
    ctx: WorkflowContextForInterface<
      TChannels,
      TStreams,
      TEvents,
      StepsFromInterfaces<TSteps>,
      RequestsFromInterfaces<TRequests>,
      TAttachedChildren,
      TDetachedChildren,
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
 * Built from `...defineWorkflowHeader(...)` plus additive fields the graph and
 * clients need (streams, events, children, requests, step interfaces, …).
 *
 * Declaring **`external`** workflows belongs on **`.implement({ external, … })`** only
 * — they wire `ctx.external` for the implementation and are not part of this public surface.
 */
export interface WorkflowInterface<
  TName extends string = string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TSteps extends StepInterfaces = Record<string, never>,
  TRequests extends RequestInterfaces = Record<string, never>,
  TAttachedChildren extends WorkflowDefinitions = Record<string, never>,
  TDetachedChildren extends WorkflowDefinitions = Record<string, never>,
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
  readonly children?: {
    readonly attached?: TAttachedChildren;
    readonly detached?: TDetachedChildren;
  };
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

export type AnyWorkflowInterface = WorkflowInterface<
  string,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  StepInterfaces,
  RequestInterfaces,
  WorkflowDefinitions,
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
  TAttachedChildren extends WorkflowDefinitions,
  TDetachedChildren extends WorkflowDefinitions,
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
  TAttachedChildren,
  TDetachedChildren,
  TExternalWorkflows,
  TPatches,
  TRng,
  [],
  TErrors
>;
