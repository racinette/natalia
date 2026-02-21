import { createHash } from 'crypto';
import type { DeterministicRNG } from '../types';

// =============================================================================
// DETERMINISTIC RNG IMPLEMENTATION
// =============================================================================

/**
 * Deterministic RNG implementation using SHA-256 hashing
 * 
 * Uses workflow seed + name + counter to generate deterministic random values.
 * The same seed + name will always produce the same sequence of values.
 */
export class DeterministicRNGImpl implements DeterministicRNG {
  private counter = 0;
  private readonly seedHash: Buffer;

  constructor(workflowSeed: string, name: string) {
    // Combine workflow seed + name for unique RNG stream
    this.seedHash = createHash('sha256')
      .update(workflowSeed + '::' + name)
      .digest();
  }

  /**
   * Generate next deterministic value in [0, 1)
   */
  next(): number {
    const hash = createHash('sha256')
      .update(this.seedHash)
      .update('::' + this.counter++)
      .digest();

    // Use first 6 bytes for better precision (48 bits)
    // This gives us ~15 significant digits
    const value = hash.readUIntBE(0, 6) / 0xffffffffffff;
    return value;
  }

  /**
   * Generate a deterministic UUID v4
   */
  uuidv4(): string {
    const hash = createHash('sha256')
      .update(this.seedHash)
      .update('::uuid::' + this.counter++)
      .digest();

    // Format as UUID v4
    const hex = hash.toString('hex').slice(0, 32);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      '4' + hex.slice(13, 16), // Version 4
      ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20), // Variant
      hex.slice(20, 32),
    ].join('-');
  }

  /**
   * Generate a deterministic integer in range [min, max] (inclusive)
   */
  int(minInclusive = 0, maxInclusive = Number.MAX_SAFE_INTEGER): number {
    if (minInclusive > maxInclusive) {
      throw new Error('min must be <= max');
    }
    const range = maxInclusive - minInclusive + 1;
    return Math.floor(this.next() * range) + minInclusive;
  }

  /**
   * Generate a deterministic boolean (50% chance)
   */
  bool(): boolean {
    return this.next() < 0.5;
  }

  /**
   * Generate a deterministic boolean with custom probability
   */
  chance(probability: number): boolean {
    if (probability < 0 || probability > 1) {
      throw new Error('probability must be between 0 and 1');
    }
    return this.next() < probability;
  }

  /**
   * Generate a deterministic string
   */
  string(options: { length: number; alphabet?: string }): string {
    const alphabet = options.alphabet ?? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < options.length; i++) {
      result += alphabet[this.int(0, alphabet.length - 1)];
    }
    return result;
  }

  /**
   * Pick a random element from an array
   */
  pick<T>(array: readonly T[]): T {
    if (array.length === 0) {
      throw new Error('Cannot pick from empty array');
    }
    return array[this.int(0, array.length - 1)];
  }

  /**
   * Pick a random element with weights
   */
  weightedPick<T>(items: readonly { value: T; weight: number }[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from empty array');
    }

    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) {
      throw new Error('Total weight must be positive');
    }

    let random = this.next() * totalWeight;
    for (const item of items) {
      random -= item.weight;
      if (random <= 0) {
        return item.value;
      }
    }

    // Fallback (should not happen)
    return items[items.length - 1].value;
  }

  /**
   * Shuffle an array (Fisher-Yates)
   */
  shuffle<T>(array: readonly T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * Sample count elements from an array (without replacement)
   */
  sample<T>(array: readonly T[], count: number): T[] {
    if (count > array.length) {
      throw new Error('Cannot sample more elements than array length');
    }
    if (count < 0) {
      throw new Error('Count must be non-negative');
    }
    return this.shuffle(array).slice(0, count);
  }

  /**
   * Sample with weights (without replacement)
   */
  weightedSample<T>(items: readonly { value: T; weight: number }[], count: number): T[] {
    if (count > items.length) {
      throw new Error('Cannot sample more elements than array length');
    }
    if (count < 0) {
      throw new Error('Count must be non-negative');
    }

    const result: T[] = [];
    const remaining = [...items];

    for (let i = 0; i < count; i++) {
      const totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);
      let random = this.next() * totalWeight;

      for (let j = 0; j < remaining.length; j++) {
        random -= remaining[j].weight;
        if (random <= 0) {
          result.push(remaining[j].value);
          remaining.splice(j, 1);
          break;
        }
      }
    }

    return result;
  }

  /**
   * Generate deterministic bytes
   */
  bytes(length: number): Uint8Array {
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i += 32) {
      const hash = createHash('sha256')
        .update(this.seedHash)
        .update('::bytes::' + this.counter++)
        .digest();

      const copyLength = Math.min(32, length - i);
      result.set(hash.subarray(0, copyLength), i);
    }
    return result;
  }
}

// =============================================================================
// RNG MANAGER
// =============================================================================

/**
 * Manages RNG instances for a workflow execution
 * 
 * Caches RNG instances by name to ensure the same name always returns
 * the same RNG instance (and thus the same sequence of values).
 */
export class RNGManager {
  private readonly cache = new Map<string, DeterministicRNGImpl>();

  constructor(private readonly workflowSeed: string) {}

  /**
   * Get (or create) an RNG instance for the given name
   */
  get(name: string): DeterministicRNG {
    let rng = this.cache.get(name);
    if (!rng) {
      rng = new DeterministicRNGImpl(this.workflowSeed, name);
      this.cache.set(name, rng);
    }
    return rng;
  }

  /**
   * Reset all RNG instances (for testing)
   */
  reset(): void {
    this.cache.clear();
  }
}
