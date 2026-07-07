import type { StandardSchemaV1 } from "../standard-schema";
import type { Attempt, RequestHandlerAttempt } from "../results";
import type { ErrorDefinitions } from "./errors";
import type { HandlerAttemptsReadNamespace } from "../introspection";
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
         
      >
    | undefined = undefined,
> = {
  readonly name: TName;
  /**
   * Execute function — must return z.input<schema>.
   * Use your own application logger for step-level logging.
   */
  readonly execute: (
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
    opts: { signal: AbortSignal },
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  /** Argument schema for observable, serializable step input. */
  readonly args: TArgsSchema;
  /** Result schema for encoding/decoding. */
  readonly result: TResultSchema;
  /**
   * Default retry **strategy** (interval, backoff, per-attempt `timeoutSeconds`).
   * Does not cap total attempts — use call-time `timeout` / `maxAttempts` when
   * the caller needs a stop condition.
   */
  readonly retryPolicy?: RetryPolicyOptions;
} & ([TCompensation] extends [undefined]
  ? NoDefinitionExtension
  : {
      /** Isolated compensation block definition for this step. */
      readonly compensation: TCompensation;
    });

 
export type NonCompensableStepDefinition = StepDefinition<string, any, any, undefined> & {
  readonly compensation?: never;
};
 

export type NonCompensableStepDefinitions = Record<
  string,
  NonCompensableStepDefinition
>;

/**
 * Forward step outcome passed to compensation `undo` as `info`.
 *
 * `attempts` lists every persisted execution attempt on that forward step. At
 * least one attempt exists whenever `undo` runs.
 */
export type CompensationInfo<TResult> =
  | {
      readonly status: "completed";
      readonly result: TResult;
      readonly attempts: HandlerAttemptsReadNamespace<Attempt>;
    }
  | {
      readonly status: "timed_out";
      readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: HandlerAttemptsReadNamespace<Attempt>;
    }
  | {
      readonly status: "terminated";
      readonly attempts: HandlerAttemptsReadNamespace<Attempt>;
    };

/**
 * Forward request outcome snapshot on request compensation handler `ctx.forward`.
 *
 * `attempts` lists forward handler tries the engine persisted for that
 * request invocation. Use with forward settlement status — on `"completed"`,
 * read the typed outcome from `response`; when forward did not complete
 * cleanly, inspect attempts for reachability hints.
 */
export type RequestCompensationInfo<
  TResponse,
  TForwardErrors extends ErrorDefinitions = Record<string, never>,
> =
  | {
      readonly status: "completed";
      readonly response: TResponse;
      readonly attempts: HandlerAttemptsReadNamespace<
        RequestHandlerAttempt<TForwardErrors>
      >;
    }
  | {
      readonly status: "timed_out";
      readonly reason: "attempts_exhausted" | "deadline";
      readonly attempts: HandlerAttemptsReadNamespace<
        RequestHandlerAttempt<TForwardErrors>
      >;
    }
  | {
      readonly status: "terminated";
      readonly attempts: HandlerAttemptsReadNamespace<
        RequestHandlerAttempt<TForwardErrors>
      >;
    };

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
 *   childWorkflows, and external workflows. Compensable steps and requests are
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
  TChildren extends WorkflowDefinitions = Record<string, never>,
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
  readonly childWorkflows?: TChildren;
  /** Declared external workflow dependencies. */
  readonly externalWorkflows?: TExternalWorkflows;
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
      TQueues,
      TChildren,
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
  JsonSchemaConstraint | undefined
>;

/** Upper-bound step shape used by compensation block typing. */
 
export type WidestStepDefinition = StepDefinition<string, any, any, any>;

/**
 * Map of step definitions.
 */
export type StepDefinitions = Record<string, StepDefinition<string, any, any, any>>;
 

export type CompensationBlockStatus =
  | "pending"
  | "running"
  | "completed"
  | "halted"
  | "skipped";
