import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonObjectSchemaConstraint, JsonSchemaConstraint } from "../json-input";
import type { AttributeDefinitions, ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./primitives";
import type { WorkflowErrorDefinitions } from "./errors";

/**
 * Upper bound for identity blocks on erased workflow references / headers.
 */
export type AnyWorkflowIdentity = {
  readonly schema: JsonObjectSchemaConstraint;
  readonly deriveIdentity?: (...args: any[]) => any;
  readonly deriveIdempotencyKey: (...args: any[]) => string;
};

/**
 * Mandatory workflow identity configuration declared on every workflow header /
 * definition. `deriveIdempotencyKey` maps the decoded identity to the persisted
 * idempotency key; `deriveIdentity` is optional — when absent, callers supply
 * `identity` at start.
 */
export type WorkflowIdentityBlock<
  TIdentitySchema extends JsonObjectSchemaConstraint = JsonObjectSchemaConstraint,
  TArgs extends JsonSchemaConstraint = JsonSchemaConstraint,
  TMetadata extends JsonObjectSchemaConstraint = JsonObjectSchemaConstraint,
  TDeriveIdentity extends
    | ((input: {
        readonly args: StandardSchemaV1.InferOutput<TArgs>;
        readonly metadata: StandardSchemaV1.InferOutput<TMetadata>;
      }) => StandardSchemaV1.InferOutput<TIdentitySchema>)
    | undefined = undefined,
> = {
  readonly schema: TIdentitySchema;
  readonly deriveIdentity?: TDeriveIdentity;
  readonly deriveIdempotencyKey: (
    identity: StandardSchemaV1.InferOutput<TIdentitySchema>,
  ) => string;
};

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
  TIdentity extends AnyWorkflowIdentity = AnyWorkflowIdentity,
> {
  readonly name: TName;
  readonly args: TArgs;
  readonly metadata: TMetadata;
  readonly result: TResult;
  readonly errors?: TErrors;
  readonly identity: TIdentity;
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
  TIdentity extends AnyWorkflowIdentity = AnyWorkflowIdentity,
> extends WorkflowContractCore<
  TName,
  TArgs,
  TMetadata,
  TResult,
  TErrors,
  TIdentity
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
  TIdentity extends AnyWorkflowIdentity = AnyWorkflowIdentity,
> extends WorkflowContractCore<
  TName,
  TArgs,
  TMetadata,
  TResult,
  TErrors,
  TIdentity
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
  AnyWorkflowIdentity
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
  AnyWorkflowIdentity
>;
