import type { StandardSchemaV1 } from "./standard-schema";

/**
 * JSON-like input value allowed for persisted schemas.
 *
 * Includes `undefined` so optional/absent keys can be modeled at schema-input
 * level where needed.
 */
export type JsonInput =
  | undefined
  | string
  | number
  | boolean
  | null
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput };

/**
 * Top-level JSON object input shape.
 */
export type JsonInputObject = {
  readonly [key: string]: JsonInput;
};

/**
 * Generic persisted-schema constraint: input must be JSON-like (or void).
 */
export type JsonSchemaConstraint = StandardSchemaV1<
  JsonInput | void | undefined,
  unknown
>;

/**
 * Object-only persisted-schema constraint: input must be a JSON-like object
 * (or void). Useful for metadata-like shapes.
 */
export type JsonObjectSchemaConstraint = StandardSchemaV1<
  JsonInputObject | void | undefined,
  unknown
>;
