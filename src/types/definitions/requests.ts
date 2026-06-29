import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonSchemaConstraint } from "../json-input";
import type {
  HandlerRetryOptions,
  RequestHandlerContext,
  Unsubscribe,
} from "./handlers";
import type { NoDefinitionExtension } from "./type-augmentation";

/**
 * Optional compensation payload schema for a compensable request (`compensation`
 * on `defineRequest`).
 */
export interface RequestCompensationConfig<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
> {
  readonly result?: TResultSchema;
}

export type RequestCompensationDefinition<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
> = true | RequestCompensationConfig<TResultSchema>;

/**
 * Request definition — created via `defineRequest()`.
 *
 * Typed request/response with externalWorkflows handlers or manual resolution. Workflow
 * code supplies the payload and per-call options (priority, observation timeout)
 * at the accessor.
 *
 * `registerHandler` remains on the definition for early API shaping; durable
 * registration moves to the engine/client per `REFACTOR.MD` (alongside queues
 * and topics). The authoring helper currently returns a no-op unsubscribe.
 *
 * The trailing `& ([TCompensation] extends [undefined] ? NoDefinitionExtension : { … })` uses
 * {@link NoDefinitionExtension} so “no compensation” is spelled explicitly at the type level
 * (see `type-augmentation.ts`).
 */
export type RequestDefinition<
  TName extends string = string,
  TPayloadSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TCompensation extends
    | RequestCompensationDefinition<JsonSchemaConstraint | undefined>
    | undefined = undefined,
> = {
  readonly name: TName;
  /** Payload schema for observable, serializable request input. */
  readonly payload: TPayloadSchema;
  /** Response schema for encoding/decoding resolved request data. */
  readonly response: TResponseSchema;
  registerHandler(
    handler: (
      payload: StandardSchemaV1.InferOutput<TPayloadSchema>,
      opts: RequestHandlerContext,
    ) => Promise<StandardSchemaV1.InferInput<TResponseSchema>>,
    options?: {
      readonly retryPolicy?: HandlerRetryOptions;
      readonly maxConcurrent?: number;
    },
  ): Unsubscribe;
} & ([TCompensation] extends [undefined]
  ? NoDefinitionExtension
  : {
      readonly compensation: TCompensation;
    });

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous non-compensable requests; schema slots stay top-like */
export type NonCompensableRequestDefinition = RequestDefinition<string, any, any, undefined> & {
  readonly compensation?: never;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type NonCompensableRequestDefinitions = Record<
  string,
  NonCompensableRequestDefinition
>;

/**
 * Map of request definitions.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous request map */
export type RequestDefinitions = Record<string, RequestDefinition<string, any, any, any>>;
/* eslint-enable @typescript-eslint/no-explicit-any */
