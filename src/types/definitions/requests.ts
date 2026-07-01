import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonSchemaConstraint } from "../json-input";
import type { ErrorDefinitions } from "./errors";
import type {
  RequestHandlerContext,
  RequestHandlerRegistrationOptions,
  Unsubscribe,
} from "./handlers";
import type { NoDefinitionExtension } from "./type-augmentation";

/**
 * Optional compensation payload schema and handler error codes for a
 * compensable request (`compensation` on `defineRequest`).
 */
export interface RequestCompensationConfig<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> {
  readonly result?: TResultSchema;
  readonly errors?: TCompensationErrors;
}

export type RequestCompensationDefinition<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> = true | RequestCompensationConfig<TResultSchema, TCompensationErrors>;

/**
 * Request definition — created via `defineRequest()`.
 *
 * Typed request/response with external handlers or manual resolution. Workflow
 * code supplies the payload and per-call options (priority, observation timeout)
 * at the accessor.
 *
 * `registerHandler` remains on the definition for early API shaping; durable
 * registration also lives on `client.requests.<definitionName>`.
 */
export type RequestDefinition<
  TName extends string = string,
  TPayloadSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TCompensation extends
    | RequestCompensationDefinition<
        JsonSchemaConstraint | undefined,
        ErrorDefinitions
      >
    | undefined = undefined,
> = {
  readonly name: TName;
  /** Payload schema for observable, serializable request input. */
  readonly payload: TPayloadSchema;
  /** Response schema for encoding/decoding resolved request data. */
  readonly response: TResponseSchema;
  /** Optional declared forward-handler error codes (`true` or schema per code). */
  readonly errors?: TErrors;
  registerHandler(
    handler: (
      payload: StandardSchemaV1.InferOutput<TPayloadSchema>,
      opts: RequestHandlerContext<TErrors>,
    ) => Promise<StandardSchemaV1.InferInput<TResponseSchema>>,
    options?: RequestHandlerRegistrationOptions<
      TErrors,
      StandardSchemaV1.InferOutput<TPayloadSchema>,
      StandardSchemaV1.InferInput<TResponseSchema>
    >,
  ): Unsubscribe;
} & ([TCompensation] extends [undefined]
  ? NoDefinitionExtension
  : {
      readonly compensation: TCompensation;
    });

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous non-compensable requests; schema slots stay top-like */
export type NonCompensableRequestDefinition = RequestDefinition<
  string,
  any,
  any,
  Record<string, never>,
  undefined
> & {
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
export type RequestDefinitions = Record<
  string,
  RequestDefinition<string, any, any, any, any>
>;
/* eslint-enable @typescript-eslint/no-explicit-any */
