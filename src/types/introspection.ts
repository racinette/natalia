import type {
  IWorkflowConnection,
  IWorkflowTransaction,
} from "./results";
import type {
  SearchSort,
  WhereFn,
  WhereTemplateRecord,
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
//   - `findUnique(query?, opts?)`    predicate-based; asserts cardinality at
//                                    fetch time; resolves to
//                                    `FindUniqueResult<Handle>`. Omit the
//                                    predicate to query the full scoped set.
//   - `findMany(query?, opts?)`      predicate-based; resolves to
//                                    `Promise<readonly Handle[]>`. Omit the
//                                    predicate to query the full scoped set.
//   - `count(query?, opts?)`         aggregate count over the same predicate.
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
 * Result of `findMany` — a promise that materialises the full matching set.
 *
 * Callers bound large scans with `limit` (and sort); pagination beyond that
 * is caller-owned.
 */
export type FindManyResult<T> = Promise<readonly T[]>;

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
 * Common option bag for findUnique / count and other one-shot IO methods
 * on a fetchable handle. Per `REFACTOR.MD` Part 19 every IO method accepts
 * an optional `txOrConn?`.
 */
export interface FetchOptions {
  readonly txOrConn?: IWorkflowConnection | IWorkflowTransaction;
}

/**
 * Option bag for {@link FetchableHandle.fetchRow}. Omit `fields` to fetch the
 * entire row; set `fields` to project columns. Shares `txOrConn?` with other
 * IO methods.
 */
export interface FetchRowOptions<TRow> extends FetchOptions {
  readonly fields?: FieldsMask<TRow>;
}

/**
 * Common option bag for findMany. Adds sort and limit to the IO options.
 */
export interface FindManyOptions<
  TWhereTemplate extends WhereTemplateRecord,
> {
  readonly sort?: readonly SearchSort<TWhereTemplate>[];
  readonly limit?: number;
  readonly txOrConn?: IWorkflowConnection | IWorkflowTransaction;
}

/**
 * `count` accepts the same `txOrConn?` IO option as the other one-shot
 * methods.
 */
export type CountOptions = FetchOptions;

/**
 * `findUnique` accepts the same `txOrConn?` IO option as the other one-shot
 * methods.
 */
export type FindUniqueOptions = FetchOptions;

/**
 * A handle that can re-fetch its row on demand.
 *
 * `.fetchRow()` is always a fresh database read; it never consults a
 * prefetched `.row` snapshot, and it does not mutate `.row`. A handle
 * obtained via a `fields`-prefetched query carries `.row: Pick<TRow, ...>`
 * at query time; subsequent `.fetchRow()` calls return a fresh snapshot.
 */
export interface FetchableHandle<TRow> {
  fetchRow<F extends FieldsMask<TRow>>(
    opts: FetchRowOptions<TRow> & { readonly fields: F },
  ): Promise<FindUniqueResult<Pick<TRow, ProjectedKeys<TRow, F>>>>;
  fetchRow(opts?: FetchRowOptions<TRow>): Promise<FindUniqueResult<TRow>>;
}

// =============================================================================
// QUERYABLE NAMESPACE — uniform shape across every introspection surface.
// =============================================================================

/**
 * Predicate callback type for `findUnique` / `findMany` / `count`.
 *
 * The callback receives a `WhereScope<TWhereTemplate>` (destructure-friendly).
 * Its return value is an opaque `Predicate` assembled through `natalia/search`
 * combinators (`and`, `eq`, `gt`, `every`, `some`, …), or literal `true` for
 * an unconditional match within the namespace scope (`WHERE TRUE`).
 */
export type QueryPredicate<
  TWhereTemplate extends WhereTemplateRecord,
> = WhereFn<TWhereTemplate>;

/**
 * Unified queryable namespace shape.
 *
 * @typeParam THandle        - The handle type returned by `.get` /
 *                             `findUnique` / `findMany`.
 * @typeParam TWhereTemplate - The single row-shaped template driving
 *                             predicates and sorting.
 * @typeParam TRow           - The flat-row shape for `fetchRow` / prefetch.
 * @typeParam TId            - Branded id for `.get(id)`. Use `never` to
 *                             disable the identity-based path (e.g.
 *                             `client.workflows.X` uses dedicated
 *                             `idempotencyKey` / `args` overloads instead).
 */
export interface QueryableNamespace<
  THandle,
  TWhereTemplate extends WhereTemplateRecord,
  TRow,
  TId,
> {
  /**
   * Identity-based handle construction. Synchronous and query-grounding only —
   * no I/O, no row materialization. Read row data via {@link FetchableHandle.fetchRow}
   * or through {@link findUnique} / {@link findMany} with a `fields` prefetch.
   */
  get(id: TId): THandle;

  /**
   * Predicate-based lookup that asserts cardinality at fetch time. Omit the
   * predicate when the scoped set is expected to contain at most one row.
   */
  findUnique(
    query: QueryPredicate<TWhereTemplate>,
    opts?: FindUniqueOptions,
  ): Promise<FindUniqueResult<THandle>>;
  findUnique<F extends FieldsMask<TRow>>(
    query: QueryPredicate<TWhereTemplate>,
    opts: FindUniqueOptions & { readonly fields: F },
  ): Promise<
    FindUniqueResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>
  >;
  findUnique(
    opts?: FindUniqueOptions,
  ): Promise<FindUniqueResult<THandle>>;
  findUnique<F extends FieldsMask<TRow>>(
    opts: FindUniqueOptions & { readonly fields: F },
  ): Promise<
    FindUniqueResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>
  >;

  /**
   * Predicate-based lookup that may yield zero or more handles. Omit the
   * predicate to return every row in the namespace scope.
   */
  findMany(
    query: QueryPredicate<TWhereTemplate>,
    opts?: FindManyOptions<TWhereTemplate>,
  ): FindManyResult<THandle>;
  findMany<F extends FieldsMask<TRow>>(
    query: QueryPredicate<TWhereTemplate>,
    opts: FindManyOptions<TWhereTemplate> & { readonly fields: F },
  ): FindManyResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>;
  findMany(
    opts?: FindManyOptions<TWhereTemplate>,
  ): FindManyResult<THandle>;
  findMany<F extends FieldsMask<TRow>>(
    opts: FindManyOptions<TWhereTemplate> & { readonly fields: F },
  ): FindManyResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>;

  /** Aggregate count over the same predicate (or the full scoped set). */
  count(
    query: QueryPredicate<TWhereTemplate>,
    opts?: CountOptions,
  ): Promise<number>;
  count(opts?: CountOptions): Promise<number>;
}

// =============================================================================
// READ-ONLY ENTITY HANDLE — operator child rows (attempts, halts, …).
// =============================================================================

/**
 * Handle grounded by a numeric row key within a parent scope. Read-only
 * today (`fetchRow` only); reserved for future operator verbs.
 */
export interface EntityHandle<TRow, TId = number> extends FetchableHandle<TRow> {
  readonly id: TId;
}

/** Operator-facing handle for a single attempt log row (parent-scoped). */
export type AttemptHandle<TRow> = EntityHandle<TRow, number>;

/** Operator-facing handle for a single halt row (workflow-scoped). */
export type HaltHandle = EntityHandle<
  import("./results").HaltRecord,
  number
>;

/**
 * Parent-scoped attempt namespace on operator handles. Queries return
 * {@link AttemptHandle} instances; project columns via `fields` and read
 * `handle.row.*` or call `handle.fetchRow(...)`.
 */
export type OperatorAttemptsNamespaceExternal<
  TRow extends WhereTemplateRecord,
> = QueryableNamespace<AttemptHandle<TRow>, TRow, TRow, number>;

// =============================================================================
// HANDLER-RUNTIME ATTEMPT READ NAMESPACE — row materialization (no handles).
//
// Same query verbs as {@link QueryableNamespace}, but `findMany` / `findUnique`
// / `get` materialize plain rows because handler callbacks are the mutation
// boundary and observations are immutable for the duration of the callback.
// =============================================================================

/** Option bag for handler-runtime attempt queries (no `txOrConn`). */
export interface HandlerAttemptFindOptions {}

/** Option bag for handler-runtime `findMany` over attempt rows. */
export interface HandlerAttemptFindManyOptions<
  TWhereTemplate extends WhereTemplateRecord,
> {
  readonly sort?: readonly SearchSort<TWhereTemplate>[];
  readonly limit?: number;
}

/**
 * Parent-scoped attempt namespace injected into handler callbacks
 * (`CompensationInfo.attempts`, `RequestRetentionContext.attempts`, …).
 */
export interface HandlerAttemptsReadNamespace<
  TRow extends WhereTemplateRecord,
> {
  get(attemptNumber: number): Promise<FindUniqueResult<TRow>>;
  get<F extends FieldsMask<TRow>>(
    attemptNumber: number,
    fields: F,
  ): Promise<FindUniqueResult<Pick<TRow, ProjectedKeys<TRow, F>>>>;

  findUnique(
    query: QueryPredicate<TRow>,
    opts?: HandlerAttemptFindOptions,
  ): Promise<FindUniqueResult<TRow>>;
  findUnique<F extends FieldsMask<TRow>>(
    query: QueryPredicate<TRow>,
    opts: { readonly fields: F },
  ): Promise<FindUniqueResult<Pick<TRow, ProjectedKeys<TRow, F>>>>;
  findUnique(
    opts?: HandlerAttemptFindOptions,
  ): Promise<FindUniqueResult<TRow>>;
  findUnique<F extends FieldsMask<TRow>>(
    opts: { readonly fields: F },
  ): Promise<FindUniqueResult<Pick<TRow, ProjectedKeys<TRow, F>>>>;

  findMany(
    query: QueryPredicate<TRow>,
    opts?: HandlerAttemptFindManyOptions<TRow>,
  ): FindManyResult<TRow>;
  findMany<F extends FieldsMask<TRow>>(
    query: QueryPredicate<TRow>,
    opts: HandlerAttemptFindManyOptions<TRow> & { readonly fields: F },
  ): FindManyResult<Pick<TRow, ProjectedKeys<TRow, F>>>;
  findMany(
    opts?: HandlerAttemptFindManyOptions<TRow>,
  ): FindManyResult<TRow>;
  findMany<F extends FieldsMask<TRow>>(
    opts: HandlerAttemptFindManyOptions<TRow> & { readonly fields: F },
  ): FindManyResult<Pick<TRow, ProjectedKeys<TRow, F>>>;

  count(
    query: QueryPredicate<TRow>,
    opts?: HandlerAttemptFindOptions,
  ): Promise<number>;
  count(opts?: HandlerAttemptFindOptions): Promise<number>;
}
