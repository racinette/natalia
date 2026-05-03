import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { CompensationContext, WorkflowContext } from "../context/context-interfaces";
import type { WorkflowErrorDefinitions } from "./errors";
import type { PatchDefinitions, ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./primitives";
import type { RequestDefinitions } from "./requests";
import type { RetentionSetter } from "./policies";
import type { RngDefinitions } from "./rng";
import type { StepDefinitions } from "./steps";
import type { PublicWorkflowHeader, WorkflowDefinitions } from "./workflow-headers";

/**
 * Any workflow definition shape.
 * Useful for avoiding repeated `WorkflowDefinition<any, ...>` constraints.
 */
export type AnyWorkflowDefinition = WorkflowDefinition<
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
  any,
  any
>;

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

/**
 * Workflow definition — the blueprint for workflow instances.
 *
 * The body is a single sequential program. Concurrency comes from dispatched
 * entries (steps, requests, attached child workflows) the body awaits. There
 * is no user-facing branch primitive.
 */
export interface WorkflowDefinition<
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions,
  TChildWorkflows extends WorkflowDefinitions,
  TForeignWorkflows extends WorkflowDefinitions,
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
> extends PublicWorkflowHeader<
    TChannels,
    TStreams,
    TEvents,
    TArgs,
    TMetadata,
    TResultSchema,
    TErrors
  > {
  /** Unique workflow name */
  readonly name: string;

  /** Channel definitions */
  readonly channels?: TChannels;

  /** Stream definitions */
  readonly streams?: TStreams;

  /** Event definitions */
  readonly events?: TEvents;

  /** Step definitions */
  readonly steps?: TSteps;

  /** Request definitions */
  readonly requests?: TRequests;

  /** Child workflow definitions (for ctx.childWorkflows) */
  readonly childWorkflows?: TChildWorkflows;

  /** Foreign workflow definitions (for ctx.foreignWorkflows) */
  readonly foreignWorkflows?: TForeignWorkflows;

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

  /** Arguments schema (optional) */
  readonly args?: TArgs;

  /**
   * Optional immutable metadata schema for workflow instances.
   */
  readonly metadata?: TMetadata;

  /** Declared workflow business errors. */
  readonly errors?: TErrors;

  /**
   * Workflow retention policy for garbage collection.
   */
  readonly retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;

  /**
   * Passivation threshold for this workflow definition.
   */
  readonly evictAfterSeconds?: number | null;

  /**
   * Called once before final workflow status is settled.
   */
  readonly beforeSettle?: (params:
    | {
        status: "complete";
        ctx: WorkflowContext<
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TRequests,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng,
          [],
          TErrors
        >;
        args: StandardSchemaV1.InferOutput<TArgs>;
        result: StandardSchemaV1.InferOutput<TResultSchema>;
      }
    | {
        status: "failed" | "terminated";
        ctx: CompensationContext<
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TRequests,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng
        >;
        args: StandardSchemaV1.InferOutput<TArgs>;
      }) => Promise<void>;

  /**
   * Workflow execution function.
   */
  execute(
    ctx: WorkflowContext<
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TRequests,
      TChildWorkflows,
      TForeignWorkflows,
      TPatches,
      TRng,
      [],
      TErrors
    >,
    args: StandardSchemaV1.InferOutput<TArgs>,
  ): Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}
