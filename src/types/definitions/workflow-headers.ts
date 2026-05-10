import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./primitives";
import type { WorkflowErrorDefinitions } from "./errors";

/**
 * Map of workflow definitions for child/external workflow references.
 * Accepts both full `WorkflowDefinition` objects and lightweight
 * `WorkflowHeader` descriptors — `WorkflowDefinition` satisfies
 * `AnyWorkflowHeader` structurally so the two are interchangeable here.
 */
export type WorkflowDefinitions = Record<string, AnyWorkflowHeader>;

/**
 * Public workflow descriptor for external/client-facing APIs.
 *
 * Captures the contract clients need to interact with workflow instances:
 * - identity (`name`)
 * - start contract (`args`, `metadata`)
 * - interaction surface (`channels`, `streams`, `events`)
 * - terminal payload contract (`result`)
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
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TResult extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
> {
  readonly name: TName;
  readonly channels?: TChannels;
  readonly streams?: TStreams;
  readonly events?: TEvents;
  readonly args?: TArgs;
  readonly metadata?: TMetadata;
  readonly result?: TResult;
  readonly errors?: TErrors;
}

/**
 * Any public workflow descriptor shape.
 */
export type AnyPublicWorkflowHeader = PublicWorkflowHeader<
  string,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

/**
 * Minimal workflow descriptor used by workflow authoring to break circular
 * dependencies between workflow modules.
 *
 * Use `defineWorkflowHeader()` to create one. Then:
 *
 * - Spread into `defineWorkflow({ ...header, ... })` so the full definition
 *   inherits the same name and schema declarations — single source of truth.
 * - Pass directly to `external` or `children.{attached,detached}` in any workflow
 *   that needs to reference this one.
 *
 * This resolves circular references cleanly: define the header first, use it
 * in both directions, then fill in the implementations afterward.
 *
 * ```typescript
 * const managerHeader = defineWorkflowHeader({
 *   name: "scheduler",
 *   channels: { done: DonePayload },
 * });
 *
 * // worker references manager via header — no circular dep
 * const workerWorkflow = defineWorkflow({
 *   ...workerHeader,
 *   external: { manager: managerHeader },
 *   execute: async (ctx, args) => { ... },
 * });
 *
 * // manager spreads its own header + adds full implementation
 * const managerWorkflow = defineWorkflow({
 *   ...managerHeader,
 *   children: { attached: { worker: workerWorkflow } },
 *   execute: async (ctx, args) => { ... },
 * });
 * ```
 *
 * A workflow can also reference itself (recursive/fractal workflows):
 * ```typescript
 * const treeHeader = defineWorkflowHeader({ name: "tree", args: TreeArgs });
 * const treeWorkflow = defineWorkflow({
 *   ...treeHeader,
 *   children: { attached: { node: treeHeader } },
 *   execute: async (ctx, args) => { ... },
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
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TResult extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
> {
  readonly name: TName;
  readonly channels?: TChannels;
  readonly args?: TArgs;
  readonly metadata?: TMetadata;
  readonly result?: TResult;
  readonly errors?: TErrors;
}

/**
 * Any workflow header shape.
 * Used as the constraint for `children` and `external` entries —
 * both full `WorkflowDefinition` objects and lightweight `WorkflowHeader`
 * descriptors satisfy this type.
 */
export type AnyWorkflowHeader = WorkflowHeader<string, any, any, any, any, any>;
