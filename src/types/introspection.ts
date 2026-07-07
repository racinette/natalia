import type { OperatorSession } from "./session";
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
//   - `.get(id)`              synchronous identity grounding; returns a handle
//                             without I/O.
//   - `find(session, query?, opts?)`   predicate-based query; resolves to
//                             `Promise<readonly Handle[]>`. Omit the predicate
//                             to query the full scoped set.
//   - `count(session, query?, opts?)`  aggregate count over the same predicate.
//
// Row materialization on a grounded handle uses {@link FetchableHandle.fetchRow},
// which returns `TRow | undefined`. Query prefetch attaches `.row` on handles
// returned from `find` when `{ fields }` is supplied.
// =============================================================================

// =============================================================================
// FIND RESULT
// =============================================================================

/**
 * Result of {@link QueryableNamespace.find} — a promise that materialises the
 * matching set (bounded by `limit` when set).
 *
 * Callers bound large scans with `limit` (and sort); pagination beyond that
 * is caller-owned.
 */
export type FindResult<T> = Promise<readonly T[]>;

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
 * Handle returned by {@link QueryableNamespace.find} when `{ fields }` prefetches
 * columns. The handle has the base methods plus a typed `.row` snapshot.
 */
export type HandleWithRow<H, TRow> = H & { readonly row: TRow };

/**
 * Option bag for {@link FetchableHandle.fetchRow}. Omit `fields` to fetch the
 * entire row; set `fields` to project columns.
 */
export interface FetchRowOptions<TRow> {
  readonly fields?: FieldsMask<TRow>;
}

/**
 * Option bag for {@link QueryableNamespace.find}. Adds sort and limit.
 */
export interface FindOptions<
  TWhereTemplate extends WhereTemplateRecord,
> {
  readonly sort?: readonly SearchSort<TWhereTemplate>[];
  readonly limit?: number;
}

/** Option bag for {@link QueryableNamespace.count}. */
export type CountOptions = Record<string, never>;

/**
 * A handle that can re-fetch its row on demand.
 *
 * `.fetchRow()` is always a fresh database read; it never consults a
 * prefetched `.row` snapshot, and it does not mutate `.row`. A handle
 * obtained via a `fields`-prefetched query carries `.row: Pick<TRow, ...>`
 * at query time; subsequent `.fetchRow()` calls return a fresh snapshot.
 *
 * Returns `undefined` when no row exists for this handle's grounded identity.
 */
export interface FetchableHandle<TRow> {
  fetchRow<TRaw, F extends FieldsMask<TRow>>(
    session: OperatorSession<TRaw>,
    opts: FetchRowOptions<TRow> & { readonly fields: F },
  ): Promise<Pick<TRow, ProjectedKeys<TRow, F>> | undefined>;
  fetchRow<TRaw>(
    session: OperatorSession<TRaw>,
    opts?: FetchRowOptions<TRow>,
  ): Promise<TRow | undefined>;
}

// =============================================================================
// QUERYABLE NAMESPACE — uniform shape across every introspection surface.
// =============================================================================

/**
 * Predicate callback type for `find` / `count`.
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
 * @typeParam THandle        - The handle type returned by `.get` / `find`.
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
   * or through {@link find} with a `fields` prefetch.
   */
  get(id: TId): THandle;

  /**
   * Predicate-based lookup. Returns zero or more handles matching the query
   * within the namespace scope. Omit the predicate to query the full scoped set.
   */
  find<TRaw>(
    session: OperatorSession<TRaw>,
    query: QueryPredicate<TWhereTemplate>,
    opts?: FindOptions<TWhereTemplate>,
  ): FindResult<THandle>;
  find<TRaw, F extends FieldsMask<TRow>>(
    session: OperatorSession<TRaw>,
    query: QueryPredicate<TWhereTemplate>,
    opts: FindOptions<TWhereTemplate> & { readonly fields: F },
  ): FindResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>;
  find<TRaw>(
    session: OperatorSession<TRaw>,
    opts?: FindOptions<TWhereTemplate>,
  ): FindResult<THandle>;
  find<TRaw, F extends FieldsMask<TRow>>(
    session: OperatorSession<TRaw>,
    opts: FindOptions<TWhereTemplate> & { readonly fields: F },
  ): FindResult<HandleWithRow<THandle, Pick<TRow, ProjectedKeys<TRow, F>>>>;

  /** Aggregate count over the same predicate (or the full scoped set). */
  count<TRaw>(
    session: OperatorSession<TRaw>,
    query: QueryPredicate<TWhereTemplate>,
  ): Promise<number>;
  count<TRaw>(
    session: OperatorSession<TRaw>,
    opts?: CountOptions,
  ): Promise<number>;
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
// Same query verbs as {@link QueryableNamespace}, but `find` / `get`
// materialize plain rows because handler callbacks are the mutation boundary
// and observations are immutable for the duration of the callback.
// =============================================================================

/** Option bag for handler-runtime attempt queries (no session). */
export interface HandlerAttemptFindOptions<
  TWhereTemplate extends WhereTemplateRecord = WhereTemplateRecord,
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
  get(attemptNumber: number): Promise<TRow | undefined>;
  get<F extends FieldsMask<TRow>>(
    attemptNumber: number,
    fields: F,
  ): Promise<Pick<TRow, ProjectedKeys<TRow, F>> | undefined>;

  find(
    query: QueryPredicate<TRow>,
    opts?: HandlerAttemptFindOptions<TRow>,
  ): FindResult<TRow>;
  find<F extends FieldsMask<TRow>>(
    query: QueryPredicate<TRow>,
    opts: HandlerAttemptFindOptions<TRow> & { readonly fields: F },
  ): FindResult<Pick<TRow, ProjectedKeys<TRow, F>>>;
  find(
    opts?: HandlerAttemptFindOptions<TRow>,
  ): FindResult<TRow>;
  find<F extends FieldsMask<TRow>>(
    opts: HandlerAttemptFindOptions<TRow> & { readonly fields: F },
  ): FindResult<Pick<TRow, ProjectedKeys<TRow, F>>>;

  count(query: QueryPredicate<TRow>): Promise<number>;
  count(opts?: HandlerAttemptFindOptions<TRow>): Promise<number>;
}
