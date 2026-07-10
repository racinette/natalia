import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { AttributeDefinitions, ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./primitives";
import type { WorkflowErrorDefinitions } from "./errors";

/**
 * Locked workflow contract slice shared by graph references and full headers.
 */
export interface WorkflowContractCore<
  TName extends string = string,
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
  readonly args: TArgs;
  readonly metadata: TMetadata;
  readonly result: TResult;
  readonly errors?: TErrors;
  readonly idempotencyKeyFactory?: TIdempotencyKeyFactory;
}

/**
 * Graph-safe workflow reference for `childWorkflows` / `externalWorkflows` maps
 * before `.extend()` adds streams and other interface fields.
 *
 * Created by `defineWorkflowHeader()`.
 */
export interface WorkflowReference<
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
> extends WorkflowContractCore<
  TName,
  TArgs,
  TMetadata,
  TResult,
  TErrors,
  TIdempotencyKeyFactory
> {
  readonly channels?: TChannels;
}

/**
 * Full public workflow contract for clients and operator surfaces.
 *
 * Satisfied by `WorkflowInterface` and `WorkflowDefinition`. Excludes
 * implementation details (`execute`, runnable step bodies, …).
 */
export interface WorkflowHeader<
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
> extends WorkflowContractCore<
  TName,
  TArgs,
  TMetadata,
  TResult,
  TErrors,
  TIdempotencyKeyFactory
> {
  readonly channels?: TChannels;
  readonly streams?: TStreams;
  readonly events?: TEvents;
  readonly attributes?: TAttributes;
}

/**
 * Map of workflow references for child/external workflow graph edges.
 */
export type WorkflowDefinitions = Record<string, AnyWorkflowReference>;

/**
 * Any graph-safe workflow reference shape.
 */
export type AnyWorkflowReference = WorkflowReference<
  string,
  ChannelDefinitions,
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  JsonSchemaConstraint,
  WorkflowErrorDefinitions,
   
  ((args: any) => string) | undefined
>;

/**
 * Any full public workflow contract shape (client / handle upper bound).
 */
export type AnyWorkflowHeader = WorkflowHeader<
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
