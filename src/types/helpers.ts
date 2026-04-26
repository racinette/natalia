import type { StandardSchemaV1 } from "./standard-schema";
import type {
  WorkflowDefinition,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  ErrorDefinitions,
} from "./definitions";

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract result type from a workflow definition or header (decoded — z.output).
 */
export type InferWorkflowResult<W> = W extends {
  result?: infer TResultSchema;
}
  ? TResultSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TResultSchema>
    : void
  : void;

/**
 * Extract channels from a workflow definition or header.
 */
export type InferWorkflowChannels<W> = W extends {
  channels?: infer TChannels;
}
  ? TChannels extends ChannelDefinitions
    ? TChannels
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract streams from a workflow definition or public header.
 */
export type InferWorkflowStreams<W> = W extends { streams?: infer TStreams }
  ? TStreams extends StreamDefinitions
    ? TStreams
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract events from a workflow definition or public header.
 */
export type InferWorkflowEvents<W> = W extends { events?: infer TEvents }
  ? TEvents extends EventDefinitions
    ? TEvents
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract args schema from a workflow definition or header (decoded — z.output).
 */
export type InferWorkflowArgs<W> = W extends { args?: infer TArgs }
  ? TArgs extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TArgs>
    : void
  : void;

/**
 * Extract arg input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.args.
 */
export type InferWorkflowArgsInput<W> = W extends { args?: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TArgSchema>
    : void
  : void;

/**
 * Extract metadata input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.metadata.
 */
export type InferWorkflowMetadataInput<W> = W extends {
  metadata?: infer TMetadataSchema;
}
  ? TMetadataSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TMetadataSchema>
    : void
  : void;

/**
 * Extract declared workflow business errors.
 */
export type InferWorkflowErrors<W> = W extends { errors?: infer TErrors }
  ? TErrors extends ErrorDefinitions
    ? TErrors
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract state type from workflow definition.
 */
export type InferWorkflowState<W> =
  W extends WorkflowDefinition<
    infer TState,
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
  >
    ? TState
    : never;
