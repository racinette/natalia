

// =============================================================================
// RETRY POLICY
// =============================================================================

/**
 * Retry **strategy** for a retried operation (step definition default, per-call
 * `retry` override, handler registration, and similar).
 *
 * Stop conditions (`maxAttempts`, wall-clock `timeout` on the workflow call) live
 * on the **call site** (`StepBoundary` / `timeout` option), not here. Without a
 * caller timeout, a step retries according to this policy until `execute`
 * succeeds or the workflow is terminated.
 */
export interface RetryPolicyOptions {
  /** Initial retry interval in seconds (default: 1) */
  intervalSeconds?: number;
  /** Backoff multiplier (default: 2) */
  backoffRate?: number;
  /** Maximum retry interval cap in seconds (default: 300) */
  maxIntervalSeconds?: number;
  /** Per-attempt timeout in seconds (default: no timeout) */
  timeoutSeconds?: number;
}

/**
 * Mutually exclusive deadline options for workflow start boundaries.
 */
export type DeadlineOptions =
  | { deadlineSeconds: number; deadlineUntil?: never }
  | { deadlineUntil: Date | number; deadlineSeconds?: never }
  | { deadlineSeconds?: undefined; deadlineUntil?: undefined };

/**
 * Required invocation field: when the schema decodes to `undefined`, callers
 * must pass the key with value `undefined` (omission is not allowed).
 */
export type RequiredInvocationField<
  K extends string,
  T,
> = [T] extends [undefined] ? { readonly [P in K]: undefined } : { readonly [P in K]: T };

/**
 * Base invocation options for workflow starts/calls.
 */
export type WorkflowInvocationBaseOptions<TArgsInput, TMetadataInput> =
  RequiredInvocationField<"args", TArgsInput> &
    RequiredInvocationField<"metadata", TMetadataInput> & {
      /**
       * Optional idempotency key for workflow identity.
       * If omitted, the engine generates a unique key.
       */
      idempotencyKey?: string;
      /** Optional deterministic RNG seed override for the child workflow instance. */
      seed?: string;
    };

// =============================================================================
// RETENTION
// =============================================================================

/**
 * Per-status retention policy. Maps each terminal status to how long rows at
 * that status should be kept in the database (seconds). null means never delete.
 * Omitting a status means no retention override for that status.
 */
export type RetentionSetter<TStatus extends string> = {
  readonly [K in TStatus]?: number | null;
};
