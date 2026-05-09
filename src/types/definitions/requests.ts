import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonSchemaConstraint } from "../json-input";
import type {
  HandlerRetryOptions,
  RequestHandlerContext,
  Unsubscribe,
} from "./handlers";

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
 * Typed request/response with external handlers or manual resolution. Workflow
 * code supplies the payload and per-call options (priority, observation timeout)
 * at the accessor.
 *
 * `registerHandler` remains on the definition for early API shaping; durable
 * registration moves to the engine/client per `REFACTOR.MD` (alongside queues
 * and topics). The authoring helper currently returns a no-op unsubscribe.
 */
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
