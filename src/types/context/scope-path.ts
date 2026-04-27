import type { BranchEntry } from "./scope-results";

// =============================================================================
// SCOPE PATH — SYMBOLS AND TYPES
// =============================================================================

declare const scopeDivider: unique symbol;
declare const branchDivider: unique symbol;

/**
 * Divider inserted into a scope path between a scope's parent path and its name.
 * Distinguishes scope name transitions from branch key transitions.
 */
export type ScopeDivider = typeof scopeDivider;

/**
 * Divider inserted into a scope path between a scope name and a branch key.
 * Distinguishes branch key transitions from scope name transitions.
 */
export type BranchDivider = typeof branchDivider;

/** Runtime-accessible scope divider value for path inspection. */
export { scopeDivider, branchDivider };

/**
 * Ordered scope lineage from root to current scope.
 * Elements are strings (scope names / branch keys) interleaved with
 * `ScopeDivider` and `BranchDivider` symbols to maintain structural
 * unambiguity at both type level and runtime.
 */
export type ScopePath = readonly (string | ScopeDivider | BranchDivider)[];

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
 * Append a named scope to the current lineage, inserting a `scopeDivider` before the name.
 */
export type AppendScopeName<
  TScopePath extends ScopePath,
  TName extends string,
> = [...TScopePath, ScopeDivider, TName];

/**
 * Append a branch key to the current lineage, inserting a `branchDivider` before the key.
 */
export type AppendBranchKey<
  TScopePath extends ScopePath,
  TKey extends string,
> = [...TScopePath, BranchDivider, TKey];

/**
 * Scope name guard:
 * - Literal names cannot reuse any ancestor scope name (string elements only).
 * - Widened `string` is allowed but loses compile-time collision guarantees.
 *
 * **Limitation**: once a dynamic (non-literal) string is used as a scope entry
 * key, the ancestor scope path contains a wide `string` type. At that point the
 * collision check is bypassed for all nested scopes and branch closures created
 * from that entry — TypeScript cannot distinguish individual runtime keys from
 * each other at the type level. If you use dynamic keys, you are responsible for
 * ensuring scope name uniqueness manually.
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

/**
 * Rest-parameter constraint for `ctx.join()` scope-path enforcement.
 *
 * - For a plain `DurableHandle` (no scope path), resolves to `[]` — no path check needed.
 * - For a `BranchHandle<T, THandlePath>`, resolves to `[]` when `THandlePath` is a prefix
 *   of the current scope path `TCurrentPath`, or to an error tuple otherwise.
 */
export type IsJoinableByPath<H, TCurrentPath extends ScopePath> =
  H extends BranchEntry<any, infer THandlePath, any>
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? []
      : [
          "Handle scope path is not accessible from the current scope — the handle was created in a scope that has already closed or is not an ancestor of the current scope",
        ]
    : [];
