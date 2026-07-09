import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { AttributeDefinitions, ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./primitives";
import type { WorkflowErrorDefinitions } from "./errors";

/**
 * Map of workflow definitions for child/external workflow references.
 * Accepts both full `WorkflowDefinition` objects and lightweight
 * `WorkflowHeader` descriptors — `WorkflowDefinition` satisfies
 * `AnyWorkflowHeader` structurally so the two are interchangeable here.
 */
export type WorkflowDefinitions = Record<string, AnyWorkflowHeader>;

/**
 * Public workflow descriptor for externalWorkflows/client-facing APIs.
 *
 * Captures the contract clients need to interact with workflow instances:
 * - identity (`name`)
 * - start contract (`args`, `metadata`, `result`)
 * - interaction surface (`channels`, `streams`, `events`)
 * - terminal payload contract (`result` schema)
 *
 * This type intentionally excludes implementation details (`execute`, `steps`,
 * `rng`, hooks, etc.). Full `WorkflowDefinition` objects satisfy this
 * shape structurally and can be used where only client contracts are needed.
 */
export interface PublicWorkflowHeader<
  TName extends string = string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends JsonObjectSchemaConstraint = JsonObjectSchemaConstraint,
  TResult extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TIdempotencyKeyFactory extends
    | ((args: StandardSchemaV1.InferOutput<TArgs>) => string)
    | undefined = undefined,
> {
  readonly name: TName;
  readonly channels?: TChannels;
  readonly streams?: TStreams;
  readonly events?: TEvents;
  readonly attributes?: TAttributes;
  readonly args: TArgs;
  readonly metadata: TMetadata;
  readonly result: TResult;
  readonly errors?: TErrors;
  /**
   * Optional factory deriving this workflow's idempotency key from its decoded
   * args. See `WorkflowHeader.idempotencyKeyFactory`.
   */
  readonly idempotencyKeyFactory?: TIdempotencyKeyFactory;
}

/**
 * Any public workflow descriptor shape.
 */
export type AnyPublicWorkflowHeader = PublicWorkflowHeader<
  string,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  AttributeDefinitions,
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  JsonSchemaConstraint,
  WorkflowErrorDefinitions,
   
  ((args: any) => string) | undefined
>;

/**
 * Minimal workflow descriptor used by workflow authoring to break circular
 * dependencies between workflow modules.
 *
 * Use `defineWorkflowHeader()` to create one. Then:
 *
 * - Call **`header.extend({ ... })`** to add streams, events, steps, and other
 *   public interface fields without restating the header slice.
 * - Call **`.implement({ execute, ... })`** on the interface for the runnable
 *   workflow definition.
 * - Pass the header directly to `externalWorkflows` or `childWorkflows` in any
 *   workflow that needs to reference this one before the full implementation exists.
 *
 * This resolves circular references cleanly: define the header first, use it
 * in both directions, then fill in the implementations afterward.
 *
 * ```typescript
 * const managerHeader = defineWorkflowHeader({
 *   name: "scheduler",
 *   args: z.undefined(),
 *   metadata: z.undefined(),
 *   result: z.void(),
 *   channels: { done: DonePayload },
 * });
 *
 * // worker references manager via header — no circular dep
 * const workerWorkflow = workerHeader.extend({}).implement({
 *   externalWorkflows: { manager: managerHeader },
 *   execute: async (ctx) => { ... },
 * });
 *
 * // manager: header → interface → implementation
 * const managerWorkflow = managerHeader.extend({
 *   childWorkflows: { worker: workerWorkflow },
 * }).implement({
 *   execute: async (ctx) => { ... },
 * });
 * ```
 *
 * A workflow can also reference itself (recursive/fractal workflows):
 * ```typescript
 * const treeHeader = defineWorkflowHeader({
 *   name: "tree",
 *   args: TreeArgs,
 *   metadata: z.undefined(),
 *   result: z.void(),
 * });
 * const treeWorkflow = treeHeader.extend({
 *   childWorkflows: { node: treeHeader },
 * }).implement({
 *   execute: async (ctx) => { ... },
 * });
 * ```
 */
export interface WorkflowHeader<
  TName extends string = string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends JsonObjectSchemaConstraint = JsonObjectSchemaConstraint,
  TResult extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TIdempotencyKeyFactory extends
    | ((args: StandardSchemaV1.InferOutput<TArgs>) => string)
    | undefined = undefined,
> {
  readonly name: TName;
  readonly channels?: TChannels;
  readonly args: TArgs;
  readonly metadata: TMetadata;
  readonly result: TResult;
  readonly errors?: TErrors;
  /**
   * Optional factory deriving this workflow's idempotency key from its decoded
   * args. When present, identity is derived from args (callers must not pass an
   * explicit `idempotencyKey`, and lookups address it by args); when absent, the
   * caller owns the key.
   */
  readonly idempotencyKeyFactory?: TIdempotencyKeyFactory;
}

/**
 * Any workflow header shape.
 * Used as the constraint for `childWorkflows` and `externalWorkflows` entries —
 * both full `WorkflowDefinition` objects and lightweight `WorkflowHeader`
 * descriptors satisfy this type.
 */
export type AnyWorkflowHeader = WorkflowHeader<
  string,
  ChannelDefinitions,
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  JsonSchemaConstraint,
  WorkflowErrorDefinitions,
   
  ((args: any) => string) | undefined
>;
