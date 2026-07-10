import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { WorkflowExecuteContext } from "../context/context-interfaces";
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
} from "./requests";
import type { RetryPolicyOptions } from "./policies";
import type { RngDefinitions } from "./rng";
import type {
  NonCompensableStepDefinitions,
  StepCompensationDefinition,
} from "./steps";
import type { WorkflowHeader, WorkflowDefinitions } from "./workflow-headers";

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
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
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
 * Interface compensation slice completed with implement-time `undo` /
 * `externalWorkflows`. Preserves dependency generics declared on the interface.
 */
export type StepCompensationFromInterface<
  TArgsSchema extends JsonSchemaConstraint,
  TForwardResultSchema extends JsonSchemaConstraint,
  C extends StepCompensationInterface,
> = C extends StepCompensationInterface<
  TArgsSchema,
  TForwardResultSchema,
  infer TCh,
  infer TSt,
  infer TE,
  infer TA,
  infer TS,
  infer TR,
  infer TQ,
  infer TT,
  infer TChild,
  infer TRes
>
  ? C & {
      readonly undo: StepCompensationDefinition<
        TArgsSchema,
        TForwardResultSchema,
        TCh,
        TSt,
        TE,
        TA,
        TS,
        TR,
        TQ,
        TT,
        TChild,
        WorkflowDefinitions,
        TRes
      >["undo"];
      readonly externalWorkflows?: WorkflowDefinitions;
    }
  : never;

/**
 * Runnable step merged from a {@link StepInterface} plus `.implement()` bodies.
 */
export type StepDefinitionFromInterface<
  TName extends string,
  TArgsSchema extends JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint,
  TCompensation extends StepCompensationInterface | undefined,
> = StepInterface<TName, TArgsSchema, TResultSchema, TCompensation> & {
  readonly execute: (
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
    opts: { signal: AbortSignal },
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
} & ([TCompensation] extends [StepCompensationInterface]
  ? {
      readonly compensation: StepCompensationFromInterface<
        TArgsSchema,
        TResultSchema,
        TCompensation
      >;
    }
  : Record<string, never>);

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

export type RequestInterfaces = Record<
  string,
  RequestDefinition<
    string,
    JsonSchemaConstraint,
    JsonSchemaConstraint,
    Record<string, never>,
    RequestCompensationDefinition<JsonSchemaConstraint, ErrorDefinitions> | undefined
  >
>;

export type QueueInterfaces = Record<
  string,
  QueueDefinition<
    string,
    JsonSchemaConstraint,
    ErrorDefinitions,
    number | Date | null | undefined
  >
>;

export type StepsFromInterfaces<T extends StepInterfaces> = {
  [K in keyof T]: T[K] extends StepInterface<infer N, infer A, infer R, infer C>
    ? StepDefinitionFromInterface<N, A, R, C>
    : never;
};

type RequestErrorsFromInterfaceSlice<T> = T extends { readonly errors: infer E }
  ? E extends ErrorDefinitions
    ? E
    : Record<string, never>
  : Record<string, never>;

export type RequestsFromInterfaces<T extends RequestInterfaces> = {
  [K in keyof T]: T[K] extends RequestDefinition<
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
  TAttributes extends AttributeDefinitions,
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
    ctx: WorkflowExecuteContext<
      TChannels,
      TStreams,
      TEvents,
      TAttributes,
      StepsFromInterfaces<TSteps>,
      RequestsFromInterfaces<TRequests>,
      QueuesFromInterfaces<TQueues>,
      TChildren,
      TExternalWorkflows,
      TPatches,
      TRng,
      TErrors,
      TArgs
    >,
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
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepInterfaces = Record<string, never>,
  TRequests extends RequestInterfaces = Record<string, never>,
  TQueues extends QueueInterfaces = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TMetadata extends JsonObjectSchemaConstraint = JsonObjectSchemaConstraint,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> extends WorkflowHeader<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
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
export const WORKFLOW_HEADER_LOCKED_IN_EXTEND = [
  "name",
  "channels",
  "args",
  "metadata",
  "result",
  "errors",
] as const;

type WorkflowHeaderLockedForExtend =
  (typeof WORKFLOW_HEADER_LOCKED_IN_EXTEND)[number];

/** Rejects header-locked keys on `.extend({ ... })` payloads at compile time. */
export type ForbidWorkflowHeaderLockedFieldsInExtend = {
  readonly [K in WorkflowHeaderLockedForExtend]?: never;
};

export type AnyWorkflowInterface = WorkflowInterface<
  string,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  AttributeDefinitions,
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
