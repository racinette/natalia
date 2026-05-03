// =============================================================================
// ROOT SCOPE BRANDING
// =============================================================================

declare const executionRoot: unique symbol;
declare const compensationRoot: unique symbol;

/**
 * Discriminates whether a context is an execution-phase context or a
 * compensation-phase context.
 *
 * Used by the resolver marker interfaces below.
 */
export type RootScope = typeof executionRoot | typeof compensationRoot;

/** @internal Used as the `TRoot` type parameter on execution-context handles. */
export type ExecutionRoot = typeof executionRoot;

/** @internal Used as the `TRoot` type parameter on compensation-context handles. */
export type CompensationRoot = typeof compensationRoot;

// =============================================================================
// RESOLVER MARKER INTERFACES
// =============================================================================

declare const executionResolverBrand: unique symbol;
declare const compensationResolverBrand: unique symbol;

/**
 * Marker interface satisfied by all execution-phase contexts
 * (`WorkflowContext`, `WorkflowConcurrencyContext`).
 */
export interface ExecutionResolver {
  /** @internal Brand — do not access at runtime. */
  readonly [executionResolverBrand]: true;
}

/**
 * Marker interface satisfied by all compensation-phase contexts
 * (`CompensationContext`, `CompensationConcurrencyContext`).
 */
export interface CompensationResolver {
  /** @internal Brand — do not access at runtime. */
  readonly [compensationResolverBrand]: true;
}

// =============================================================================
// INTERNAL AWAITABLE SHAPES
//
// `AtomicResult<T>` and `BlockingResult<T>` are *internal* awaitable shapes
// used by buffered operations and awaitable waits respectively. They are not
// exposed on the public type surface (`src/types.ts`). See step 01 for the
// rationale: buffered/atomic-read returns and blocking returns survived the
// builder-chain removal because they are observable through ordinary
// `await`, but they have no `.resolve(ctx)`, `.retry`, or any other builder
// method.
// =============================================================================

declare const atomicResultBrand: unique symbol;
declare const blockingResultBrand: unique symbol;

/**
 * @internal
 *
 * Directly awaitable result for buffered operations and awaitable reads
 * (`channels.X.receiveNowait`, `patch`, `streams.X.write`, `events.X.set`,
 * etc.). Resolves immediately; carries no scheduling brand.
 */
export interface AtomicResult<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [atomicResultBrand]: true;

  then<TResult = T>(
    onfulfilled?:
      | ((value: T) => TResult | PromiseLike<TResult>)
      | null
      | undefined,
  ): AtomicResult<TResult>;

  /**
   * Await-compatibility signature used by TypeScript's `Awaited<T>` extraction.
   */
  then(onfulfilled: (value: T, ...args: any[]) => any): any;
}

/**
 * @internal
 *
 * Directly awaitable result for awaitable waits (`ctx.sleep`,
 * `ctx.sleepUntil`, `channels.X.receive`). Suspends the body until the
 * underlying primitive resolves.
 */
export interface BlockingResult<T> extends AtomicResult<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [blockingResultBrand]: true;
}
