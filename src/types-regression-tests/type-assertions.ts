/**
 * Shared type-level helpers for regression tests.
 *
 * `IsEqual` uses the covariant `<T>() => …` probe; each bare `T` is intentionally
 * single-use. Regression tests disable `@typescript-eslint/no-unnecessary-type-parameters`
 * in `eslint.config.mjs` for this folder so the probe stays valid.
 */

export type Assert<T extends true> = T;
export type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
