import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { CompensationContext, WorkflowContext } from "../context/context-interfaces";
import type { BranchDefinitions } from "./branches";
import type { WorkflowErrorDefinitions } from "./errors";
import type { PatchDefinitions, ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./primitives";
import type { RequestDefinitions } from "./requests";
import type { RetentionSetter, StateFactory } from "./policies";
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
 * Workflows are durable, long-running processes that survive restarts via replay.
 * They communicate via channels, output data via streams, signal milestones via
 * events, and execute durable operations via steps.
 *
 * **Callable thenable model:** Steps and child workflows are called directly and
 * return thenables (`StepCall<T>`, `WorkflowCall<T>`) that can be awaited
 * immediately or chained with builder methods before awaiting.
 *
 * **Compensation:** Register per-step/workflow via `.compensate(cb)` builder.
 * `addCompensation(cb)` provides general-purpose cleanup. Runs LIFO on failure.
 *
 * **Structured concurrency:** All concurrent branches run as closures inside
 * `ctx.scope(name, ...)`. Collections (Array, Map) are supported for dynamic fan-out.
 */
export interface WorkflowDefinition<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions,
  TChildWorkflows extends WorkflowDefinitions,
  TForeignWorkflows extends WorkflowDefinitions,
  TBranches extends BranchDefinitions = Record<string, never>,
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

  /** State factory — provides initial state for each workflow instance */
  readonly state?: StateFactory<TState>;

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

  /** Predefined branch definitions (for ctx.branches) */
  readonly branches?: TBranches;

  /**
   * Patch definitions for safe workflow evolution.
   *
   * - `true`: Active — new workflows will execute the patched code path.
   * - `false`: Deprecated — new workflows skip the patch, but replaying workflows
   *   that already entered it will still run it.
   */
  readonly patches?: TPatches;

  /**
   * RNG definitions for deterministic randomness.
   *
   * - `true`: Simple named RNG stream — accessed as `ctx.rng.name`.
   * - Function: Parametrized RNG stream — accessed as `ctx.rng.name(...args)`.
   */
  readonly rng?: TRng;

  /** Result schema for encoding/decoding workflow result */
  readonly result?: TResultSchema;

  /** Arguments schema (optional) */
  readonly args?: TArgs;

  /**
   * Optional immutable metadata schema for workflow instances.
   * Metadata is provided at start time and persisted for audit/filtering.
   */
  readonly metadata?: TMetadata;

  /** Declared workflow business errors. */
  readonly errors?: TErrors;

  /**
   * Workflow retention policy for garbage collection.
   *
   * - If a number: Same retention for all terminal states (seconds).
   * - If RetentionSetter: Different retention per terminal state (seconds).
   * - If undefined: Workflows are never garbage collected.
   */
  readonly retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;

  /**
   * Passivation threshold for this workflow definition.
   *
   * When a workflow instance is suspended (e.g. sleeping, awaiting a step or
   * child workflow), the engine may evict it from memory and replay it later
   * once the awaited operation resolves — avoiding holding idle state in RAM.
   *
   * - If a positive number: evict after the workflow has been idle for at least
   *   this many seconds. The engine uses this as a hint; actual eviction timing
   *   may vary based on scheduler load.
   * - If `null`: never evict this workflow (keep it resident for the full lifetime).
   * - If `undefined`: inherit the engine-level `defaultEvictAfterSeconds`.
   */
  readonly evictAfterSeconds?: number | null;

  /**
   * Called once before final workflow status is settled.
   *
   * - `complete`: receives WorkflowContext + decoded result.
   * - `failed` / `terminated`: receives CompensationContext.
   *
   * If this hook throws on the complete path, the workflow transitions into
   * failure flow. The hook is single-shot and is not invoked a second time.
   */
  readonly beforeSettle?: (params:
    | {
        status: "complete";
        ctx: WorkflowContext<
          TState,
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
          TErrors,
          TBranches
        >;
        args: StandardSchemaV1.InferOutput<TArgs>;
        result: StandardSchemaV1.InferOutput<TResultSchema>;
      }
    | {
        status: "failed" | "terminated";
        ctx: CompensationContext<
          TState,
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
   * Must return z.input<ResultSchema> (encoded for DB).
   * Throwing an exception fails the workflow and triggers compensation.
   */
  execute(
    ctx: WorkflowContext<
      TState,
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
      TErrors,
      TBranches
    >,
    args: StandardSchemaV1.InferOutput<TArgs>,
  ): Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}
