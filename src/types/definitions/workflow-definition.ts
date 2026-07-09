import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { WorkflowExecuteContext } from "../context/context-interfaces";
import type { WorkflowErrorDefinitions } from "./errors";
import type {
  PatchDefinitions,
  AttributeDefinitions,
  ChannelDefinitions,
  EventDefinitions,
  StreamDefinitions,
} from "./primitives";
import type { QueueDefinitions } from "./messaging";
import type { RequestDefinitions } from "./requests";
import type { RetentionSetter } from "./policies";
import type { RngDefinitions } from "./rng";
import type { StepDefinitions } from "./steps";
import type { PublicWorkflowHeader, WorkflowDefinitions } from "./workflow-headers";

/**
 * Any workflow definition shape.
 * Useful for avoiding repeated `WorkflowDefinition<...>` constraints at each
 * type parameter's upper bound.
 */
export type AnyWorkflowDefinition = WorkflowDefinition<
  string,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  AttributeDefinitions,
  StepDefinitions,
  RequestDefinitions,
  QueueDefinitions,
  WorkflowDefinitions,
  WorkflowDefinitions,
  JsonSchemaConstraint,
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  WorkflowErrorDefinitions,
  PatchDefinitions,
  RngDefinitions,
   
  ((args: any) => string) | undefined
>;

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

/**
 * Workflow definition — the blueprint for workflow instances.
 *
 * The body is a single sequential program. Concurrency comes from dispatched
 * entries (steps, requests, child workflows) the body awaits. There
 * is no user-facing branch primitive.
 */
export interface WorkflowDefinition<
  TName extends string = string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TIdempotencyKeyFactory extends
    | ((args: StandardSchemaV1.InferOutput<TArgs>) => string)
    | undefined = undefined,
> extends PublicWorkflowHeader<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
    TArgs,
    TMetadata,
    TResultSchema,
    TErrors,
    TIdempotencyKeyFactory
  > {
  /** Unique workflow name */
  readonly name: TName;

  /** Channel definitions */
  readonly channels?: TChannels;

  /** Stream definitions */
  readonly streams?: TStreams;

  /** Event definitions */
  readonly events?: TEvents;

  /** Attribute definitions */
  readonly attributes?: TAttributes;

  /** Step definitions */
  readonly steps?: TSteps;

  /** Request definitions */
  readonly requests?: TRequests;

  /** Queue definitions (for ctx.queues) */
  readonly queues?: TQueues;

  /**
   * Child workflow definitions. Child workflows are always parent-owned and
   * awaitable. To start an independent root, declare the target under
   * `externalWorkflows` and call `ctx.externalWorkflows.<name>.start(...)`.
   */
  readonly childWorkflows?: TChildren;

  /** External workflow definitions (for ctx.externalWorkflows) */
  readonly externalWorkflows?: TExternalWorkflows;

  /**
   * Patch definitions for safe workflow evolution.
   */
  readonly patches?: TPatches;

  /**
   * RNG definitions for deterministic randomness.
   */
  readonly rng?: TRng;

  /** Result schema for encoding/decoding workflow result */
  readonly result?: TResultSchema;

  /** Arguments schema (required — use `z.undefined()` when the workflow has no args). */
  readonly args: TArgs;

  /**
   * Optional immutable metadata schema for workflow instances.
   */
  readonly metadata?: TMetadata;

  /** Declared workflow business errors. */
  readonly errors?: TErrors;

  /**
   * Optional factory deriving this workflow's idempotency key from its decoded
   * args. When present, identity is derived from args (callers must not pass an
   * explicit `idempotencyKey`); when absent, the caller owns the key.
   */
  readonly idempotencyKeyFactory?: TIdempotencyKeyFactory;

  /**
   * Workflow retention policy for garbage collection.
   */
  readonly retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;

  /**
   * Passivation threshold for this workflow definition.
   */
  readonly evictAfterSeconds?: number | null;

  /**
   * Workflow execution function.
   */
  execute(
    ctx: WorkflowExecuteContext<
      TChannels,
      TStreams,
      TEvents,
      TAttributes,
      TSteps,
      TRequests,
      TQueues,
      TChildren,
      TExternalWorkflows,
      TPatches,
      TRng,
      TErrors,
      TArgs
    >,
  ): Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}
