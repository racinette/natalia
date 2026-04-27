import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonSchemaConstraint } from "../json-input";
import type { BranchContext } from "../context/context-interfaces";
import type { BranchErrorMode } from "./errors";
import type { RequestDefinitions } from "./requests";
import type { StepDefinitions } from "./steps";

/**
 * Branch definition — created via defineBranch().
 *
 * Branches are reusable, named units of concurrent workflow work with
 * serializable args, serializable result, and local business errors.
 */
export interface BranchDefinition<
  TArgsSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TErrors extends BranchErrorMode = Record<string, never>,
> {
  readonly name: string;
  /** Argument schema for observable, serializable branch input. */
  readonly args: TArgsSchema;
  /** Result schema for encoding/decoding. */
  readonly result: TResultSchema;
  /** Step dependencies visible to this branch. */
  readonly steps?: TSteps;
  /** Request dependencies visible to this branch. */
  readonly requests?: TRequests;
  /** Branch-local business error mode. */
  readonly errors?: TErrors;
  /** Execute function for this branch definition. */
  readonly execute: (
    context: BranchContext<TSteps, TRequests, TErrors>,
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}

/**
 * Map of branch definitions.
 */
export type BranchDefinitions = Record<string, BranchDefinition<any, any, any, any, any>>;
