// =============================================================================
// OPERATOR SESSION — unified IO execution context for client-side durable access.
//
// Snapshot/command operator IO requires an explicit session (first argument).
// Watch IO (blocking reads, event/workflow waits) does not use sessions.
// =============================================================================

/** Declared backend semantics for an open operator session. */
export interface SessionCapabilities {
  /** Multi-op batches behave as one unit when true. */
  readonly atomic: boolean;
  /** Reads within the session share a consistent snapshot when true. */
  readonly isolated: boolean;
}

/** Who owns session finalization. */
export type SessionOrigin = "engine" | "adopted";

/**
 * Operator-facing session handle. Wraps a driver-specific raw transaction (or
 * equivalent) exposed synchronously for the entire session lifetime.
 */
export interface OperatorSession<
  TRaw,
  TOrigin extends SessionOrigin = SessionOrigin,
> {
  readonly capabilities: SessionCapabilities;
  readonly origin: TOrigin;
  readonly raw: TRaw;
}

/**
 * Storage backend for operator IO. Parameterised by the adoptable raw handle
 * type (`TRaw`). Engine-managed and adopted sessions share the same `TRaw`.
 */
export interface StorageDriver<TRaw> {
  session<R>(
    fn: (session: OperatorSession<TRaw, "engine">) => Promise<R>,
  ): Promise<R>;

  adoptSession(raw: TRaw): OperatorSession<TRaw, "adopted">;
}

/** Infer `TRaw` from a {@link StorageDriver} implementation type. */
export type InferSessionRaw<D> =
  D extends StorageDriver<infer R> ? R : never;
