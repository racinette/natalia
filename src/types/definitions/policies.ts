

// =============================================================================
// RETRY POLICY
// =============================================================================

/**
 * Configuration for retry behavior and timeouts.
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
 * Base invocation options for workflow starts/calls.
 */
export type WorkflowInvocationBaseOptions<TArgsInput, TMetadataInput> = {
  /**
   * Optional idempotency key for workflow identity.
   * If omitted, the engine generates a unique key.
   */
  idempotencyKey?: string;
  args?: TArgsInput;
  /** Optional immutable metadata for this workflow instance. */
  metadata?: TMetadataInput;
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

// =============================================================================
// STATE FACTORY
// =============================================================================

/**
 * State factory type for a workflow.
 *
 * Provides the initial state for each workflow instance.
 * State is NOT persisted to the database — it is derived from replay.
 */
export type StateFactory<TState> = () => TState;
