import type { StandardSchemaV1 } from "./standard-schema";
import type { ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./definitions/primitives";
import type { ErrorDefinitions } from "./definitions/errors";
import type { QueueDefinition, QueueDefinitions } from "./definitions/messaging";
import type { JsonSchemaConstraint } from "./json-input";
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
 * Extract declared child workflows from a full workflow definition.
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

/**
 * True when a queue definition declares `defaultTtl` on `defineQueue` — enqueue
 * may omit `ttl` and inherit the default. False when `defaultTtl` was omitted
 * at definition time — enqueue must pass `ttl` explicitly.
 *
 * Mirrors {@link HasIdempotencyFactory}: discrimination is on an inferred generic
 * (`TDefaultTtl`), not on the optional `defaultTtl` property (optional properties
 * always union with `undefined`, so property presence cannot be narrowed).
 */
export type HasDefaultTtl<Q> = Q extends QueueDefinition<
  string,
  JsonSchemaConstraint,
  ErrorDefinitions,
  infer TDefaultTtl
>
  ? [TDefaultTtl] extends [undefined]
    ? false
    : true
  : false;

/**
 * Declared handler error map from a queue definition, or an empty map when
 * `defineQueue` omitted `errors`.
 */
export type InferQueueErrors<Q> = Q extends { readonly errors?: infer E }
  ? [E] extends [undefined]
    ? Record<string, never>
    : E extends ErrorDefinitions
      ? E
      : Record<string, never>
  : Record<string, never>;

/**
 * True when `defineQueue` declared a non-empty `errors` map — `ctx.errors`
 * exposes factories. False when omitted or empty.
 */
export type HasQueueErrors<Q> = InferQueueErrors<Q> extends Record<string, never>
  ? false
  : true;

/**
 * Declared forward-handler error map from a request definition, or an empty map
 * when `defineRequest` omitted `errors`.
 */
export type InferRequestErrors<R> = R extends { readonly errors?: infer E }
  ? [E] extends [undefined]
    ? Record<string, never>
    : E extends ErrorDefinitions
      ? E
      : Record<string, never>
  : Record<string, never>;

/**
 * True when `defineRequest` declared a non-empty forward `errors` map.
 */
export type HasRequestErrors<R> = InferRequestErrors<R> extends Record<string, never>
  ? false
  : true;

/**
 * Declared compensation-handler error map from a request definition, or an empty
 * map when compensation omitted `errors`.
 */
export type InferRequestCompensationErrors<R> = R extends {
  readonly compensation?: infer C;
}
  ? C extends { readonly errors?: infer E }
    ? [E] extends [undefined]
      ? Record<string, never>
      : E extends ErrorDefinitions
        ? E
        : Record<string, never>
    : Record<string, never>
  : Record<string, never>;

/**
 * True when request compensation declared a non-empty `errors` map.
 */
export type HasRequestCompensationErrors<R> =
  InferRequestCompensationErrors<R> extends Record<string, never> ? false : true;

