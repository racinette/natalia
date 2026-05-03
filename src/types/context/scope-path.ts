// =============================================================================
// SCOPE PATH — TYPES
// =============================================================================

/**
 * Ordered scope lineage from root to current scope.
 *
 * Without per-scope branches, the lineage is simply a sequence of scope names.
 * Each `ctx.scope("name", ...)` invocation appends one element.
 */
export type ScopePath = readonly string[];

export type IsPrefix<
  TPrefix extends ScopePath,
  TValue extends ScopePath,
> = TPrefix extends []
  ? true
  : TValue extends readonly [infer VH, ...infer VT extends ScopePath]
    ? TPrefix extends readonly [infer PH, ...infer PT extends ScopePath]
      ? [PH] extends [VH]
        ? [VH] extends [PH]
          ? IsPrefix<PT, VT>
          : false
        : false
      : false
    : false;

/**
 * Append a named scope to the current lineage.
 */
export type AppendScopeName<
  TScopePath extends ScopePath,
  TName extends string,
> = readonly [...TScopePath, TName];

/**
 * Scope name guard:
 * - Literal names cannot reuse any ancestor scope name.
 * - Widened `string` is allowed but loses compile-time collision guarantees.
 */
export type ScopeNameArg<
  TScopePath extends ScopePath,
  TName extends string,
> = string extends TName
  ? TName
  : string extends Extract<TScopePath[number], string>
    ? TName
    : TName extends Extract<TScopePath[number], string>
      ? never
      : TName;
