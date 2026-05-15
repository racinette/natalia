import type { StandardSchemaV1 } from "../standard-schema";
import type { AttemptAccessor } from "../results";
import type { JsonSchemaConstraint } from "../json-input";
import type { CompensationContext } from "../context/context-interfaces";
import type { QueueDefinitions, TopicDefinitions } from "./messaging";
import type {
  AttributeDefinitions,
  ChannelDefinitions,
  EventDefinitions,
  StreamDefinitions,
} from "./primitives";
import type { RetryPolicyOptions } from "./policies";
import type { NonCompensableRequestDefinitions } from "./requests";
import type { NoDefinitionExtension } from "./type-augmentation";
import type { WorkflowDefinitions } from "./workflow-headers";

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
 *
 * The trailing `& ([TCompensation] extends [undefined] ? NoDefinitionExtension : { … })` uses
 * {@link NoDefinitionExtension} so “no compensation” is spelled explicitly at the type level
 * (see `type-augmentation.ts`).
 */
export type StepDefinition<
  TName extends string = string,
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  /* `any` in dependency slots: upper bound must not force contravariant `undo` ctx
   * to accept the maximal surface (breaks real compensations). */
  TCompensation extends
    | StepCompensationDefinition<
        TArgsSchema,
        TResultSchema,
        /* eslint-disable @typescript-eslint/no-explicit-any -- see block comment above */
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
        any
        /* eslint-enable @typescript-eslint/no-explicit-any */
      >
    | undefined = undefined,
> = {
  readonly name: TName;
  /**
   * Execute function — must return z.input<schema>.
   * Use your own application logger for step-level logging.
   */
  readonly execute: (
    context: { signal: AbortSignal },
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  /** Argument schema for observable, serializable step input. */
  readonly args: TArgsSchema;
  /** Result schema for encoding/decoding. */
  readonly result: TResultSchema;
  /** Default retry policy */
  readonly retryPolicy?: RetryPolicyOptions;
} & ([TCompensation] extends [undefined]
  ? NoDefinitionExtension
  : {
      /** Isolated compensation block definition for this step. */
      readonly compensation: TCompensation;
    });

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous non-compensable steps; schema slots must stay top-like for nested definitions */
export type NonCompensableStepDefinition = StepDefinition<string, any, any, undefined> & {
  readonly compensation?: never;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type NonCompensableStepDefinitions = Record<
  string,
  NonCompensableStepDefinition
>;

/**
 * Forward step outcome passed to compensation `undo` as `info`.
 *
 * `attempts` lists every persisted execution attempt on that forward step. At
 * least one attempt exists whenever `undo` runs (see `AttemptAccessor`).
 */
export type CompensationInfo<TResult> =
  | {
      readonly status: "completed";
      readonly result: TResult;
      readonly attempts: AttemptAccessor;
    }
  | {
      readonly status: "timed_out";
      readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: AttemptAccessor;
    }
  | { readonly status: "terminated"; readonly attempts: AttemptAccessor };

/**
 * Forward request outcome passed to request compensation handlers as `info`.
 *
 * `attempts` lists handler tries the engine persisted for that request
 * (failed tries only for request handlers — see `AttemptAccessor`).
 */
export type RequestCompensationInfo<TResponse> =
  | {
      readonly status: "completed";
      readonly response: TResponse;
      readonly attempts: AttemptAccessor;
    }
  | {
      readonly status: "timed_out";
      readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: AttemptAccessor;
    }
  | { readonly status: "terminated"; readonly attempts: AttemptAccessor };

/**
 * Step-local compensation block definition.
 *
 * Per `REFACTOR.MD` Part 2, each compensable step's compensation block can
 * declare:
 *
 * - **Per-instance primitives** — each compensation block instance gets its
 *   own private set of `channels`, `streams`, `events`, `attributes` (these
 *   are isolated from the workflow body's primitives).
 * - **Dependencies** — non-compensable steps and requests, queues, topics,
 *   children, and external workflows. Compensable steps and requests are
 *   rejected at compile time to prevent recursive compensation chains.
 *   Child workflows are exempt because each child owns its own compensation
 *   lifecycle.
 * - **Result schema** — optional; if omitted the compensation reports `void`.
 *
 * The `undo` callback's `ctx` is wired through the compensation context with
 * the declared per-instance primitives and dependency surface.
 *
 * Note: queues / topics / attributes accessors land in their own steps
 * (13 / 15 / 16). For now the declaration slots exist on the definition but
 * the matching accessors on `CompensationContext` are added incrementally.
 */
export interface StepCompensationDefinition<
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TForwardResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends NonCompensableStepDefinitions = Record<string, never>,
  TRequests extends NonCompensableRequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TTopics extends TopicDefinitions = Record<string, never>,
  TAttachedChildren extends WorkflowDefinitions = Record<string, never>,
  TDetachedChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
> {
  /** Per-instance channels for this compensation block. */
  readonly channels?: TChannels;
  /** Per-instance streams for this compensation block. */
  readonly streams?: TStreams;
  /** Per-instance events for this compensation block. */
  readonly events?: TEvents;
  /** Per-instance attributes for this compensation block. */
  readonly attributes?: TAttributes;
  /** Declared non-compensable step dependencies. */
  readonly steps?: TSteps;
  /** Declared non-compensable request dependencies. */
  readonly requests?: TRequests;
  /** Declared queue dependencies (the workflow can enqueue from compensation). */
  readonly queues?: TQueues;
  /** Declared topic dependencies (the compensation can publish). */
  readonly topics?: TTopics;
  /** Declared child workflow dependencies (exempt from compensable filter). */
  readonly children?: {
    readonly attached?: TAttachedChildren;
    readonly detached?: TDetachedChildren;
  };
  /** Declared external workflow dependencies. */
  readonly external?: TExternalWorkflows;
  /** Optional outcome schema. Default: `void`. */
  readonly result?: TResultSchema;
  /**
   * Compensation body. Receives the original step args (decoded) and the
   * forward operation's outcome `info`. Compensation reports its outcome
   * by return value — there is no `ctx.errors` and no throw machinery for
   * declared business failures (Part 4).
   */
  readonly undo: (
    ctx: CompensationContext<
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TRequests,
      TAttachedChildren,
      TDetachedChildren,
      TExternalWorkflows
    >,
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
    info: CompensationInfo<StandardSchemaV1.InferOutput<TForwardResultSchema>>,
  ) => Promise<
    | void
    | (TResultSchema extends JsonSchemaConstraint
        ? StandardSchemaV1.InferInput<TResultSchema>
        : void)
  >;
}

/**
 * Widest `StepCompensationDefinition` — upper bound for maps and loose authoring.
 */
export type MaximalStepCompensationDefinition = StepCompensationDefinition<
  JsonSchemaConstraint,
  JsonSchemaConstraint,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  AttributeDefinitions,
  NonCompensableStepDefinitions,
  NonCompensableRequestDefinitions,
  QueueDefinitions,
  TopicDefinitions,
  WorkflowDefinitions,
  WorkflowDefinitions,
  WorkflowDefinitions,
  JsonSchemaConstraint | undefined
>;

/** Upper-bound step shape used by compensation block typing. */
/* eslint-disable @typescript-eslint/no-explicit-any -- supertype of all concrete steps; `JsonSchemaConstraint` narrows `execute` args to `unknown` and breaks heterogeneous maps */
export type WidestStepDefinition = StepDefinition<string, any, any, any>;

/**
 * Map of step definitions.
 */
export type StepDefinitions = Record<string, StepDefinition<string, any, any, any>>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type CompensationBlockStatus =
  | "pending"
  | "running"
  | "completed"
  | "halted"
  | "skipped";

import type { FindUniqueResult } from "../introspection";

type Simplify<T> = { [K in keyof T]: T[K] };

type DistributeStatusResult<T> = T extends { status: infer TStatus }
  ? TStatus extends PropertyKey
    ? Simplify<Omit<T, "status"> & { status: TStatus }>
    : T
  : T;

type StepCompensationResultSchema<TStep> =
  TStep extends StepDefinition<
    string,
    JsonSchemaConstraint,
    JsonSchemaConstraint,
    infer TCompensation
  >
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
        infer _Att,
        infer _Det,
        infer _Ext,
        infer TResultSchema
      >
      ? TResultSchema
      : undefined
    : undefined;

export type CompensationBlockResult<
  TStep extends WidestStepDefinition,
> = StepCompensationResultSchema<TStep> extends JsonSchemaConstraint
  ? DistributeStatusResult<
      StandardSchemaV1.InferOutput<StepCompensationResultSchema<TStep>>
    >
  : void;

type CompensationBlockStoredResult<TStep extends WidestStepDefinition> =
  CompensationBlockResult<TStep> extends void
    ? null
    : CompensationBlockResult<TStep> | null;

export interface CompensationBlockUniqueHandle<TStep extends WidestStepDefinition> {
  status(): Promise<FindUniqueResult<CompensationBlockStatus>>;
  result(): Promise<FindUniqueResult<CompensationBlockStoredResult<TStep>>>;
}

export interface CompensationBlockHandle<TStep extends WidestStepDefinition> {
  findUnique(id: string): CompensationBlockUniqueHandle<TStep>;
}
