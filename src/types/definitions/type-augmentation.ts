/**
 * Neutral intersection operand for **optional type-level field augmentation**.
 *
 * `StepDefinition` / `RequestDefinition` are built as:
 *
 *     (base object shape) & ([TCompensation] extends [undefined] ? … : { compensation: … })
 *
 * When `TCompensation` is `undefined`, the second `&` must add **no** properties. Historically
 * that branch used `{}`, which triggers `@typescript-eslint/no-empty-object-type`. Replacements
 * like `Record<string, never>` introduce a string index signature and break inference when these
 * definitions appear in `steps: { … }` maps and similar concrete shapes.
 *
 * For object-like `T`, TypeScript treats `T & NoDefinitionExtension` as `T`, so this name reads as
 * “no extra definition fields merged here” while staying lint- and assignability-safe.
 */
export type NoDefinitionExtension = unknown;
