import type { JsonSchemaConstraint } from "../json-input";
import type { ErrorDefinitions } from "./errors";
import type { NoDefinitionExtension } from "./type-augmentation";

/**
 * Optional compensation payload schema and handler error codes for a
 * compensable request (`compensation` on `defineRequest`).
 *
 * When `TResultSchema` is set, `result` is required on the config object.
 */
export type RequestCompensationConfig<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> = (TResultSchema extends undefined
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- optional result slot; see type-augmentation.ts
  ? {}
  : { readonly result: TResultSchema }) & {
  readonly errors?: TCompensationErrors;
};

export type RequestCompensationDefinition<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> = true | RequestCompensationConfig<TResultSchema, TCompensationErrors>;

/**
 * Request definition — created via `defineRequest()`.
 *
 * Data-only: handlers register on `client.requests.<definitionName>`.
 * Workflow code supplies the payload and per-call options (priority,
 * observation timeout) at the accessor.
 */
export type RequestDefinition<
  TName extends string = string,
  TPayloadSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TCompensation extends
    | true
    | RequestCompensationConfig<any, any>
    | undefined = undefined,
> = {
  readonly name: TName;
  /** Payload schema for observable, serializable request input. */
  readonly payload: TPayloadSchema;
  /** Response schema for encoding/decoding resolved request data. */
  readonly response: TResponseSchema;
  /** Optional declared forward-handler error codes (`true` or schema per code). */
  readonly errors?: TErrors;
} & ([TCompensation] extends [undefined]
  ? NoDefinitionExtension
  : {
      readonly compensation: TCompensation;
    });

 
export type NonCompensableRequestDefinition = RequestDefinition<
  string,
  any,
  any,
  Record<string, never>,
  undefined
> & {
  readonly compensation?: never;
};
 

export type NonCompensableRequestDefinitions = Record<
  string,
  NonCompensableRequestDefinition
>;

/**
 * Map of request definitions.
 */
 
export type RequestDefinitions = Record<
  string,
  RequestDefinition<string, any, any, any, any>
>;
 
