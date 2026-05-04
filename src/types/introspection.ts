import type {
  IWorkflowConnection,
  IWorkflowTransaction,
} from "./results";
import type {
  SearchNamespaceRecord,
  SearchQueryNode,
  SearchSort,
} from "./search-query";

// =============================================================================
// INTROSPECTION TYPES — UNIFIED QUERY SURFACE
//
// Every operator-facing namespace in the public API shares the same shape
// (`REFACTOR.MD` Part 5 §"Search and introspection — unified shape"):
//
//   - `.get(id)`                     synchronous direct-access; constructs a
//                                    handle without I/O. Cardinality is
//                                    surfaced lazily through the handle's
//                                    methods.
//   - `findUnique(query, opts?)`     predicate-based; asserts cardinality at
//                                    fetch time; resolves to
//                                    `FindUniqueResult<Handle>`.
//   - `findMany(query, opts?)`       predicate-based; resolves to a
//                                    `FindManyResult<Handle>` that is BOTH
//                                    awaitable (materialises a `Handle[]`)
//                                    AND async-iterable (streams handles
//                                    lazily, paginating internally).
//   - `count(query, opts?)`           aggregate count over the same predicate.
//
// Step 09 introduced the operator-action verb signatures
// (`WorkflowOperatorActions<TResult>`,
// `CompensationBlockOperatorActions<TResult>`); step 12 plugs them onto
// the concrete handles. Step 19 firms up
// `IWorkflowConnection`/`IWorkflowTransaction` constructors; step 12
// wires `txOrConn?` onto every IO option bag.
// =============================================================================

// =============================================================================
// FIND RESULTS
// =============================================================================

/**
 * Cardinality-asserting wrapper for `findUnique` and per-instance reads.
 */
export type FindUniqueResult<T> =
  | { readonly status: "unique"; readonly value: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly count: number };

/**
 * Result of `findMany`. Both awaitable (materialises the full array) and
 * async-iterable (streams handles lazily with internal pagination).
 *
 * Awaiting:    `const handles = await ns.findMany(query)`
 * Iterating:   `for await (const handle of ns.findMany(query)) { ... }`
 */
export interface FindManyResult<T>
  extends PromiseLike<readonly T[]>,
    AsyncIterable<T> {}

// =============================================================================
// FETCHABLE HANDLE — fetchRow + optional row prefetch.
// =============================================================================

/**
 * Field projection mask. Only the keys explicitly set to `true` are read.
 *
 * `{ status: true, args: true }` projects `{ status, args }`.
 */
export type FieldsMask<TRow> = {
  readonly [K in keyof TRow]?: true;
};

/**
 * Resolve a `FieldsMask<TRow>` to the set of projected keys (the keys whose
 * mask value is `true`).
 */
export type ProjectedKeys<TRow, F extends FieldsMask<TRow>> = Extract<
  {
    [K in keyof F]: F[K] extends true ? K : never;
  }[keyof F],
  keyof TRow
>;

/**
 * Handle returned by a query method that prefetched a `fields` mask. The
 * handle has the base methods plus a typed `.row` snapshot.
 */
export type HandleWithRow<H, TRow> = H & { readonly row: TRow };

/**
 * Common option bag for fetchRow / findUnique / count and other one-shot IO
 * methods on a fetchable handle. Per `REFACTOR.MD` Part 19 every IO method
 * accepts an optional `txOrConn?`.
 */
export interface FetchOptions {
  readonly txOrConn?: IWorkflowConnection | IWorkflowTransaction;
}

/**
 * Common option bag for findMany. Adds sort and limit to the IO options.
 */
export interface FindManyOptions<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> {
  readonly sort?: readonly SearchSort<TNamespaces>[];
  readonly limit?: number;
  readonly txOrConn?: IWorkflowConnection | IWorkflowTransaction;
}

/**
 * `count` accepts the same `txOrConn?` IO option as the other one-shot
 * methods.
 */
export interface CountOptions extends FetchOptions {}

/**
 * `findUnique` accepts the same `txOrConn?` IO option as the other one-shot
 * methods.
 */
export interface FindUniqueOptions extends FetchOptions {}

/**
 * A handle that can re-fetch its row on demand.
 *
 * `.fetchRow()` is always a fresh database read; it never consults a
 * prefetched `.row` snapshot, and it does not mutate `.row`. A handle
 * obtained via a `fields`-prefetched query carries `.row: Pick<TRow, ...>`
 * at query time; subsequent `.fetchRow()` calls return a fresh snapshot.
 */
export interface FetchableHandle<TRow> {
  fetchRow(opts?: FetchOptions): Promise<FindUniqueResult<TRow>>;
  fetchRow<F extends FieldsMask<TRow>>(
    fields: F,
    opts?: FetchOptions,
  ): Promise<FindUniqueResult<Pick<TRow, ProjectedKeys<TRow, F>>>>;
}

// =============================================================================
// QUERYABLE NAMESPACE — uniform shape across every introspection surface.
// =============================================================================

/**
 * Predicate callback type for `findUnique` / `findMany` / `count`.
 *
 * The callback receives a `SearchQueryBuilder<TNamespaces>` (step 11). Its
 * return value is a `SearchQueryNode<TNamespaces>` (the AST). Step 11's
 * builder shape is parameterised by the same `TNamespaces` map, so the
 * predicate is fully typed against the entity's namespace surface.
 */
export type QueryPredicate<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> = (q: import("./search-query").SearchQueryBuilder<TNamespaces>) =>
  SearchQueryNode<TNamespaces>;

/**
 * Unified queryable namespace shape.
 *
 * @typeParam THandle        - The handle type returned by `.get` /
 *                             `findUnique` / `findMany`.
 * @typeParam TNamespaces    - The query namespace map driving predicates.
 *                             Step 11 shapes this as a record of row /
 *                             metadata namespaces.
 * @typeParam TRow           - The flat-row shape for `fetchRow` / prefetch.
 * @typeParam TId            - Branded id for `.get(id)`. Use `never` to
 *                             disable the identity-based path (e.g.
 *                             `client.workflows.X` uses dedicated
 *                             `idempotencyKey` / `args` overloads instead).
 */
export interface QueryableNamespace<
  THandle,
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TRow,
  TId,
> {
  /**
   * Identity-based, query-grounding direct access. Returns a handle
   * synchronously; cardinality / existence is reflected lazily in the
   * handle methods' `FindUniqueResult` returns.
   */
  get(id: TId): THandle;
  get<F extends FieldsMask<TRow>>(
    id: TId,
    fields: F,
  ): HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>;

  /**
   * Predicate-based lookup that asserts cardinality at fetch time.
   */
  findUnique(
    query: QueryPredicate<TNamespaces>,
    opts?: FindUniqueOptions,
  ): Promise<FindUniqueResult<THandle>>;
  findUnique<F extends FieldsMask<TRow>>(
    query: QueryPredicate<TNamespaces>,
    opts: FindUniqueOptions & { fields: F },
  ): Promise<
    FindUniqueResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>
  >;

  /**
   * Predicate-based lookup that may yield zero or more handles. Awaitable
   * AND async-iterable.
   */
  findMany(
    query: QueryPredicate<TNamespaces>,
    opts?: FindManyOptions<TNamespaces>,
  ): FindManyResult<THandle>;
  findMany<F extends FieldsMask<TRow>>(
    query: QueryPredicate<TNamespaces>,
    opts: FindManyOptions<TNamespaces> & { fields: F },
  ): FindManyResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>;

  /** Aggregate count over the same predicate. */
  count(
    query: QueryPredicate<TNamespaces>,
    opts?: CountOptions,
  ): Promise<number>;
}
