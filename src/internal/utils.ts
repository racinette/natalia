import type { RetryPolicyOptions, TimeoutOption } from '../types';

// =============================================================================
// SLEEP UTILITIES
// =============================================================================

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep until a specific time
 */
export async function sleepUntil(deadline: Date): Promise<void> {
  const now = Date.now();
  const target = deadline.getTime();
  if (target > now) {
    await sleep(target - now);
  }
}

/**
 * Create a cancellable sleep that resolves when cancelled or timeout
 */
export function cancellableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<'timeout' | 'cancelled'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), ms);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        resolve('cancelled');
        return;
      }

      const onAbort = () => {
        clearTimeout(timeout);
        resolve('cancelled');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// =============================================================================
// TIMEOUT PARSING
// =============================================================================

/**
 * Parse a timeout option into milliseconds
 */
export function parseTimeoutMs(
  option: TimeoutOption | undefined,
  defaultMs: number,
): number {
  if (option === undefined) {
    return defaultMs;
  }
  if (typeof option === 'number') {
    return option * 1000; // Convert seconds to ms
  }
  // AbortSignal - use default (signal will interrupt)
  return defaultMs;
}

/**
 * Get an AbortSignal from a timeout option
 */
export function getAbortSignal(option: TimeoutOption | undefined): AbortSignal | undefined {
  if (option instanceof AbortSignal) {
    return option;
  }
  return undefined;
}

/**
 * Create a combined timeout with both duration and optional signal
 */
export function createTimeoutController(
  option: TimeoutOption | undefined,
  defaultMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutMs = parseTimeoutMs(option, defaultMs);
  
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  const externalSignal = getAbortSignal(option);
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeout);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => {
        clearTimeout(timeout);
        controller.abort();
      }, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

// =============================================================================
// RETRY UTILITIES
// =============================================================================

/**
 * Merge retry options, with runtime options taking precedence
 */
export function mergeRetryOptions(
  definition?: RetryPolicyOptions,
  runtime?: RetryPolicyOptions,
): Required<RetryPolicyOptions> {
  return {
    maxAttempts: runtime?.maxAttempts ?? definition?.maxAttempts ?? Infinity,
    intervalSeconds: runtime?.intervalSeconds ?? definition?.intervalSeconds ?? 1,
    backoffRate: runtime?.backoffRate ?? definition?.backoffRate ?? 2,
    maxIntervalSeconds: runtime?.maxIntervalSeconds ?? definition?.maxIntervalSeconds ?? 300,
    timeoutSeconds: runtime?.timeoutSeconds ?? definition?.timeoutSeconds ?? 0, // 0 = no timeout
  };
}

/**
 * Calculate delay for exponential backoff
 */
export function calculateBackoffMs(
  attempt: number,
  intervalSeconds: number,
  backoffRate: number,
  maxIntervalSeconds: number,
): number {
  const intervalMs = intervalSeconds * 1000;
  const maxIntervalMs = maxIntervalSeconds * 1000;
  const delay = intervalMs * Math.pow(backoffRate, attempt - 1);
  return Math.min(delay, maxIntervalMs);
}

// =============================================================================
// DEFERRED PROMISE
// =============================================================================

/**
 * A promise that can be resolved/rejected externally
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Create a deferred promise
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// =============================================================================
// MISC UTILITIES
// =============================================================================

/**
 * Generate a random executor ID
 */
export function generateExecutorId(): string {
  return `executor-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Assert a condition, throwing if false
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Create a promise that races between a value promise and a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  return Promise.race([
    promise,
    sleep(timeoutMs).then(() => timeoutValue),
  ]);
}

/**
 * Check if an error is a PostgreSQL error with a specific code
 */
export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === code
  );
}

/**
 * PostgreSQL error codes we care about
 */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  SERIALIZATION_FAILURE: '40001',
  LOCK_NOT_AVAILABLE: '55P03',
  CHECK_VIOLATION: '23514',
} as const;
