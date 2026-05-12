/**
 * Shared type-level helpers for regression tests.
 *
 * `IsEqual` uses the covariant `<T>() => …` probe; each bare `T` is intentionally
 * single-use. `@typescript-eslint/no-unnecessary-type-parameters` treats that as
 * redundant, but duplicating or removing those parameters breaks the check.
 */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */

export type Assert<T extends true> = T;
export type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
