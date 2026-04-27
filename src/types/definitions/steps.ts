import type { StandardSchemaV1 } from "../standard-schema";
import type { AttemptAccessor } from "../results";
import type { JsonSchemaConstraint } from "../json-input";
import type { CompensationContext } from "../context/context-interfaces";
import type { RetryPolicyOptions } from "./policies";
import type { NonCompensableRequestDefinitions } from "./requests";

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
 */
export type StepDefinition<
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TCompensation extends
    | StepCompensationDefinition<TArgsSchema, TResultSchema, any, any, any>
    | undefined = undefined,
> = {
  readonly name: string;
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
  ? {}
  : {
      /** Isolated compensation block definition for this step. */
      readonly compensation: TCompensation;
    });

export type NonCompensableStepDefinition = StepDefinition<any, any, undefined> & {
  readonly compensation?: never;
};

export type NonCompensableStepDefinitions = Record<
  string,
  NonCompensableStepDefinition
>;

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
 */
export interface StepCompensationDefinition<
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TForwardResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TSteps extends NonCompensableStepDefinitions = Record<string, never>,
  TRequests extends NonCompensableRequestDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
> {
  readonly steps?: TSteps;
  readonly requests?: TRequests;
  readonly result?: TResultSchema;
  readonly undo: (
    ctx: CompensationContext<
      Record<string, never>,
      Record<string, never>,
      Record<string, never>,
      TSteps,
      TRequests
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
 * Map of step definitions.
 */
export type StepDefinitions = Record<string, StepDefinition<any, any, any>>;

export type CompensationBlockStatus =
  | "pending"
  | "running"
  | "completed"
  | "halted"
  | "skipped";

export type FindUniqueResult<T> =
  | { readonly status: "unique"; readonly value: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly count: number };

type Simplify<T> = { [K in keyof T]: T[K] };

type DistributeStatusResult<T> = T extends { status: infer TStatus }
  ? TStatus extends PropertyKey
    ? Simplify<Omit<T, "status"> & { status: TStatus }>
    : T
  : T;

type StepCompensationResultSchema<TStep> =
  TStep extends StepDefinition<any, any, infer TCompensation>
    ? TCompensation extends StepCompensationDefinition<any, any, any, any, infer TResultSchema>
      ? TResultSchema
      : undefined
    : undefined;

export type CompensationBlockResult<
  TStep extends StepDefinition<any, any, any>,
> = StepCompensationResultSchema<TStep> extends JsonSchemaConstraint
  ? DistributeStatusResult<
      StandardSchemaV1.InferOutput<StepCompensationResultSchema<TStep>>
    >
  : void;

type CompensationBlockStoredResult<TStep extends StepDefinition<any, any, any>> =
  CompensationBlockResult<TStep> extends void
    ? null
    : CompensationBlockResult<TStep> | null;

export interface CompensationBlockUniqueHandle<
  TStep extends StepDefinition<any, any, any>,
> {
  status(): Promise<FindUniqueResult<CompensationBlockStatus>>;
  result(): Promise<FindUniqueResult<CompensationBlockStoredResult<TStep>>>;
}

export interface CompensationBlockHandle<
  TStep extends StepDefinition<any, any, any>,
> {
  findUnique(id: string): CompensationBlockUniqueHandle<TStep>;
}
