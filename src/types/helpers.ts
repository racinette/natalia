import type { StandardSchemaV1 } from "./standard-schema";
import type { ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./definitions/primitives";
import type { ErrorDefinitions } from "./definitions/errors";
import type { QueueDefinitions } from "./definitions/messaging";
import type { RequestDefinitions } from "./definitions/requests";
import type { StepDefinitions } from "./definitions/steps";
import type { WorkflowDefinitions } from "./definitions/workflow-headers";

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
 * Extract the args *schema* itself (not its decoded/encoded value) from a
 * workflow definition or header. Resolves to `never` when no args schema is
 * declared.
 */
export type InferWorkflowArgsSchema<W> = W extends { args?: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? TArgSchema
    : never
  : never;

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
 * Extract metadata type from a workflow definition or header (decoded — z.output).
 */
export type InferWorkflowMetadata<W> = W extends {
  metadata?: infer TMetadataSchema;
}
  ? TMetadataSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TMetadataSchema>
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
 * Extract declared workflow steps from a full workflow definition.
 *
 * Header-only workflow descriptors do not carry this field and resolve to
 * `never` so callers can choose an explicit fallback policy.
 */
export type InferWorkflowSteps<W> = W extends { steps?: infer TSteps }
  ? TSteps extends StepDefinitions
    ? TSteps
    : never
  : never;

/**
 * Extract declared workflow requests from a full workflow definition.
 *
 * Header-only workflow descriptors do not carry this field and resolve to
 * `never` so callers can choose an explicit fallback policy.
 */
export type InferWorkflowRequests<W> = W extends { requests?: infer TRequests }
  ? TRequests extends RequestDefinitions
    ? TRequests
    : never
  : never;

/**
 * Extract declared workflow queues from a full workflow definition.
 *
 * Header-only workflow descriptors do not carry this field and resolve to
 * `never` so callers can choose an explicit fallback policy.
 */
export type InferWorkflowQueues<W> = W extends { queues?: infer TQueues }
  ? TQueues extends QueueDefinitions
    ? TQueues
    : never
  : never;

/**
 * Extract declared attached child workflows from a full workflow definition.
 *
 * Header-only workflow descriptors do not carry this field and resolve to
 * `never` so callers can choose an explicit fallback policy.
 */
export type InferWorkflowChildren<W> = W extends { childWorkflows?: infer TChildren }
  ? TChildren extends WorkflowDefinitions
    ? TChildren
    : never
  : never;

/**
 * @deprecated Attached/detached is now a call-site mode over the single
 * declared declared child-workflow set; this alias resolves to the full set. Kept for the
 * operator-side `childWorkflows.attached` query view.
 */
export type InferWorkflowAttachedChildren<W> = InferWorkflowChildren<W>;

/**
 * Extract declared detached child workflows from a full workflow definition.
 *
 * Header-only workflow descriptors do not carry this field and resolve to
 * `never` so callers can choose an explicit fallback policy.
 */
/**
 * @deprecated Attached/detached is now a call-site mode over the single
 * declared declared child-workflow set; this alias resolves to the full set. Kept for the
 * operator-side `childWorkflows.detached` query view.
 */
export type InferWorkflowDetachedChildren<W> = InferWorkflowChildren<W>;

/**
 * Extract declared external workflow dependencies from a full workflow definition.
 *
 * Header-only workflow descriptors do not carry this field and resolve to
 * `never` so callers can choose an explicit fallback policy.
 */
export type InferWorkflowExternal<W> = W extends {
  externalWorkflows?: infer TExternalWorkflows;
}
  ? TExternalWorkflows extends WorkflowDefinitions
    ? TExternalWorkflows
    : never
  : never;

/**
 * Extract the `idempotencyKeyFactory` declared on a workflow header/definition,
 * or `undefined` when none is declared.
 */
export type InferIdempotencyKeyFactory<W> = W extends {
  idempotencyKeyFactory?: infer TFactory;
}
  ? TFactory extends (args: never) => string
    ? TFactory
    : undefined
  : undefined;

/**
 * True when the workflow declares an `idempotencyKeyFactory` — its identity key
 * is derived from args, so callers must NOT pass an explicit `idempotencyKey`
 * (and lookups address it by `args`). False when no factory is declared — the
 * caller owns the key.
 */
export type HasIdempotencyFactory<W> =
  InferIdempotencyKeyFactory<W> extends (args: never) => never
    ? false // the `=> never` sentinel that `define*` uses for "no factory declared"
    : InferIdempotencyKeyFactory<W> extends (args: never) => string
      ? true
      : false;

