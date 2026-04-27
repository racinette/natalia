

/**
 * RNG definitions — keys are RNG stream names, values are either:
 *
 * - `true`: A simple named RNG stream. Accessed as `ctx.rng.name` (a `DeterministicRNG` instance).
 * - A key derivation function: A parametrized RNG stream. Accessed as `ctx.rng.name(...args)`
 *   which returns a `DeterministicRNG` instance. The function receives the parameters and
 *   returns a string key that the engine uses (prefixed with the definition name) to seed
 *   the RNG. Must be pure and deterministic — same arguments must always produce the same key.
 *
 * @example
 * ```typescript
 * rng: {
 *   txnId: true,                                               // simple
 *   itemsShuffle: (category: string) => `items:${category}`,   // parametrized
 * }
 * // ctx.rng.txnId.uuidv4()
 * // ctx.rng.itemsShuffle('electronics').shuffle(products)
 * ```
 */
export type RngDefinitions = Record<
  string,
  true | ((...args: any[]) => string)
>;

// =============================================================================
// DETERMINISTIC RNG
// =============================================================================

/**
 * Deterministic random utilities for use inside workflows.
 * Accessed through typed RNG accessors on the workflow context.
 */
export interface DeterministicRNG {
  /** Generate a deterministic UUID */
  uuidv4(): string;
  /** Generate a deterministic integer in range [min, max] */
  int(minInclusive?: number, maxInclusive?: number): number;
  /** Generate a deterministic float in range [0, 1) */
  next(): number;
  /** boolean with p = 0.5 */
  bool(): boolean;
  /** boolean with custom probability */
  chance(probability: number): boolean;
  /** Generate a deterministic string of length n */
  string(options: { length: number; alphabet?: string }): string;
  /** Pick a random element from an array */
  pick<T>(array: readonly T[]): T;
  /** Pick a random element from an array with weights */
  weightedPick<T>(items: readonly { value: T; weight: number }[]): T;
  /** Shuffle an array */
  shuffle<T>(array: readonly T[]): T[];
  /** Sample count elements from an array */
  sample<T>(array: readonly T[], count: number): T[];
  /** Sample count elements from an array with weights */
  weightedSample<T>(
    items: readonly { value: T; weight: number }[],
    count: number,
  ): T[];
  /** Generate a deterministic bytes array */
  bytes(length: number): Uint8Array;
}

/**
 * Map RNG definitions to their runtime accessor types.
 *
 * - `true` entries become `DeterministicRNG` instances (direct access).
 * - Function entries become functions with the same signature that return `DeterministicRNG`.
 */
export type RngAccessors<TRng extends RngDefinitions> = {
  [K in keyof TRng]: TRng[K] extends true
    ? DeterministicRNG
    : TRng[K] extends (...args: infer A) => string
      ? (...args: A) => DeterministicRNG
      : never;
};
