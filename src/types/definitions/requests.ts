import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonSchemaConstraint } from "../json-input";
import type {
  HandlerRetryOptions,
  RequestHandlerContext,
  Unsubscribe,
} from "./handlers";

/**
 * Request definition - created via defineRequest().
 *
 * Requests are typed request-response interactions with external handlers or
 * manual resolution. Workflow code controls payload, priority, and observation
 * timeout at call time.
 */
export interface RequestCompensationConfig<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
> {
  readonly result?: TResultSchema;
}

export type RequestCompensationDefinition<
  TResultSchema extends JsonSchemaConstraint | undefined = undefined,
> = true | RequestCompensationConfig<TResultSchema>;

export type RequestDefinition<
  TName extends string = string,
  TPayloadSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TCompensation extends
    | RequestCompensationDefinition<any>
    | undefined = undefined,
> = {
  readonly name: TName;
  /** Payload schema for observable, serializable request input. */
  readonly payload: TPayloadSchema;
  /** Response schema for encoding/decoding resolved request data. */
  readonly response: TResponseSchema;
  registerHandler(
    handler: (
      context: RequestHandlerContext,
      payload: StandardSchemaV1.InferOutput<TPayloadSchema>,
    ) => Promise<StandardSchemaV1.InferInput<TResponseSchema>>,
    options?: {
      readonly retryPolicy?: HandlerRetryOptions;
      readonly maxConcurrent?: number;
    },
  ): Unsubscribe;
} & ([TCompensation] extends [undefined]
  ? {}
  : {
      readonly compensation: TCompensation;
    });

export type NonCompensableRequestDefinition = RequestDefinition<
  string,
  any,
  any,
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
export type RequestDefinitions = Record<string, RequestDefinition<any, any, any, any>>;
