import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonSchemaConstraint } from "../json-input";
import type { BranchContext } from "../context/context-interfaces";
import type { BranchErrorMode } from "./errors";
import type {
  ChannelDefinitions,
  EventDefinitions,
  PatchDefinitions,
  StreamDefinitions,
} from "./primitives";
import type { RequestDefinitions } from "./requests";
import type { RngDefinitions } from "./rng";
import type { StepDefinitions } from "./steps";
import type { WorkflowDefinitions } from "./workflow-headers";
import type { ScopePath } from "../context/scope-path";

/**
 * Branch definition — declared inline on `defineWorkflow.branches` or
 * `defineStep.compensation.branches`.
 *
 * Branches are workflow-scoped concurrent units of work. They share the
 * parent workflow's primitive plane (channels, streams, events, attributes)
 * and dependency surface (steps, requests, child workflows). They differ
 * from workflow code only in two ways: their args/result are serializable
 * and per-invocation queryable, and their `errors` namespace is local to
 * the branch (no cross-level error access).
 *
 * There is no top-level `defineBranch` factory; the map key on
 * `branches: { foo: { ... } }` serves as the branch name.
 */
export interface BranchDefinition<
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends BranchErrorMode = Record<string, never>,
> {
  /** Argument schema for observable, serializable branch input. */
  readonly args: TArgsSchema;
  /** Result schema for encoding/decoding. */
  readonly result: TResultSchema;
  /** Branch-local business error mode. */
  readonly errors?: TErrors;
  /**
   * Branch body. Receives a `BranchContext` whose primitive and dependency
   * namespaces are inherited from the parent workflow (set by `defineWorkflow`
   * type inference at the top-level wiring). The `errors` namespace is the
   * branch's own — never the workflow's.
   */
  readonly execute: (
    context: BranchContext<
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
      TErrors,
      any
    >,
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}

/**
 * Map of branch definitions on a workflow.
 */
export type BranchDefinitions = Record<string, BranchDefinition<any, any, any>>;

/**
 * A branch definition shape parameterised by the parent workflow's primitive
 * surface. `defineWorkflow` uses this to enforce that each branch's `execute`
 * receives a context bound to the workflow's declared steps, requests,
 * childWorkflows, channels, streams, events, branches (recursive), patches,
 * rng — plus the branch's own `errors`.
 *
 * The branch literal MUST NOT redeclare any of those — they are inherited.
 */
export interface BranchDefinitionWithin<
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions,
  TChildWorkflows extends WorkflowDefinitions,
  TForeignWorkflows extends WorkflowDefinitions,
  TBranches extends BranchDefinitions,
  TPatches extends PatchDefinitions,
  TRng extends RngDefinitions,
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends BranchErrorMode = Record<string, never>,
  TScopePath extends ScopePath = [],
> {
  readonly args: TArgsSchema;
  readonly result: TResultSchema;
  readonly errors?: TErrors;
  readonly execute: (
    context: BranchContext<
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TRequests,
      TChildWorkflows,
      TForeignWorkflows,
      TBranches,
      TPatches,
      TRng,
      TErrors,
      TScopePath
    >,
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}
