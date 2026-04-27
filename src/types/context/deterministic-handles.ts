

// =============================================================================
// ROOT SCOPE BRANDING
// =============================================================================

declare const executionRoot: unique symbol;
declare const compensationRoot: unique symbol;

/**
 * Discriminates whether a deterministic handle was created inside a workflow
 * execution context or a compensation context.
 *
 * Handles carrying `typeof executionRoot` may only be joined from
 * `WorkflowContext` / `WorkflowConcurrencyContext`.
 * Handles carrying `typeof compensationRoot` may only be joined from
 * `CompensationContext` / `CompensationConcurrencyContext`.
 */
export type RootScope = typeof executionRoot | typeof compensationRoot;

/** @internal Used as the `TRoot` type parameter on execution-context handles. */
export type ExecutionRoot = typeof executionRoot;

/** @internal Used as the `TRoot` type parameter on compensation-context handles. */
export type CompensationRoot = typeof compensationRoot;

declare const durableHandleBrand: unique symbol;
export declare const rootScopeBrand: unique symbol;
declare const phantomValueType: unique symbol;

/**
 * Opaque handle to a deterministic workflow primitive.
 *
 * Not directly awaitable — must be resolved via `handle.resolve(ctx)` or `ctx.join(handle)`.
 * This intentionally excludes native Promise values from structural assignment
 * unless they are explicitly wrapped/typed by the engine as deterministic.
 *
 * @typeParam T    - The resolved value type.
 * @typeParam TRoot - Which root context created this handle
 *                   (`ExecutionRoot` or `CompensationRoot`).
 *                   Defaults to the widened `RootScope` for constraint positions.
 */
// =============================================================================
// RESOLVER MARKER INTERFACES
// =============================================================================

declare const executionResolverBrand: unique symbol;
declare const compensationResolverBrand: unique symbol;

/**
 * Marker interface satisfied by all execution-phase contexts
 * (`WorkflowContext`, `WorkflowConcurrencyContext`).
 *
 * Used as the parameter type for `DurableHandle<T, ExecutionRoot>.resolve()`,
 * allowing the handle to check that it is being resolved from the correct context
 * without creating a circular import between this file and itself.
 */
export interface ExecutionResolver {
  /** @internal Brand — do not access at runtime. */
  readonly [executionResolverBrand]: true;
}

/**
 * Marker interface satisfied by all compensation-phase contexts
 * (`CompensationContext`, `CompensationConcurrencyContext`).
 *
 * Used as the parameter type for `DurableHandle<T, CompensationRoot>.resolve()`.
 */
export interface CompensationResolver {
  /** @internal Brand — do not access at runtime. */
  readonly [compensationResolverBrand]: true;
}

export interface DurableHandle<T, TRoot extends RootScope = RootScope> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [durableHandleBrand]: true;
  /** @internal Root context discriminator — do not access at runtime. */
  readonly [rootScopeBrand]: TRoot;
  /**
   * @internal Covariant phantom field — allows TypeScript to infer `T` via
   * `H extends DurableHandle<infer T, ...>` in conditional types.
   * Optional so it never appears in required field checks.
   * Do not access at runtime.
   */
  readonly [phantomValueType]?: T;

  /**
   * Resolve this handle against its originating context.
   *
   * Replaces the former `ctx.execute(handle)` pattern — instead of passing the handle into the
   * context, pass the context into the handle. The result is an `AtomicResult<T>`
   * which can be directly `await`-ed but is not a native `Promise` and cannot
   * be accidentally passed into `Promise.all` or other JS concurrency primitives.
   *
   * The `ctx` parameter is type-checked at compile time: an `ExecutionRoot`
   * handle requires an `ExecutionResolver` (satisfied by `WorkflowContext` and
   * `WorkflowConcurrencyContext`), and a `CompensationRoot` handle requires a
   * `CompensationResolver` (satisfied by `CompensationContext` and
   * `CompensationConcurrencyContext`). Passing the wrong context type is a
   * compile error.
   *
   * @example
   * ```typescript
   * const flight = await ctx.steps.bookFlight(dest, id)
   *   .compensate(async (ctx) => { ... })
   *   .resolve(ctx);
   *
   * const result = await ctx.scope("Name", entries, callback).resolve(ctx);
   * ```
   */
  resolve(
    ctx: TRoot extends ExecutionRoot ? ExecutionResolver : CompensationResolver,
  ): AtomicResult<T>;
}

declare const atomicResultBrand: unique symbol;
declare const blockingResultBrand: unique symbol;

/**
 * Directly awaitable deterministic workflow primitive.
 *
 * Represents atomic (synchronous-at-engine-level) operations such as
 * `ctx.streams.X.write()`, `ctx.events.X.set()`, `ctx.patches.X`,
 * `channels.send()`, and `receiveNowait()`.
 *
 * These operations are directly awaitable with `await` but are NOT valid
 * scope entries (they complete atomically and do not represent ongoing
 * concurrent work).
 *
 * @typeParam T - The resolved value type.
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
   * Keep this overload broad and LAST so normal `.then(...)` calls still
   * resolve to the strongly typed generic overload above.
   */
  then(onfulfilled: (value: T, ...args: any[]) => any): any;
}

/**
 * Directly awaitable blocking workflow primitive.
 *
 * Extends `AtomicResult<T>` with a scope-entry brand, making it valid
 * as a `ctx.scope()` / `ctx.all()` entry in addition to being directly
 * awaitable.
 *
 * Used for blocking operations that represent ongoing concurrent work:
 * `ctx.sleep()`, `ctx.sleepUntil()`, and `ctx.channels.X.receive(...)`.
 *
 * @typeParam T - The resolved value type.
 */
export interface BlockingResult<T> extends AtomicResult<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [blockingResultBrand]: true;
}
