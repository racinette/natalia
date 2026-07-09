import type { StandardSchemaV1 } from "./standard-schema";
import type { AttributeDefinitions, ChannelDefinitions, EventDefinitions, StreamDefinitions } from "./definitions/primitives";
import type { ErrorDefinitions } from "./definitions/errors";
import type { QueueDefinition, QueueDefinitions } from "./definitions/messaging";
import type { JsonSchemaConstraint } from "./json-input";
import type {
  RequestCompensationConfig,
  RequestDefinitions,
} from "./definitions/requests";
import type { StepDefinitions } from "./definitions/steps";
import type { WorkflowDefinitions } from "./definitions/workflow-headers";

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract result type from a workflow definition or header (decoded — z.output).
 */
export type InferWorkflowResult<W> = W extends {
  readonly result: infer TResultSchema extends StandardSchemaV1<unknown, unknown>;
}
  ? StandardSchemaV1.InferOutput<TResultSchema>
  : never;

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
 * Extract attributes from a workflow definition or public header.
 */
export type InferWorkflowAttributes<W> = W extends { attributes?: infer TAttributes }
  ? TAttributes extends AttributeDefinitions
    ? TAttributes
    : Record<string, never>
  : Record<string, never>;

/** True when the workflow declares a non-empty `attributes` map. */
export type HasWorkflowAttributes<W> =
  IsEmptyDefinitionMap<InferWorkflowAttributes<W>> extends true ? false : true;

/**
 * Extract per-instance stream definitions from a compensable step's
 * `compensation` block.
 */
export type InferStepCompensationStreams<S> = S extends {
  compensation?: infer C;
}
  ? C extends { streams?: infer TStreams }
    ? TStreams extends StreamDefinitions
      ? TStreams
      : Record<string, never>
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract per-instance channel definitions from a compensable step's
 * `compensation` block.
 */
export type InferStepCompensationChannels<S> = S extends {
  compensation?: infer C;
}
  ? C extends { channels?: infer TChannels }
    ? TChannels extends ChannelDefinitions
      ? TChannels
      : Record<string, never>
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract per-instance event definitions from a compensable step's
 * `compensation` block.
 */
export type InferStepCompensationEvents<S> = S extends {
  compensation?: infer C;
}
  ? C extends { events?: infer TEvents }
    ? TEvents extends EventDefinitions
      ? TEvents
      : Record<string, never>
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract per-instance attribute definitions from a compensable step's
 * `compensation` block.
 */
export type InferStepCompensationAttributes<S> = S extends {
  compensation?: infer C;
}
  ? C extends { attributes?: infer TAttributes }
    ? TAttributes extends AttributeDefinitions
      ? TAttributes
      : Record<string, never>
    : Record<string, never>
  : Record<string, never>;

/** True when inferred compensation primitive maps are non-empty. */
type IsEmptyDefinitionMap<T> = [T] extends [Record<string, never>] ? true : false;

/** True when the step's compensation block declares an `attributes` map. */
export type HasStepCompensationAttributes<S> =
  IsEmptyDefinitionMap<InferStepCompensationAttributes<S>> extends true
    ? false
    : true;

/** True when the step's compensation block declares a `channels` map. */
export type HasStepCompensationChannels<S> =
  IsEmptyDefinitionMap<InferStepCompensationChannels<S>> extends true
    ? false
    : true;

/** True when the step's compensation block declares an `events` map. */
export type HasStepCompensationEvents<S> =
  IsEmptyDefinitionMap<InferStepCompensationEvents<S>> extends true ? false : true;

/** True when the step's compensation block declares a `streams` map. */
export type HasStepCompensationStreams<S> =
  IsEmptyDefinitionMap<InferStepCompensationStreams<S>> extends true ? false : true;

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
export type InferWorkflowArgs<W> = W extends { args: infer TArgs }
  ? TArgs extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TArgs>
    : never
  : never;

/**
 * Extract arg input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.args.
 */
export type InferWorkflowArgsInput<W> = W extends { args: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TArgSchema>
    : never
  : never;

/**
 * Extract the args schema from a workflow definition or header.
 */
export type InferWorkflowArgsSchema<W> = W extends { args: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? TArgSchema
    : never
  : never;

/**
 * Extract metadata input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.metadata.
 */
export type InferWorkflowMetadataInput<W> = W extends {
  readonly metadata: infer TMetadataSchema extends StandardSchemaV1<unknown, unknown>;
}
  ? StandardSchemaV1.InferInput<TMetadataSchema>
  : never;

/**
 * Extract metadata type from a workflow definition or header (decoded — z.output).
 */
export type InferWorkflowMetadata<W> = W extends {
  readonly metadata: infer TMetadataSchema extends StandardSchemaV1<unknown, unknown>;
}
  ? StandardSchemaV1.InferOutput<TMetadataSchema>
  : never;

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

/**
 * `compensation` block from a request definition, or `undefined` when absent.
 */
export type InferRequestCompensationDef<R> = R extends {
  readonly compensation?: infer C;
}
  ? [C] extends [undefined]
    ? undefined
    : C extends true | RequestCompensationConfig<any, any>
      ? C
      : undefined
  : undefined;

