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
