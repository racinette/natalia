import type { JsonSchemaConstraint } from "../json-input";

/**
 * A declared business error. `true` marks an error code with no details payload;
 * schema values validate and decode the details payload for that code.
 */
export type ErrorDefinition = JsonSchemaConstraint | true;

/**
 * Map of declared local business errors.
 */
export type ErrorDefinitions = Record<string, ErrorDefinition>;

/**
 * Map of declared workflow business errors.
 */
export type WorkflowErrorDefinitions = ErrorDefinitions;

/**
 * Branch-local error mode.
 *
 * - omitted / `"none"`: the branch has no declared business failures
 * - `"any"`: ordinary thrown values are captured as `Failure`
 * - map: only local `ctx.errors.X(...)` throws become typed business failures
 */
export type BranchErrorMode = ErrorDefinitions | "any" | "none";

/**
 * The explicit error map visible on a branch context.
 */
export type ExplicitBranchErrorDefinitions<TErrors extends BranchErrorMode> =
  TErrors extends ErrorDefinitions ? TErrors : Record<string, never>;
